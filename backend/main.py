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
import os
import time
import sys
from pathlib import Path

from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from pymongo import MongoClient
from sse_starlette.sse import EventSourceResponse

# repo root so we can import agent.*
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

from agent.mission import run_mission  # noqa: E402


app = FastAPI(title="Helix API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.environ.get("FRONTEND_ORIGIN", "http://localhost:3000")],
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
    return {"status": "ok"}


@app.post("/api/missions", response_model=StartMissionResponse)
def start_mission(req: StartMissionRequest, background: BackgroundTasks) -> StartMissionResponse:
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


@app.get("/api/missions/{mission_id}/stream")
async def stream_mission(mission_id: str):
    """SSE that tails agent_runs.{id}.events.

    Polls Mongo every 300ms for new events. Cheaper than change streams and
    perfectly cinematic on this scale. Closes when status == 'complete'.
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
                # convert datetime → iso for JSON
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

    return EventSourceResponse(generator())


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
    import json
    return json.dumps(obj, default=str)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "backend.main:app",
        host=os.environ.get("BACKEND_HOST", "0.0.0.0"),
        port=int(os.environ.get("BACKEND_PORT", "8000")),
        reload=True,
    )
