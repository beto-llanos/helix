<div align="center">

# Helix

### Autonomous Commerce Operations Runtime

*An agent that learns from prior product launches and uses that operational memory during live decisions.*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Gemini 2.5 Pro](https://img.shields.io/badge/Reasoning-Gemini%202.5%20Pro-4285F4.svg)](https://deepmind.google/technologies/gemini/)
[![MongoDB Atlas](https://img.shields.io/badge/Memory-MongoDB%20Atlas%20Vector%20Search-00ED64.svg)](https://www.mongodb.com/atlas)
[![MongoDB MCP](https://img.shields.io/badge/MCP-mongodb--mcp--server-00ED64.svg)](https://github.com/mongodb-js/mongodb-mcp-server)

**Live:** [helix-tau-two.vercel.app](https://helix-tau-two.vercel.app) · **Track:** Google Cloud Rapid Agent Hackathon — MongoDB

</div>

---

## What Helix is

Helix takes a product brief, retrieves similar past launches from MongoDB Atlas Vector Search, reasons through the pricing and positioning decision while citing those prior launches by name, publishes a real draft product to Shopify, and consolidates the new launch back into operational memory.

The point is the second mission, not the first. Every run thickens the memory layer, and every subsequent run cites it. Watch the Mission Control timeline closely — past failures are referenced by name before the agent commits to a new price tier.

## The mission loop

Every Helix run streams these phases live to the UI:

| Phase | What happens | Tool / surface |
|---|---|---|
| **1. Recall** | Vector search over `listings_memory` for ~3 similar prior launches. | `recall_similar_launches` → MongoDB Atlas `$vectorSearch` |
| **2. Reason** | Agent narrates the retrieved pattern, identifies which past attempts succeeded and which failed, decides on price + positioning. | Streaming `reasoning_delta` events via SSE |
| **3. Publish** | Creates a real draft product on the Helix Shopify dev store. | `publish_to_shopify` → Shopify Admin API |
| **4. Consolidate** | Embeds the new launch and upserts it into `listings_memory` so it informs future missions. | `save_mission_outcome` → MongoDB upsert |

Mission events (`mission_start`, `reasoning_delta`, `tool_call`, `tool_result`, `mission_complete`) are appended to `agent_runs.{id}.events` and streamed to the UI over SSE.

## Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│  Next.js 16 (Vercel) — Mission Control                       │
│  Timeline-first UI · streaming reasoning · memory cards      │
│  Memory-reference highlighting · bidirectional hover         │
└──────────────────────────┬───────────────────────────────────┘
                           │ SSE (X-Accel-Buffering: no, ping=15)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  FastAPI (Railway) — orchestration + event stream            │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  Agent loop — Gemini 2.5 Pro (Vertex AI)                     │
│  Streaming function calls · 4-tool surface · narration first │
└──────┬──────────────────────────┬────────────────────────────┘
       │                          │
       ▼                          ▼
┌──────────────────┐    ┌──────────────────────┐
│ Shopify Admin    │    │ Operational memory   │
│ (draft products) │    │ via swappable backend │
└──────────────────┘    │ ┌──────────────────┐ │
                        │ │ direct (pymongo) │ │ ← production default
                        │ ├──────────────────┤ │
                        │ │ mcp (stdio)      │ │ ← qualification demo
                        │ └──────────────────┘ │
                        └──────────┬───────────┘
                                   ▼
                        ┌──────────────────────┐
                        │ MongoDB Atlas        │
                        │ listings_memory      │
                        │ + Vector Search idx  │
                        │ + agent_runs (events)│
                        └──────────────────────┘
```

## MongoDB MCP integration

Helix talks to the operational-memory collection through a swappable backend layer. The same `$vectorSearch` pipeline can travel over two transports:

- **`direct`** — `pymongo` against Atlas. Production default on Railway.
- **`mcp`** — official [`mongodb-mcp-server`](https://github.com/mongodb-js/mongodb-mcp-server) over stdio. Used for the MongoDB-track qualification demo.

Switch with one env: `HELIX_MEMORY_BACKEND=direct|mcp` (default `direct`). The agent layer (`agent/tools.py`) keeps identical function signatures and docstrings; Gemini's function-call schema is unchanged. Full integration notes and measured latency in [`docs/mcp.md`](./docs/mcp.md).

> Helix supports MongoDB MCP-backed operational memory and direct Atlas access through a single swappable layer. The public deployment runs the direct backend for reliability; the MCP path is exercised on the qualification demo and uses the same `$vectorSearch` pipeline through the official `mongodb-mcp-server`.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js 16 · React 19 · Tailwind v4 | Custom Mission Control aesthetic, no chrome library |
| Backend | FastAPI · `sse-starlette` | Async orchestration + SSE that survives the Railway proxy |
| Reasoning | **Gemini 2.5 Pro** (Vertex AI) | Streaming function calls + narrated reasoning |
| Embeddings | `text-embedding-004` (768d, cosine) | Atlas Vector Search index `vector_index` |
| Memory | **MongoDB Atlas + Atlas Vector Search** | Persistent operational memory; load-bearing, not decorative |
| MCP | **mongodb-mcp-server** (stdio, Node) | MongoDB-track qualification |
| Action layer | Shopify Admin API (custom app, `shpua_`) | Real draft products on a live dev store |
| Hosting | Vercel (frontend) · Railway (backend) | Public deployment |

## Run a mission

### Public demo

Open [helix-tau-two.vercel.app](https://helix-tau-two.vercel.app), type a brief like *"Portable RGB Desk Lamp for small apartments"*, click **Run mission**. Watch the timeline. The full cycle (recall → reason → publish → consolidate) completes in ~25–30 seconds and a real draft product appears in the Shopify admin.

### Locally

You need a `.env` with credentials (see `.env.example`). The Python venv lives at `.venv/`.

```bash
# one-time
python -m venv .venv
.venv/Scripts/activate     # or source .venv/bin/activate on Linux/Mac
pip install -r requirements.txt
cd frontend && npm install && cd ..

# seed operational memory (synthetic historical launches)
python -m seed.seed_memory

# backend
uvicorn backend.main:app --reload --port 8000

# frontend (separate terminal)
cd frontend && npm run dev
```

Run a single mission from the CLI (skips the UI):

```bash
python -m agent.run "Portable RGB Desk Lamp"
```

Switch to the MCP-backed memory path for the qualification demo:

```bash
# Windows PowerShell
$env:HELIX_MEMORY_BACKEND="mcp"
python -m agent.run "Floating Glass RGB Shelf Lamp"
```

Smoke scripts under `scripts/` validate each external dependency in isolation: `smoke_gemini.py`, `smoke_mongo.py`, `smoke_shopify.py`, `smoke_memory.py`, `probe_mcp.py`.

## Deployment

Backend → Railway (Nixpacks Python builder, `mongodb-mcp-server` not deployed). Frontend → Vercel (Next.js 16 static build, `NEXT_PUBLIC_BACKEND_URL` baked at build time). Full step-by-step including env vars, GCP service-account injection, SSE proxy headers, and CORS in [`docs/deploy.md`](./docs/deploy.md).

## Repo layout

```text
helix/
├── frontend/           Next.js 16 — Mission Control UI
│   ├── src/app/        page.tsx, globals.css, layout.tsx
│   ├── src/lib/        api.ts (SSE client), highlight.ts (memory-ref highlights)
│   └── scripts/        smoke-highlight.ts (unit smoke for the regex layer)
├── backend/            FastAPI — /api/missions, /api/memory, SSE stream
├── agent/              Gemini function-calling loop
│   ├── mission.py      Mission orchestration + streaming emit
│   ├── tools.py        recall / publish / save (Gemini-facing signatures)
│   ├── memory.py       Direct backend (pymongo) + factory
│   ├── memory_mcp.py   MCP backend (stdio + persistent session)
│   └── run.py          CLI runner
├── seed/               Synthetic historical launches + seeding script
├── scripts/            Smoke tests + probes
├── docs/
│   ├── deploy.md       Railway + Vercel deployment guide
│   └── mcp.md          MongoDB MCP integration + measured latency
├── requirements.txt    Python deps (root, used by Railway)
├── nixpacks.toml       Railway build (explicit Python, prevents Next auto-detect)
├── Procfile            web: uvicorn backend.main:app
├── railway.json        Healthcheck + start command
└── .env.example        Required credentials reference
```

## Hackathon

[Google Cloud Rapid Agent Hackathon](https://cloud.google.com/) — **MongoDB track**. Deadline 2026-06-11.

Qualification requires Gemini + a partner MCP server. Helix runs Gemini 2.5 Pro on Vertex AI and integrates the official MongoDB MCP server as the operational-memory transport (see [`docs/mcp.md`](./docs/mcp.md)).

## License

MIT — see [`LICENSE`](./LICENSE).

---

<sub>Built by [Roberto Llanos](https://github.com/beto-llanos) · Reasoning by Gemini · Memory by MongoDB · Action by Shopify</sub>
