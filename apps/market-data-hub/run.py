#!/usr/bin/env python3
"""Convenience runner so `python run.py ...` works with the src layout."""

from __future__ import annotations

import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent / "src"
sys.path.insert(0, str(SRC))

from nexora_market_data.cli import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
