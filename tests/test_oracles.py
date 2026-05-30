from ax_eval.datatypes import OracleSpec
from ax_eval.oracles import evaluate


def test_exists_pass_and_fail():
    world = {"task": {"gid": "123"}}
    assert evaluate(OracleSpec("exists", path="task.gid"), world).passed
    assert not evaluate(OracleSpec("exists", path="task.missing"), world).passed


def test_equals():
    world = {"task": {"due_on": "2026-06-05"}}
    assert evaluate(OracleSpec("equals", path="task.due_on", expected="2026-06-05"), world).passed
    assert not evaluate(OracleSpec("equals", path="task.due_on", expected="2026-01-01"), world).passed


def test_equals_missing_path_fails():
    assert not evaluate(OracleSpec("equals", path="task.x", expected=1), {}).passed


def test_contains():
    world = {"task": {"stories": ["hello world"]}}
    assert evaluate(OracleSpec("contains", path="task.stories", value="hello world"), world).passed
    assert not evaluate(OracleSpec("contains", path="task.stories", value="nope"), world).passed


def test_unknown_oracle_type_fails_gracefully():
    res = evaluate(OracleSpec("does-not-exist", path="x"), {"x": 1})
    assert not res.passed
    assert "unknown" in res.detail
