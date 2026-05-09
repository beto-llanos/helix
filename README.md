<div align="center">

# Helix

### Autonomous Commerce Operations Runtime

*An AI agent that doesn't generate listings. It operates a commerce business.*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Built with Gemini 3](https://img.shields.io/badge/Built%20with-Gemini%203-4285F4.svg)](https://deepmind.google/technologies/gemini/)
[![MongoDB Atlas](https://img.shields.io/badge/Memory-MongoDB%20Atlas-00ED64.svg)](https://www.mongodb.com/atlas)
[![Vertex AI Agent Builder](https://img.shields.io/badge/Runtime-Vertex%20Agent%20Builder-4285F4.svg)](https://cloud.google.com/products/agent-builder)

</div>

---

## What Helix is

Helix is an autonomous commerce runtime. You hand it a product — a link, an image, an idea — and it executes the full launch mission: research, reasoning, generation, publication, and memory consolidation. Every decision is grounded in operational memory of past launches.

It is **not** a listing generator. It is **not** a chatbot. It is an agent runtime that operates persistent commerce intelligence.

> The wow moment is not that a product gets published.
> The wow moment is the agent reasoning from its own operational history.

## Why it exists

Sellers across LATAM lose hours per product translating ideas into polished, optimized, channel-ready listings. The work is repetitive, judgment-heavy, and impossible to outsource cleanly because every decision depends on context from past launches.

Helix turns that workflow into an autonomous mission and lets the agent's own operational memory accumulate the judgment.

## The Mission Loop

Every Helix run executes five stages, fully visible in the Mission Control timeline.

| Stage | What the agent does | Where state lives |
|---|---|---|
| **1. Ingestion** | Extract product context from URL / image / idea. | `mongo:product_context` |
| **2. Market Research** | Lightweight real retrieval (Gemini grounding) + vector search over own listing memory. | `mongo:listings_memory` (Atlas Vector Search) |
| **3. Listing Generation** | SEO title, description, tags, pricing, variants, positioning — with reasoning trace. | `mongo:agent_runs` |
| **4. Publication** | Real publication to Shopify Admin API. | Shopify dev store |
| **5. Memory Consolidation** | Embed and store the launch + decisions for future retrieval. | `mongo:listings_memory` |

The agent emits state to MongoDB at every step. The frontend reacts via **Atlas change streams** — MongoDB is the live nervous system, not just storage.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Next.js (Vercel) — Mission Control                     │
│  Timeline-first UI. No dashboards. No chat-centered.    │
└────────────────┬────────────────────────────────────────┘
                 │ MongoDB Atlas Change Streams
                 ▼
┌─────────────────────────────────────────────────────────┐
│  Vertex AI Agent Builder (ADK) — The Agent Runtime      │
│  Gemini 3 reasoning + Google Search grounding           │
│  Tools: mongodb_mcp · shopify_publish · product_extract │
└────────────────┬────────────────────────────────────────┘
                 │
                 ├─► MongoDB Atlas (operational memory + vector search)
                 ├─► Shopify Admin API (action layer)
                 └─► FastAPI (thin orchestration + auth)
```

**Why ADK and not Conversational Agents:** the reasoning trace must be visible, not hidden behind chat turns.
**Why change streams and not SSE:** they make MongoDB load-bearing in the architecture, not decorative.
**Why a custom Next.js UI:** the cinematic mission flow is the product. Streamlit cannot deliver this.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js 15 + TypeScript + Tailwind + shadcn/ui | Mission Control aesthetic |
| Backend | FastAPI (Python) | Thin orchestration, async-friendly |
| Agent Runtime | **Vertex AI Agent Builder (ADK)** | Hackathon requirement + reasoning visibility |
| Reasoning | **Gemini 3** | Grounding + multimodal + reasoning depth |
| Memory | **MongoDB Atlas + Atlas Vector Search** | Persistent operational memory |
| MCP | **MongoDB MCP Server** | Required for MongoDB track |
| Action layer | Shopify Admin API | Real publication on dev store |
| Hosting | Vercel (frontend) · Railway (backend) | Fast deploys, public demo |

## Hackathon

Helix is being built for the [Google Cloud Rapid Agent Hackathon](https://cloud.google.com/) — **MongoDB track**.

- **Deadline:** June 11, 2026
- **Track:** MongoDB
- **Prize tier targeted:** Podium (1st – $5,000 / 2nd – $3,000 / 3rd – $2,000)

Submission requires Gemini 3 + Agent Builder + a partner MCP server. Helix uses MongoDB MCP as its memory access layer.

## Project Structure

```
helix/
├── frontend/        Next.js 15 — Mission Control UI
├── backend/         FastAPI — orchestration layer
├── agent/           Vertex Agent Builder definitions + tools
├── seed/            Synthetic operational history (30 launches w/ embeddings)
├── scripts/         Smoke tests (smoke_shopify, smoke_mongo, smoke_gemini)
├── docs/            Architecture notes, demo script, judging rubric mapping
├── .env.example     All credentials required
├── LICENSE          MIT
└── README.md        You are here
```

## Roadmap

### Phase 1 — Foundations (Days 1–3)
- [ ] Provisioning: Google Cloud, MongoDB Atlas, Shopify dev store
- [ ] Smoke tests green: Shopify publish, Mongo vector search, Gemini grounding
- [ ] First end-to-end vertical slice: prompt → agent → published product

### Phase 2 — The Agent (Days 4–10)
- [ ] All 5 stages of the Mission Loop wired
- [ ] MongoDB MCP server integrated as agent tool
- [ ] Seed data: 30 synthetic historical launches with embeddings
- [ ] Vector search retrieval visibly informing decisions

### Phase 3 — Mission Control UI (Days 11–22)
- [ ] Timeline-first layout, change-stream-driven
- [ ] Reasoning panel, retrieved memory panel, product preview
- [ ] Animation pass: feels cinematic, not "loading…"

### Phase 4 — Demo polish (Days 23–33)
- [ ] Demo script + 3-minute video
- [ ] Architecture deep-dive documentation
- [ ] Public deployment hardening

### Phase 5 — Submission (Days 34–35)
- [ ] Devpost submission
- [ ] Final repo audit (license, README, deploy URL)

## Status

**Current phase:** Phase 1 — Foundations
**Last updated:** 2026-05-08

---

<sub>Built by [Roberto Llanos](https://github.com/) · Powered by Google Cloud · Memory by MongoDB</sub>
