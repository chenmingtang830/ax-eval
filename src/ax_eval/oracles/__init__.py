"""Programmatic oracles: declarative checks over a run's reported world state.

An oracle takes its ``OracleSpec`` plus the ``world`` dict a harness returns and
decides pass/fail. They are pure and need no network, so they run identically in
mock mode (against fixtures) and against live API-readback state later.
"""

from .base import evaluate, evaluate_all, register, ORACLES

__all__ = ["evaluate", "evaluate_all", "register", "ORACLES"]
