"""Mock harness — a fake agent runtime for keyless, networkless runs.

It synthesizes a world state directly from each task's oracle specs, so a run is
deterministic and scoreable without touching a real target. To make a realistic,
*damning-demo* matrix (agents succeed at different rates), a mock can be told to
``skip`` some tasks (does nothing -> oracles fail) or get them ``wrong`` (writes
an off value -> equals/contains fail while exists passes).
"""

from __future__ import annotations

from typing import Any, Iterable

from ..datatypes import Task, TargetPack
from .base import Harness


def _set_path(world: dict[str, Any], path: str, value: Any) -> None:
    node = world
    parts = path.split(".")
    for part in parts[:-1]:
        node = node.setdefault(part, {})
    node[parts[-1]] = value


class MockHarness(Harness):
    """Deterministic fake harness with a configurable competence profile."""

    requires_key = False

    def __init__(
        self,
        name: str = "mock",
        *,
        skip: Iterable[str] = (),
        wrong: Iterable[str] = (),
    ) -> None:
        self.name = name
        self.skip = set(skip)
        self.wrong = set(wrong)

    def attempt(
        self, task: Task, pack: TargetPack
    ) -> tuple[dict[str, Any], list[str]]:
        trace = [f"[{self.name}] received task {task.id!r}: {task.title}"]

        if task.id in self.skip:
            trace.append(f"[{self.name}] gave up — produced no changes")
            return {}, trace

        world: dict[str, Any] = {}
        wrong = task.id in self.wrong
        for oracle in task.oracles:
            if not oracle.path:
                continue
            if oracle.type == "exists":
                _set_path(world, oracle.path, "" if wrong else "<created>")
            elif oracle.type == "equals":
                _set_path(
                    world,
                    oracle.path,
                    "__incorrect__" if wrong else oracle.expected,
                )
            elif oracle.type == "contains":
                _set_path(
                    world,
                    oracle.path,
                    [] if wrong else [oracle.value],
                )
        verb = "made plausible-but-wrong changes" if wrong else "completed the task"
        trace.append(f"[{self.name}] {verb}; reported world: {world}")
        return world, trace
