"""Oracle registry and built-in oracle types.

World state is a flat-ish dict; ``path`` uses dotted keys (e.g. ``task.due_on``)
resolved against nested dicts.
"""

from __future__ import annotations

from typing import Any, Callable

from ..datatypes import OracleResult, OracleSpec

OracleFn = Callable[[OracleSpec, dict[str, Any]], OracleResult]

ORACLES: dict[str, OracleFn] = {}


def register(name: str) -> Callable[[OracleFn], OracleFn]:
    def deco(fn: OracleFn) -> OracleFn:
        ORACLES[name] = fn
        return fn

    return deco


_MISSING = object()


def _resolve(world: dict[str, Any], path: str | None) -> Any:
    if not path:
        return _MISSING
    node: Any = world
    for part in path.split("."):
        if isinstance(node, dict) and part in node:
            node = node[part]
        else:
            return _MISSING
    return node


@register("exists")
def _exists(spec: OracleSpec, world: dict[str, Any]) -> OracleResult:
    value = _resolve(world, spec.path)
    ok = value is not _MISSING
    return OracleResult("exists", ok, f"{spec.path} {'present' if ok else 'missing'}")


@register("equals")
def _equals(spec: OracleSpec, world: dict[str, Any]) -> OracleResult:
    value = _resolve(world, spec.path)
    if value is _MISSING:
        return OracleResult("equals", False, f"{spec.path} missing")
    ok = value == spec.expected
    return OracleResult(
        "equals", ok, f"{spec.path}={value!r} expected={spec.expected!r}"
    )


@register("contains")
def _contains(spec: OracleSpec, world: dict[str, Any]) -> OracleResult:
    value = _resolve(world, spec.path)
    if value is _MISSING:
        return OracleResult("contains", False, f"{spec.path} missing")
    try:
        ok = spec.value in value
    except TypeError:
        ok = False
    return OracleResult("contains", ok, f"{spec.value!r} in {spec.path}={value!r}")


def evaluate(spec: OracleSpec, world: dict[str, Any]) -> OracleResult:
    fn = ORACLES.get(spec.type)
    if fn is None:
        return OracleResult(spec.type, False, f"unknown oracle type {spec.type!r}")
    return fn(spec, world)


def evaluate_all(
    specs: list[OracleSpec], world: dict[str, Any]
) -> list[OracleResult]:
    return [evaluate(s, world) for s in specs]
