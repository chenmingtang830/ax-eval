"""Name-based harness registry.

The runner discovers adapters by name; harness selection is config-driven. v0
registers only keyless adapters so the matrix runs with no credentials:

  * ``mock``       — a competent agent (passes everything)
  * ``mock-weak``  — a weaker agent (skips/flubs several tasks)
  * ``hermes``     — keyless stub for the planned Hermes harness

Real adapters (``claude-code``, ``codex``) register here once implemented.
"""

from __future__ import annotations

from typing import Callable

from .base import Harness
from .hermes import HermesHarness
from .mock import MockHarness

# A factory per name so each run gets a fresh adapter instance.
_FACTORIES: dict[str, Callable[[], Harness]] = {}


def register_harness(name: str, factory: Callable[[], Harness]) -> None:
    _FACTORIES[name] = factory


def available_harnesses() -> list[str]:
    return sorted(_FACTORIES)


def get_harness(name: str) -> Harness:
    try:
        factory = _FACTORIES[name]
    except KeyError:
        raise KeyError(
            f"unknown harness {name!r}; available: {', '.join(available_harnesses())}"
        ) from None
    return factory()


# --- default keyless registrations ---------------------------------------
register_harness("mock", lambda: MockHarness("mock"))
register_harness(
    "mock-weak",
    lambda: MockHarness(
        "mock-weak",
        skip={"asana-move-section", "asana-subtask"},
        wrong={"asana-due-date"},
    ),
)
register_harness("hermes", lambda: HermesHarness(wrong={"asana-comment"}))
