import sys
from pathlib import Path

# Make the src/ layout importable without an install step.
SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

PACK = Path(__file__).resolve().parents[1] / "packs" / "asana.yaml"
