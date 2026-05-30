"""The core schemas: Task, TargetPack, OracleSpec, OracleResult, RunResult.

These mirror the four schemas described in the skill spec (task / target pack /
adapter / RunResult). Adapters take a Task + TargetPack in and return a RunResult.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field, asdict
from typing import Any


@dataclass
class OracleSpec:
    """A declarative check attached to a task.

    ``type`` selects the oracle implementation (see ``ax_eval.oracles``); the
    remaining fields are passed to it. ``path`` addresses a value in the world
    state a harness reports back after a run.
    """

    type: str
    path: str | None = None
    expected: Any = None
    value: Any = None
    description: str = ""

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "OracleSpec":
        known = {f for f in ("type", "path", "expected", "value", "description")}
        return cls(**{k: v for k, v in data.items() if k in known})


@dataclass
class Task:
    """A concrete goal an agent must achieve against the target."""

    id: str
    title: str
    prompt: str
    oracles: list[OracleSpec] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Task":
        return cls(
            id=data["id"],
            title=data.get("title", data["id"]),
            prompt=data.get("prompt", ""),
            oracles=[OracleSpec.from_dict(o) for o in data.get("oracles", [])],
        )


@dataclass
class TargetPack:
    """Versioned bundle describing a target and its task set."""

    name: str
    version: str
    auth_method: str = "none"
    base_url: str = ""
    docs_urls: list[str] = field(default_factory=list)
    tasks: list[Task] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TargetPack":
        return cls(
            name=data["name"],
            version=str(data.get("version", "0")),
            auth_method=data.get("auth_method", "none"),
            base_url=data.get("base_url", ""),
            docs_urls=list(data.get("docs_urls", [])),
            tasks=[Task.from_dict(t) for t in data.get("tasks", [])],
        )


@dataclass
class OracleResult:
    """The outcome of evaluating a single oracle."""

    type: str
    passed: bool
    detail: str = ""


@dataclass
class RunResult:
    """The record of one task x harness run."""

    task_id: str
    harness: str
    success: bool
    oracle_results: list[OracleResult] = field(default_factory=list)
    trace: list[str] = field(default_factory=list)
    duration_s: float = 0.0
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class _Timer:
    """Context manager that records elapsed wall-clock seconds."""

    def __enter__(self) -> "_Timer":
        self._start = time.perf_counter()
        self.elapsed = 0.0
        return self

    def __exit__(self, *exc: object) -> None:
        self.elapsed = time.perf_counter() - self._start
