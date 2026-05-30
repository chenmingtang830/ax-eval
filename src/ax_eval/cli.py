"""``ax-eval`` command-line entrypoint.

Subcommands:
  run             run a target pack across harnesses (keyless by default)
  report          render a saved JSON result file
  list-harnesses  show registered harnesses
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__
from .config import load_dotenv, load_pack
from .harnesses import available_harnesses
from .reporting import render
from .runner import run as run_pack
from .storage import load_report, save_report

_DEFAULT_PACK = Path(__file__).resolve().parents[2] / "packs" / "asana.yaml"


def _cmd_run(args: argparse.Namespace) -> int:
    load_dotenv()
    pack = load_pack(args.pack)
    harnesses = args.harness or ["mock", "mock-weak", "hermes"]
    print(
        f"Running {len(pack.tasks)} tasks x {len(harnesses)} harnesses "
        f"on {pack.name} v{pack.version}\n"
    )
    report = run_pack(pack, harnesses, progress=True)
    out = Path(args.out)
    save_report(report, out)
    print(f"\nSaved results -> {out}\n")
    print(render(load_report(out)))
    return 0


def _cmd_report(args: argparse.Namespace) -> int:
    print(render(load_report(args.results)))
    return 0


def _cmd_list(_: argparse.Namespace) -> int:
    print("Registered harnesses:")
    for name in available_harnesses():
        print(f"  {name}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="ax-eval", description="AX eval runner")
    p.add_argument("--version", action="version", version=f"ax-eval {__version__}")
    sub = p.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="run a target pack across harnesses")
    run.add_argument("--pack", default=str(_DEFAULT_PACK), help="target pack YAML")
    run.add_argument(
        "--harness",
        action="append",
        help="harness name (repeatable); default: mock, mock-weak, hermes",
    )
    run.add_argument("--out", default="results/last-run.json", help="results JSON path")
    run.set_defaults(func=_cmd_run)

    rep = sub.add_parser("report", help="render a saved results file")
    rep.add_argument("results", help="path to a results JSON file")
    rep.set_defaults(func=_cmd_report)

    lst = sub.add_parser("list-harnesses", help="list registered harnesses")
    lst.set_defaults(func=_cmd_list)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
