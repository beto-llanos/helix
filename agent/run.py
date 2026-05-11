"""
CLI entrypoint.

Usage:
    .venv/Scripts/python.exe -m agent.run "Portable RGB Desk Lamp"
"""
from __future__ import annotations

import sys

from dotenv import load_dotenv

load_dotenv()

from .mission import run_mission


def main() -> int:
    if len(sys.argv) < 2:
        brief = "Portable RGB Desk Lamp"
        print(f"(no brief given; defaulting to: {brief!r})")
    else:
        brief = " ".join(sys.argv[1:])

    run_mission(brief)
    return 0


if __name__ == "__main__":
    sys.exit(main())
