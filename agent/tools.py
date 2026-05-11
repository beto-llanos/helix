"""
Helix agent tools.

These are the only actions the agent can perform. The agent decides WHEN to
call them; this module only implements HOW.

Three tools:
  - recall_similar_launches: vector search over operational memory
  - publish_to_shopify: create a draft product on the dev store
  - save_mission_outcome: persist the completed launch into operational memory
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

import requests
from pymongo import MongoClient
from google import genai

# ── lazy singletons ─────────────────────────────────────────────────────────
_mongo: MongoClient | None = None
_genai: genai.Client | None = None


def _mongo_db():
    global _mongo
    if _mongo is None:
        _mongo = MongoClient(os.environ["MONGODB_URI"])
    return _mongo[os.environ["MONGODB_DB"]]


def _genai_client() -> genai.Client:
    global _genai
    if _genai is None:
        _genai = genai.Client(
            vertexai=True,
            project=os.environ["GOOGLE_CLOUD_PROJECT"],
            location=os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1"),
        )
    return _genai


def _embed(text: str) -> list[float]:
    model = os.environ.get("EMBEDDING_MODEL", "text-embedding-004")
    r = _genai_client().models.embed_content(model=model, contents=text)
    return list(r.embeddings[0].values)


# ── TOOL 1 ──────────────────────────────────────────────────────────────────
def recall_similar_launches(query: str, k: int = 3) -> list[dict[str, Any]]:
    """Retrieve historically similar product launches from operational memory.

    Use this BEFORE making pricing or positioning decisions. The returned
    documents include past launch prices, outcomes (blockbuster/strong/solid/
    underperformed), and operator notes explaining why each outcome happened.

    Args:
        query: A short description of the product being launched.
        k: How many similar past launches to retrieve.

    Returns:
        A list of past launches, each with product_name, launch_price, outcome,
        notes, copy_style, and a similarity score.
    """
    db = _mongo_db()
    pipeline = [
        {
            "$vectorSearch": {
                "index": os.environ["MONGODB_VECTOR_INDEX"],
                "path": "embedding",
                "queryVector": _embed(query),
                "numCandidates": 20,
                "limit": k,
            }
        },
        {
            "$project": {
                "_id": 1,
                "product_name": 1,
                "launch_price": 1,
                "outcome": 1,
                "units_30d": 1,
                "bounce_rate": 1,
                "copy_style": 1,
                "thumbnail_style": 1,
                "notes": 1,
                "score": {"$meta": "vectorSearchScore"},
            }
        },
    ]
    return list(db["listings_memory"].aggregate(pipeline))


# ── TOOL 2 ──────────────────────────────────────────────────────────────────
def publish_to_shopify(
    title: str,
    description_html: str,
    price: float,
    tags: list[str],
    product_type: str = "Lighting",
) -> dict[str, Any]:
    """Publish a product as a draft on the Helix Shopify dev store.

    Always publish as draft so the operator can review before going live.

    Args:
        title: SEO-optimized product title.
        description_html: HTML product description (use paragraph tags).
        price: Decimal price in USD.
        tags: List of category/positioning tags.
        product_type: High-level product type.

    Returns:
        Dict with product_id, handle, and admin_url. Or {"error": "..."}.
    """
    store = os.environ["SHOPIFY_STORE_DOMAIN"]
    token = os.environ["SHOPIFY_ADMIN_API_TOKEN"]
    version = os.environ.get("SHOPIFY_API_VERSION", "2025-01")

    payload = {
        "product": {
            "title": title,
            "body_html": description_html,
            "vendor": "Helix",
            "product_type": product_type,
            "tags": ",".join(tags),
            "status": "draft",
            "variants": [{"price": f"{price:.2f}"}],
        }
    }
    r = requests.post(
        f"https://{store}/admin/api/{version}/products.json",
        json=payload,
        headers={"X-Shopify-Access-Token": token, "Content-Type": "application/json"},
        timeout=20,
    )
    if not r.ok:
        return {"error": f"{r.status_code}: {r.text[:300]}"}
    p = r.json()["product"]
    return {
        "product_id": p["id"],
        "handle": p["handle"],
        "admin_url": f"https://{store}/admin/products/{p['id']}",
    }


# ── TOOL 3 ──────────────────────────────────────────────────────────────────
def save_mission_outcome(
    product_name: str,
    launch_price: float,
    positioning_summary: str,
    reasoning_summary: str,
    shopify_product_id: int,
    copy_style: str = "ambient-productivity",
) -> dict[str, Any]:
    """Consolidate the completed launch into operational memory.

    This makes the agent's decision retrievable by future missions, building
    persistent operational intelligence over time.

    Args:
        product_name: The published product title.
        launch_price: Final launch price decided.
        positioning_summary: One-sentence summary of the chosen positioning.
        reasoning_summary: One-sentence summary of why this decision was made,
            ideally referencing the past launches that informed it.
        shopify_product_id: Shopify product ID returned by publish_to_shopify.
        copy_style: Categorical tag for the copy style chosen.

    Returns:
        Dict with the new memory doc _id.
    """
    db = _mongo_db()
    now = datetime.now(timezone.utc)
    embedding_source = (
        f"{product_name}. Positioning: {positioning_summary}. "
        f"Priced at ${launch_price:.2f}."
    )
    doc = {
        "_id": f"mission_{int(now.timestamp())}",
        "product_name": product_name,
        "category": "lighting/rgb-desk",
        "launched_at": now.strftime("%Y-%m-%d"),
        "launch_price": launch_price,
        "outcome": "pending",  # will be updated by post-launch monitoring later
        "copy_style": copy_style,
        "notes": reasoning_summary,
        "positioning": positioning_summary,
        "shopify_product_id": shopify_product_id,
        "embedding_source": embedding_source,
        "embedding": _embed(embedding_source),
        "created_at": now,
    }
    db["listings_memory"].replace_one({"_id": doc["_id"]}, doc, upsert=True)
    return {"memory_id": doc["_id"]}
