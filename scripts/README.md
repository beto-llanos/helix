# Helix — Smoke Tests

Three scripts that validate the foundational stack on Day 1. If any of these
fail, do not proceed to Phase 2 — the architecture has a hole.

## Setup

```bash
cd scripts
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt
cp ../.env.example ../.env      # then fill in real values
```

## Run order

```bash
python smoke_shopify.py     # → publishes a draft product
python smoke_mongo.py       # → writes a doc + runs $vectorSearch
python smoke_gemini.py      # → calls Gemini 3 with grounding
```

## What "green" looks like

- `smoke_shopify.py` → prints `product_id` and admin URL
- `smoke_mongo.py` → prints vector search result with score
- `smoke_gemini.py` → prints Gemini response + grounding sources count

If all three pass, the foundation is real. Proceed to the agent vertical slice.
