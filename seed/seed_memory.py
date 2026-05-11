"""
Seeds helix.listings_memory with synthetic historical RGB launches.

Each doc gets an embedding generated from Gemini text-embedding-004
(768 dims, matches the Atlas vector_index config).

Run from helix/:
    .venv/Scripts/python.exe seed/seed_memory.py
"""
import os
import sys
import json
from pathlib import Path

from dotenv import load_dotenv
from pymongo import MongoClient
from google import genai

load_dotenv()

MONGODB_URI = os.environ["MONGODB_URI"]
MONGODB_DB = os.environ["MONGODB_DB"]
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "text-embedding-004")
PROJECT = os.environ["GOOGLE_CLOUD_PROJECT"]
LOCATION = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")

SEED_FILE = Path(__file__).parent / "listings.json"


def embed(client: genai.Client, text: str) -> list[float]:
    result = client.models.embed_content(
        model=EMBEDDING_MODEL,
        contents=text,
    )
    return list(result.embeddings[0].values)


def main() -> int:
    listings = json.loads(SEED_FILE.read_text(encoding="utf-8"))
    print(f"loaded {len(listings)} historical launches")

    genai_client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)
    mongo = MongoClient(MONGODB_URI)
    coll = mongo[MONGODB_DB]["listings_memory"]

    inserted = 0
    for doc in listings:
        doc["embedding"] = embed(genai_client, doc["embedding_source"])
        coll.replace_one({"_id": doc["_id"]}, doc, upsert=True)
        inserted += 1
        print(f"  + {doc['_id']}  {doc['product_name']!r}  ({doc['outcome']})")

    print(f"\nseeded {inserted} docs into {MONGODB_DB}.listings_memory")
    print("(vector index 'vector_index' will auto-index these in ~30s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
