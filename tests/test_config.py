import os

from conftest import PACK

from ax_eval.config import load_dotenv, load_pack


def test_load_pack_parses_asana():
    pack = load_pack(PACK)
    assert pack.name == "asana"
    assert len(pack.tasks) == 8
    assert pack.tasks[0].oracles  # tasks carry oracle specs


def test_load_dotenv_missing_file_is_ok(tmp_path):
    assert load_dotenv(tmp_path / "nope.env") == {}


def test_load_dotenv_parses_and_sets_env(tmp_path, monkeypatch):
    p = tmp_path / ".env"
    p.write_text('# comment\nFOO=bar\nQUOTED="baz"\n\nNOEQUALS\n')
    monkeypatch.delenv("FOO", raising=False)
    monkeypatch.delenv("QUOTED", raising=False)
    loaded = load_dotenv(p)
    assert loaded == {"FOO": "bar", "QUOTED": "baz"}
    assert os.environ["FOO"] == "bar"
