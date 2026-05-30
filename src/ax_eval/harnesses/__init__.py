"""Harness adapters: normalize an agent runtime to ``run(task, pack) -> RunResult``.

Adapters register themselves with the runner by name (see ``registry``). v0 ships
keyless adapters (Mock, Hermes-stub) so the runner can be exercised end-to-end
with no credentials or network; real adapters (Claude Code, Codex) land at M1.
"""

from .base import Harness
from .registry import get_harness, available_harnesses, register_harness

__all__ = [
    "Harness",
    "get_harness",
    "available_harnesses",
    "register_harness",
]
