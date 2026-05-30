"""Config loading: ``.env`` parsing and target-pack YAML loading."""

from __future__ import annotations

import os
from pathlib import Path

import yaml

from .datatypes import TargetPack


def load_dotenv(path: str | Path = ".env", *, override: bool = False) -> dict[str, str]:
    """Minimal ``.env`` loader. Missing file is fine (keyless path).

    Lines are ``KEY=VALUE``; blank lines and ``#`` comments are ignored. Values
    are loaded into ``os.environ`` unless already set (unless ``override``).
    """
    p = Path(path)
    loaded: dict[str, str] = {}
    if not p.exists():
        return loaded
    for raw in p.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if not key:
            continue
        loaded[key] = value
        if override or key not in os.environ:
            os.environ[key] = value
    return loaded


def load_pack(path: str | Path) -> TargetPack:
    """Load a target pack from a YAML file."""
    data = yaml.safe_load(Path(path).read_text())
    if not isinstance(data, dict):
        raise ValueError(f"target pack {path} must be a YAML mapping")
    return TargetPack.from_dict(data)
