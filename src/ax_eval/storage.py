"""Local JSON result storage."""

from __future__ import annotations

import json
from pathlib import Path

from .runner import RunReport


def save_report(report: RunReport, path: str | Path) -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "pack": report.pack,
        "pack_version": report.pack_version,
        "harnesses": report.harnesses,
        "results": [r.to_dict() for r in report.results],
    }
    p.write_text(json.dumps(payload, indent=2))
    return p


def load_report(path: str | Path) -> dict:
    return json.loads(Path(path).read_text())
