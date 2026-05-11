"""
Helix backend — FastAPI.

Endpoints:
    POST /api/missions             Start a new mission (background task).
    GET  /api/missions             List recent missions.
    GET  /api/missions/{id}        Full mission state.
    GET  /api/missions/{id}/stream Server-Sent Events of mission events
                                   (polls Mongo agent_runs.events).
    GET  /api/memory               Recent operational memory docs.
    GET  /api/health               Healthcheck.

Frontend connects to /stream and renders events into the Mission Control
timeline as they arrive.
"""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
import time
import sys
from pathlib import Path

from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pymongo import MongoClient
from sse_starlette.sse import EventSourceResponse

# ── repo root so we can import agent.* ───────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")


# ── GCP creds bootstrap ──────────────────────────────────────────────────────
# In prod (Railway) we inject the service-account JSON as an env var.
# Materialize it to a temp file and point GOOGLE_APPLICATION_CREDENTIALS at it
# so google-genai / vertex SDKs pick it up via ADC.
def _bootstrap_gcp_credentials() -> None:
    raw = os.environ.get("GCP_SERVICE_ACCOUNT_JSON")
    if not raw:
        # Local dev: GOOGLE_APPLICATION_CREDENTIALS already points to ./secrets/...
        return
    try:
        creds = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"GCP_SERVICE_ACCOUNT_JSON is not valid JSON: {e}") from e
    fd, path = tempfile.mkstemp(suffix=".json", prefix="gcp-helix-")
    with os.fdopen(fd, "w") as f:
        json.dump(creds, f)
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = path
    if "project_id" in creds and not os.environ.get("GOOGLE_CLOUD_PROJECT"):
        os.environ["GOOGLE_CLOUD_PROJECT"] = creds["project_id"]


_bootstrap_gcp_credentials()

from agent.mission import run_mission  # noqa: E402

# ── app ──────────────────────────────────────────────────────────────────────
app = FastAPI(title="Helix API", version="0.1.0")


def _parse_origins(value: str | None) -> list[str]:
    if not value:
        return ["http://localhost:3000"]
    return [o.strip() for o in value.split(",") if o.strip()]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_parse_origins(os.environ.get("FRONTEND_ORIGIN")),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _db():
    return MongoClient(os.environ["MONGODB_URI"])[os.environ["MONGODB_DB"]]


# ── models ──────────────────────────────────────────────────────────────────
class StartMissionRequest(BaseModel):
    brief: str


class StartMissionResponse(BaseModel):
    mission_id: str


# ── endpoints ───────────────────────────────────────────────────────────────
@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "service": "helix-backend",
        "model": os.environ.get("GEMINI_MODEL", "unknown"),
    }


@app.post("/api/missions", response_model=StartMissionResponse)
def start_mission(
    req: StartMissionRequest, background: BackgroundTasks
) -> StartMissionResponse:
    mission_id = f"run_{int(time.time() * 1000)}"
    background.add_task(run_mission, product_brief=req.brief, mission_id=mission_id)
    return StartMissionResponse(mission_id=mission_id)


@app.get("/api/missions")
def list_missions(limit: int = 20) -> list[dict]:
    docs = list(
        _db()["agent_runs"]
        .find({}, {"events": 0})
        .sort("started_at", -1)
        .limit(limit)
    )
    for d in docs:
        d["_id"] = str(d["_id"])
    return docs


@app.get("/api/missions/{mission_id}")
def get_mission(mission_id: str) -> dict:
    doc = _db()["agent_runs"].find_one({"_id": mission_id})
    if not doc:
        raise HTTPException(status_code=404, detail="mission not found")
    doc["_id"] = str(doc["_id"])
    return doc


# SSE response headers that defeat upstream proxy buffering on Railway/Vercel.
_SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


@app.get("/api/missions/{mission_id}/stream")
async def stream_mission(mission_id: str):
    """SSE that tails agent_runs.{id}.events.

    Polls Mongo every 100ms for new events. Closes when status == 'complete'.
    sse-starlette's ping= keeps the connection warm through idle proxies.
    """

    async def generator():
        coll = _db()["agent_runs"]
        last_count = 0
        deadline = time.time() + 600  # 10 min hard cap

        while time.time() < deadline:
            doc = coll.find_one({"_id": mission_id})
            if doc is None:
                yield {"event": "missing", "data": "mission not found"}
                await asyncio.sleep(0.5)
                continue

            events = doc.get("events", [])
            for ev in events[last_count:]:
                ev_out = {
                    "kind": ev.get("kind"),
                    "payload": ev.get("payload"),
                    "at": ev.get("at").isoformat() if ev.get("at") else None,
                }
                yield {"event": ev_out["kind"], "data": _json(ev_out)}
            last_count = len(events)

            if doc.get("status") == "complete":
                yield {"event": "done", "data": _json({"mission_id": mission_id})}
                return

            await asyncio.sleep(0.1)

        yield {"event": "timeout", "data": "stream timeout"}

    # ping=15 sends a comment heartbeat every 15s during idle waits, keeping
    # proxies (Railway, Cloudflare, etc.) from closing the connection.
    return EventSourceResponse(generator(), headers=_SSE_HEADERS, ping=15)


@app.get("/api/memory")
def list_memory(limit: int = 20) -> list[dict]:
    docs = list(
        _db()["listings_memory"]
        .find({}, {"embedding": 0})
        .sort("launched_at", -1)
        .limit(limit)
    )
    for d in docs:
        d["_id"] = str(d["_id"])
    return docs


# ── helpers ─────────────────────────────────────────────────────────────────
def _json(obj) -> str:
    return json.dumps(obj, default=str)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "backend.main:app",
        host=os.environ.get("BACKEND_HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", os.environ.get("BACKEND_PORT", "8000"))),
        reload=False,
    )
