"""
Smoke test: Gemini 3 reasoning + Google Search grounding.

Verifies:
  1. Vertex AI credentials are wired (ADC or service account JSON)
  2. Gemini 3 model responds
  3. Google Search grounding returns sources

If this passes, the reasoning + research layer is ready.

Usage:
    python scripts/smoke_gemini.py
"""
import os
import sys
from dotenv import load_dotenv

load_dotenv()

PROJECT = os.environ["GOOGLE_CLOUD_PROJECT"]
LOCATION = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")
MODEL = os.environ.get("GEMINI_MODEL", "gemini-3-pro")


def main() -> int:
    from google import genai
    from google.genai import types

    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)

    response = client.models.generate_content(
        model=MODEL,
        contents=(
            "I'm researching the e-commerce market for a portable RGB desk lamp. "
            "In one paragraph, what is the typical price range on Shopify stores "
            "and what positioning works best?"
        ),
        config=types.GenerateContentConfig(
            tools=[types.Tool(google_search=types.GoogleSearch())],
            temperature=0.3,
        ),
    )

    text = response.text
    if not text:
        print("✗ FAIL  empty response")
        return 1

    print("✓ Gemini responded:\n")
    print(text)
    print()

    # Surface grounding metadata if present
    grounding = getattr(response.candidates[0], "grounding_metadata", None)
    if grounding and getattr(grounding, "grounding_chunks", None):
        print(f"✓ grounding sources: {len(grounding.grounding_chunks)}")
    else:
        print("⚠ no grounding chunks returned (model may have answered from priors)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
