"""
Helix agent — single-mission loop with incremental event emission.

Every event (mission_start, reasoning, tool_call, tool_result, mission_complete)
is appended to MongoDB agent_runs.{id}.events as it happens. A separate SSE
endpoint tails that document so the UI can stream the agent's reasoning live.

The mission itself remains a tight Gemini function-calling loop.
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from typing import Any, Callable

from google import genai
from google.genai import types
from pymongo import MongoClient

from . import tools


SYSTEM_INSTRUCTION = """\
You are Helix, an autonomous commerce operations agent.

You operate a Shopify store as a thoughtful operator, not as a generic
listing generator. You have persistent operational memory of past launches
and you reason from that memory rather than from generic priors.

CRITICAL — narrate every step. Before EVERY tool call, output 1-3 short
sentences explaining what you are about to do and why. After receiving tool
results, output 1-3 sentences interpreting what you found before deciding
the next action. The reasoning trace IS the product — without it, the user
cannot see the agent operating.

For every launch mission, follow this order:
  1. Briefly state the mission and call recall_similar_launches with a short
     description of the product.
  2. Interpret the retrieved launches out loud. Identify which past attempts
     succeeded, which failed, and what pattern that reveals. Past failures
     matter as much as past successes — they show what NOT to do.
  3. State your pricing and positioning decision in 2-3 sentences. Cite the
     past launches that informed each choice by name.
  4. Call publish_to_shopify with a polished title, HTML description, price,
     and tags.
  5. Announce that the draft is live and call save_mission_outcome to
     consolidate this launch into operational memory.
  6. Close with a 1-sentence mission summary.

Hard rules:
  - Never invent past launches that weren't returned by recall_similar_launches.
  - If the retrieved memory shows a price tier failed, do not repeat that price.
  - Keep titles under 70 characters.
  - Always publish as draft.
  - One mission per run. Do not loop.
  - Always narrate before acting. Silent tool calls hide the reasoning.
