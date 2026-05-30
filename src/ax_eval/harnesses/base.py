"""The harness/adapter interface.

A harness drives a model to attempt a task; the adapter normalizes its I/O to a
``RunResult``. Concretely, an adapter produces a *world state* dict (what it
believes it changed) plus a trace, and the runner scores that world with the
task's oracles. This keeps mock and live adapters interchangeable: oracles do
not care whether the world came from a fixture or a real API readback.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from ..datatypes import RunResult, Task, TargetPack


class Harness(ABC):
    """Base class for all harness adapters."""

    #: Stable name used in config and the matrix.
    name: str = "base"
    #: Whether this adapter needs credentials to do real work. Keyless adapters
    #: (Mock, Hermes-stub) are always runnable; the runner can skip key-requiring
    #: adapters when their credential is absent.
    requires_key: bool = False
    #: Env var holding the credential, when ``requires_key`` is True.
    key_env: str | None = None

    @abstractmethod
    def attempt(self, task: Task, pack: TargetPack) -> tuple[dict[str, Any], list[str]]:
        """Attempt the task. Return ``(world_state, trace_lines)``.

        Implementations must not raise for ordinary task failure — a failed
        attempt is a legitimate result. Raise only on adapter/infra errors.
        """

    def run(self, task: Task, pack: TargetPack) -> RunResult:
        """Run a task and score it with the task's oracles."""
        # Imported lazily to avoid a circular import at module load.
        from ..datatypes import _Timer
        from ..oracles import evaluate_all

        with _Timer() as timer:
            try:
                world, trace = self.attempt(task, pack)
            except Exception as exc:  # adapter/infra failure, not task failure
                return RunResult(
                    task_id=task.id,
                    harness=self.name,
                    success=False,
                    duration_s=timer.elapsed,
                    error=f"{type(exc).__name__}: {exc}",
                )
            oracle_results = evaluate_all(task.oracles, world)

        success = bool(oracle_results) and all(r.passed for r in oracle_results)
        return RunResult(
            task_id=task.id,
            harness=self.name,
            success=success,
            oracle_results=oracle_results,
            trace=trace,
            duration_s=timer.elapsed,
        )
