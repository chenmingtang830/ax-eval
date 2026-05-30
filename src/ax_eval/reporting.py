"""Render a run as a human-readable matrix + failure summary (markdown/text)."""

from __future__ import annotations

from collections import Counter


def _matrix_from_payload(payload: dict) -> tuple[list[str], list[str], dict]:
    harnesses = payload.get("harnesses", [])
    grid: dict[str, dict[str, bool]] = {}
    for r in payload.get("results", []):
        grid.setdefault(r["task_id"], {})[r["harness"]] = r["success"]
    task_ids = list(grid)
    return task_ids, harnesses, grid


def render(payload: dict) -> str:
    """Render a saved report payload (see storage.save_report) as text."""
    task_ids, harnesses, grid = _matrix_from_payload(payload)
    lines: list[str] = []
    title = f"AX eval — {payload.get('pack')} v{payload.get('pack_version')}"
    lines.append(title)
    lines.append("=" * len(title))
    lines.append("")

    if not task_ids:
        lines.append("(no results)")
        return "\n".join(lines)

    # Matrix table.
    tcol = max(len(t) for t in task_ids + ["task"])
    header = "task".ljust(tcol) + "  " + "  ".join(h.center(10) for h in harnesses)
    lines.append(header)
    lines.append("-" * len(header))
    for tid in task_ids:
        row = tid.ljust(tcol) + "  "
        cells = []
        for h in harnesses:
            ok = grid[tid].get(h)
            cells.append(("PASS" if ok else "FAIL").center(10))
        lines.append(row + "  ".join(cells))

    # Pass rates.
    lines.append("")
    lines.append("Pass rate by harness:")
    for h in harnesses:
        total = sum(1 for t in task_ids if h in grid[t])
        passed = sum(1 for t in task_ids if grid[t].get(h))
        pct = (passed / total * 100) if total else 0.0
        lines.append(f"  {h:<12} {passed}/{total}  ({pct:.0f}%)")

    # Top failing tasks (where most harnesses fail) — the "what to fix" hint.
    fails = Counter()
    for tid in task_ids:
        n_fail = sum(1 for h in harnesses if grid[tid].get(h) is False)
        if n_fail:
            fails[tid] = n_fail
    if fails:
        lines.append("")
        lines.append("Most-failed tasks (candidate fixes):")
        for tid, n in fails.most_common():
            lines.append(f"  {tid}: failed on {n}/{len(harnesses)} harnesses")

    return "\n".join(lines)
