from conftest import PACK

from ax_eval.config import load_pack
from ax_eval.runner import run


def test_mock_competent_passes_everything():
    pack = load_pack(PACK)
    report = run(pack, ["mock"])
    assert len(report.results) == len(pack.tasks)
    assert all(r.success for r in report.results)
    assert report.pass_rate("mock") == 1.0


def test_mock_weak_fails_some():
    pack = load_pack(PACK)
    report = run(pack, ["mock-weak"])
    rate = report.pass_rate("mock-weak")
    assert 0.0 < rate < 1.0


def test_matrix_shape_and_differing_rates():
    pack = load_pack(PACK)
    report = run(pack, ["mock", "mock-weak", "hermes"])
    matrix = report.matrix()
    assert set(matrix) == {t.id for t in pack.tasks}
    for row in matrix.values():
        assert set(row) == {"mock", "mock-weak", "hermes"}
    # The whole point of the demo: harnesses succeed at different rates.
    assert report.pass_rate("mock") > report.pass_rate("mock-weak")


def test_results_carry_traces():
    pack = load_pack(PACK)
    report = run(pack, ["hermes"])
    assert all(r.trace for r in report.results)
    assert any("stub" in line for r in report.results for line in r.trace)
