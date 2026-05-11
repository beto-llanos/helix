"""
Quick discovery: which Gemini model IDs exist in this Vertex project right now?
Tries common variants and reports which respond.
"""
import os
import sys
from dotenv import load_dotenv

load_dotenv()

PROJECT = os.environ["GOOGLE_CLOUD_PROJECT"]
LOCATION = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")

CANDIDATES = [
    "gemini-3-pro",
    "gemini-3-pro-preview",
    "gemini-3.1-pro-preview",
    "gemini-3-pro-preview-05-2026",
    "gemini-3-flash",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-pro",
]


def main() -> int:
    from google import genai
    client = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)

    found = []
    for model in CANDIDATES:
        try:
            r = client.models.generate_content(model=model, contents="hi")
            found.append((model, "OK"))
            print(f"  ✓ {model}")
        except Exception as e:
            msg = str(e)
            if "NOT_FOUND" in msg:
                print(f"  ✗ {model}  (not found)")
            else:
                print(f"  ⚠ {model}  ({type(e).__name__}: {msg[:80]})")
    print()
    if found:
        print(f"USE: {found[0][0]}")
        return 0
    print("FAIL — no working model found")
    return 1


if __name__ == "__main__":
    sys.exit(main())
