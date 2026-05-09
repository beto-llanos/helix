"""
Smoke test: Shopify Admin API publication.

Verifies that the credentials in .env can publish a real product to the
Shopify dev store. If this fails on Day 1, every later assumption breaks.

Usage:
    python scripts/smoke_shopify.py
"""
import os
import sys
import requests
from dotenv import load_dotenv

load_dotenv()

STORE = os.environ["SHOPIFY_STORE_DOMAIN"]
TOKEN = os.environ["SHOPIFY_ADMIN_API_TOKEN"]
VERSION = os.environ.get("SHOPIFY_API_VERSION", "2025-01")

URL = f"https://{STORE}/admin/api/{VERSION}/products.json"
HEADERS = {
    "X-Shopify-Access-Token": TOKEN,
    "Content-Type": "application/json",
}

PAYLOAD = {
    "product": {
        "title": "Helix Smoke Test — RGB Desk Lamp",
        "body_html": "<p>Smoke test product. Safe to delete.</p>",
        "vendor": "Helix",
        "product_type": "Lighting",
        "tags": "helix-smoke-test",
        "status": "draft",
        "variants": [{"price": "29.99", "sku": "HELIX-SMOKE-001"}],
    }
}


def main() -> int:
    print(f"→ POST {URL}")
    r = requests.post(URL, json=PAYLOAD, headers=HEADERS, timeout=15)
    if not r.ok:
        print(f"✗ FAIL  {r.status_code}  {r.text[:500]}")
        return 1
    product = r.json()["product"]
    print(f"✓ OK   product_id={product['id']}  handle={product['handle']}")
    print(f"  view: https://{STORE}/admin/products/{product['id']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
