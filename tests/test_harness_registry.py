import pytest

from ax_eval.harnesses import available_harnesses, get_harness
from ax_eval.harnesses.hermes import HermesHarness


def test_keyless_harnesses_registered():
    names = available_harnesses()
    for expected in ("mock", "mock-weak", "hermes"):
        assert expected in names


def test_get_unknown_harness_raises():
    with pytest.raises(KeyError):
        get_harness("nope")


def test_get_returns_fresh_instances():
    a = get_harness("mock")
    b = get_harness("mock")
    assert a is not b


def test_hermes_is_keyless_stub():
    h = get_harness("hermes")
    assert isinstance(h, HermesHarness)
    assert h.requires_key is False
    assert getattr(h, "is_stub", False) is True
