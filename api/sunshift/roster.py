"""The shared demonstration feeder (../shared/feeder07.json), identical to the web engine's."""

from __future__ import annotations

import json
import math
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

_DEFAULT = Path(__file__).resolve().parents[2] / "shared" / "feeder07.json"


@lru_cache(maxsize=1)
def roster() -> dict[str, Any]:
    path = Path(os.environ.get("SUNSHIFT_ROSTER", _DEFAULT))
    with path.open(encoding="utf-8") as fh:
        return json.load(fh)


def feeder() -> dict[str, Any]:
    return roster()["feeder"]


def location(loc_id: str) -> dict[str, Any]:
    for loc in roster()["locations"]:
        if loc["id"] == loc_id:
            return loc
    return roster()["locations"][0]


SLOT_COUNT = 48
SLOT_HOURS = 0.25
START_HOUR = 6


def slot_label(t: int) -> str:
    mins = START_HOUR * 60 + t * 15
    return f"{mins // 60:02d}:{mins % 60:02d}"


def hour_to_slot(h: float) -> int:
    return js_round((h - START_HOUR) / SLOT_HOURS)


def js_round(x: float) -> int:
    """JavaScript Math.round semantics (half rounds toward +inf), so both engines agree."""
    return math.floor(x + 0.5)


def pump_kw(hp: float) -> float:
    eta = roster()["pump"]["motorEfficiency"].get(_hp_key(hp), 0.83)
    return hp * 0.746 / eta


def pump_flow_m3h(hp: float, head_m: float) -> float:
    shaft_w = hp * 746
    hydraulic_w = roster()["pump"]["pumpEfficiency"] * shaft_w
    return hydraulic_w / (1000 * 9.81 * head_m) * 3600


def _hp_key(hp: float) -> str:
    return str(int(hp)) if float(hp).is_integer() else str(hp)


def farm_code(fid: int) -> str:
    return f"Farm {fid:02d}"