"""

EventEmitter = Callable[[str, dict[str, Any]], None]


def _tool_table() -> dict[str, callable]:
    return {
        "recall_similar_launches": tools.recall_similar_launches,
        "publish_to_shopify": tools.publish_to_shopify,
        "save_mission_outcome": tools.save_mission_outcome,
    }


def _function_declarations(client: genai.Client) -> list[types.Tool]:
    decls = [
        types.FunctionDeclaration.from_callable(callable=fn, client=client)
        for fn in _tool_table().values()
    ]
    return [types.Tool(function_declarations=decls)]


def _build_emitter(mission_id: str) -> EventEmitter:
    """Returns an emit fn that appends events to Mongo and prints to stdout."""
    mongo = MongoClient(os.environ["MONGODB_URI"])
    coll = mongo[os.environ["MONGODB_DB"]]["agent_runs"]

    def emit(kind: str, payload: dict[str, Any]) -> None:
        event = {
            "kind": kind,
            "payload": payload,
            "at": datetime.now(timezone.utc),
        }
        coll.update_one({"_id": mission_id}, {"$push": {"events": event}}, upsert=True)
        ts = event["at"].strftime("%H:%M:%S")
        preview = (
            payload if isinstance(payload, str) else json.dumps(payload, default=str)[:300]
        )
        print(f"[{ts}] {kind}: {preview}")

    return emit


def run_mission(
    product_brief: str,
    mission_id: str | None = None,
    extra_emit: EventEmitter | None = None,
) -> dict[str, Any]:
    """Execute one launch mission.

    Args:
        product_brief: The user-provided product idea / URL / description.
        mission_id: Optional pre-allocated mission id (useful when an HTTP
            handler wants to return the id before the mission starts).
        extra_emit: Optional secondary emitter (e.g. an in-process queue for
            SSE). The Mongo emitter always runs.
    """
    project = os.environ["GOOGLE_CLOUD_PROJECT"]
    location = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
    model = os.environ.get("GEMINI_MODEL", "gemini-2.5-pro")

    client = genai.Client(vertexai=True, project=project, location=location)
    tool_fns = _tool_table()

    mission_id = mission_id or f"run_{int(time.time())}"
    started_at = datetime.now(timezone.utc)

    mongo_emit = _build_emitter(mission_id)

    def emit(kind: str, payload: dict[str, Any]) -> None:
        mongo_emit(kind, payload)
        if extra_emit is not None:
            try:
                extra_emit(kind, payload)
            except Exception:
                pass

    # seed the mission doc with metadata (events array gets $push'd to it)
    MongoClient(os.environ["MONGODB_URI"])[os.environ["MONGODB_DB"]]["agent_runs"].update_one(
        {"_id": mission_id},
        {
            "$setOnInsert": {
                "brief": product_brief,
                "started_at": started_at,
                "model": model,
                "status": "running",
                "events": [],
            }
        },
        upsert=True,
    )
    emit("mission_start", {"mission_id": mission_id, "brief": product_brief})

    contents: list[types.Content] = [
        types.Content(role="user", parts=[types.Part(text=product_brief)])
    ]
    config = types.GenerateContentConfig(
        system_instruction=SYSTEM_INSTRUCTION,
        tools=_function_declarations(client),
        temperature=0.4,
    )

    final_text = ""
    max_turns = 8

    # streaming throttle params
    EMIT_INTERVAL_S = 0.10
    MIN_DELTA_CHARS = 16

    for turn in range(max_turns):
        block_id = f"reason_{mission_id}_{turn}"
        text_buffer = ""
        function_calls: list[Any] = []
        last_emit_ts = 0.0
        last_emit_len = 0

        stream = client.models.generate_content_stream(
            model=model, contents=contents, config=config
        )
        for chunk in stream:
            if not chunk.candidates:
                continue
            cand = chunk.candidates[0]
            if not cand.content or not cand.content.parts:
                continue
            for part in cand.content.parts:
                if part.text:
                    text_buffer += part.text
                    now = time.time()
                    delta_chars = len(text_buffer) - last_emit_len
                    if (now - last_emit_ts >= EMIT_INTERVAL_S) or (
                        delta_chars >= MIN_DELTA_CHARS
                    ):
                        emit(
                            "reasoning_delta",
                            {"block_id": block_id, "turn": turn + 1, "text": text_buffer},
                        )
                        last_emit_ts = now
                        last_emit_len = len(text_buffer)
                if part.function_call:
                    function_calls.append(part.function_call)

        # final delta for the block (ensures the last few chars get out)
        if text_buffer and len(text_buffer) > last_emit_len:
            emit(
                "reasoning_delta",
                {"block_id": block_id, "turn": turn + 1, "text": text_buffer},
            )
        if text_buffer:
            final_text = text_buffer

        # reconstruct canonical model content for the conversation history
        full_parts: list[types.Part] = []
        if text_buffer:
            full_parts.append(types.Part(text=text_buffer))
        for fc in function_calls:
            full_parts.append(types.Part(function_call=fc))
        if full_parts:
            contents.append(types.Content(role="model", parts=full_parts))

        if not function_calls:
            break

        tool_responses: list[types.Part] = []
        for fc in function_calls:
            args = dict(fc.args or {})
            emit("tool_call", {"name": fc.name, "args": args})
            fn = tool_fns.get(fc.name)
            if fn is None:
                result: Any = {"error": f"unknown tool {fc.name}"}
            else:
                try:
                    result = fn(**args)
                except Exception as e:
                    result = {"error": f"{type(e).__name__}: {e}"}
            emit("tool_result", {"name": fc.name, "result": result})
            tool_responses.append(
                types.Part.from_function_response(
                    name=fc.name, response={"result": result}
                )
            )

        contents.append(types.Content(role="user", parts=tool_responses))

    finished_at = datetime.now(timezone.utc)
    MongoClient(os.environ["MONGODB_URI"])[os.environ["MONGODB_DB"]]["agent_runs"].update_one(
        {"_id": mission_id},
        {
            "$set": {
                "finished_at": finished_at,
                "duration_s": (finished_at - started_at).total_seconds(),
                "final_text": final_text,
                "status": "complete",
            }
        },
    )
    emit("mission_complete", {"mission_id": mission_id, "duration_s": (finished_at - started_at).total_seconds()})

    return {"mission_id": mission_id, "final": final_text}
