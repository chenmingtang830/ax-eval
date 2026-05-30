"""The runner: orchestrate N tasks x M harnesses into a result set + matrix."""

from __future__ import annotations

from dataclasses import dataclass, field

from .datatypes import RunResult, TargetPack
from .harnesses import get_harness


@dataclass
class RunReport:
    """The full output of a run: every RunResult plus the pack/harness context."""

    pack: str
    pack_version: str
    harnesses: list[str]
    results: list[RunResult] = field(default_factory=list)

    def matrix(self) -> dict[str, dict[str, bool]]:
        """task_id -> {harness -> success}."""
        grid: dict[str, dict[str, bool]] = {}
        for r in self.results:
            grid.setdefault(r.task_id, {})[r.harness] = r.success
        return grid

    def pass_rate(self, harness: str) -> float:
        rs = [r for r in self.results if r.harness == harness]
        return sum(r.success for r in rs) / len(rs) if rs else 0.0


def run(
    pack: TargetPack,
    harness_names: list[str],
    *,
    progress: bool = False,
) -> RunReport:
    """Run every task in ``pack`` across each named harness, sequentially."""
    report = RunReport(
        pack=pack.name, pack_version=pack.version, harnesses=list(harness_names)
    )
    for name in harness_names:
        harness = get_harness(name)
        for task in pack.tasks:
            result = harness.run(task, pack)
            report.results.append(result)
            if progress:
                mark = "PASS" if result.success else "FAIL"
                print(f"  [{mark}] {name} x {task.id}")
    return report
