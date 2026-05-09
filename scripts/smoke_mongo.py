"""
Smoke test: MongoDB Atlas + Vector Search.

Verifies:
  1. Connection to Atlas via MONGODB_URI
  2. Write to listings_memory with a fake embedding
  3. $vectorSearch returns the document

If this passes, the operational memory layer is ready to back the agent.

Prerequisite (do once in Atlas UI):
  Create a Vector Search index on db.listings_memory:
    {
      "fields": [{
        "type": "vector",
        "path": "embedding",
        "numDimensions": 768,
        "similarity": "cosine"
      }]
    }
  Index name must match MONGODB_VECTOR_INDEX in .env.

Usage:
    python scripts/smoke_mongo.py
"""
import os
import sys
import random
from dotenv import load_dotenv
from pymongo import MongoClient

load_dotenv()

URI = os.environ["MONGODB_URI"]
DB_NAME = os.environ["MONGODB_DB"]
INDEX = os.environ["MONGODB_VECTOR_INDEX"]
DIMS = 768  # text-embedding-004


def main() -> int:
    client = MongoClient(URI)
    db = client[DB_NAME]
    coll = db["listings_memory"]

    fake_embedding = [random.random() for _ in range(DIMS)]
    doc = {
        "_id": "smoke-test-001",
        "product": "RGB Desk Lamp (smoke)",
        "launch_price": 39,
        "outcome": "underperformed",
        "notes": "Smoke test document. Safe to delete.",
        "embedding": fake_embedding,
    }
    coll.replace_one({"_id": doc["_id"]}, doc, upsert=True)
    print(f"✓ wrote doc {doc['_id']}")

    pipeline = [
        {
            "$vectorSearch": {
                "index": INDEX,
                "path": "embedding",
                "queryVector": fake_embedding,
                "numCandidates": 10,
                "limit": 1,
            }
        },
        {"$project": {"product": 1, "outcome": 1, "score": {"$meta": "vectorSearchScore"}}},
    ]
    results = list(coll.aggregate(pipeline))
    if not results:
        print("✗ FAIL  vector search returned no results — check index name & dims")
        return 1
    print(f"✓ vector search OK  →  {results[0]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
