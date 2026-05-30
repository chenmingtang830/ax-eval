from conftest import PACK

from ax_eval.config import load_pack
from ax_eval.reporting import render
from ax_eval.runner import run
from ax_eval.storage import load_report, save_report


def test_render_contains_matrix_and_rates(tmp_path):
    pack = load_pack(PACK)
    report = run(pack, ["mock", "mock-weak", "hermes"])
    out = save_report(report, tmp_path / "r.json")
    text = render(load_report(out))
    assert "asana" in text
    assert "Pass rate by harness" in text
    assert "PASS" in text and "FAIL" in text
    assert "mock-weak" in text


def test_save_and_load_roundtrip(tmp_path):
    pack = load_pack(PACK)
    report = run(pack, ["mock"])
    out = save_report(report, tmp_path / "r.json")
    payload = load_report(out)
    assert payload["pack"] == "asana"
    assert len(payload["results"]) == len(pack.tasks)
