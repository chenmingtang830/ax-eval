"""Hermes harness — the planned third harness for the cross-harness matrix.

Provider and auth are still TBD (see product-spec.md s3), so this ships as a
*keyless stub*: it runs without credentials and produces a deterministic,
middling competence profile, purely so the Hermes column exists end-to-end. When
the real runtime/auth is decided, replace ``attempt`` with the live adapter and
flip ``requires_key``/``key_env``.
"""

from __future__ import annotations

from typing import Any

from ..datatypes import Task, TargetPack
from .mock import MockHarness


class HermesHarness(MockHarness):
    """Keyless stand-in for the (planned) Hermes harness."""

    #: When wired to the real provider, set these and drop the stub note.
    requires_key = False
    key_env = "HERMES_API_KEY"
    is_stub = True

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(name="hermes", **kwargs)

    def attempt(
        self, task: Task, pack: TargetPack
    ) -> tuple[dict[str, Any], list[str]]:
        world, trace = super().attempt(task, pack)
        trace.insert(
            0,
            "[hermes] NOTE: keyless stub — provider/auth TBD; output is simulated",
        )
        return world, trace
