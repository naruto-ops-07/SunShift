"""Uncoordinated baseline — port of web/src/engine/baseline.ts (same assumptions, same seed)."""

from __future__ import annotations

from .prng import hash_string, mulberry32
from .roster import SLOT_COUNT, SLOT_HOURS, feeder, hour_to_slot, js_round
from .timeutil import diff_days


def habit_irrigates_today(f: dict, date: str, rain_yesterday: float) -> bool:
    if f["stage"]["index"] in (-1, 4) or rain_yesterday > 10:
        return False
    k = max(1, f["spec"]["habit"]["everyDays"])
    return ((diff_days(date, "2026-01-01") + f["spec"]["habit"]["phase"]) % k) == 0


def simulate_baseline(farms: list[dict], date: str, feeder_limit_kw: float, rain_yesterday: float, seed_key: str = "", habit_scale: float = 1.0) -> dict:
    T = SLOT_COUNT
    rand = mulberry32(hash_string(f"baseline:{seed_key}:{date}"))
    want_start, want_end = [], []
    for f in farms:
        if not habit_irrigates_today(f, date, rain_yesterday):
            want_start.append(-1)
            want_end.append(-1)
            continue
        jitter = js_round((rand() - 0.5) * 4)
        s = max(0, min(T - 1, hour_to_slot(f["spec"]["habit"]["start"]) + jitter))
        L = js_round(f["spec"]["habit"]["hours"] * habit_scale / SLOT_HOURS)
        want_start.append(s)
        want_end.append(min(T, s + L))
    on = [[False] * T for _ in farms]
    load, attempted, trips = [0.0] * T, [0.0] * T, [False] * T
    connected = [True] * len(farms)
    lockout = 0
    for t in range(T):
        if lockout > 0:
            lockout -= 1
            continue
        for i in range(len(farms)):
            if not connected[i] and rand() < 0.7:
                connected[i] = True
        active = [i for i in range(len(farms)) if want_start[i] >= 0 and want_start[i] <= t < want_end[i] and connected[i]]
        total = sum(farms[i]["pumpKw"] for i in active)
        attempted[t] = total
        if total > feeder_limit_kw:
            trips[t] = True
            lockout = feeder()["tripLockoutSlots"]
            connected = [False] * len(farms)
            continue
        load[t] = total
        for i in active:
            on[i][t] = True
    schedules = []
    for i, f in enumerate(farms):
        n = sum(on[i])
        req = want_end[i] - want_start[i] if want_start[i] >= 0 else 0
        schedules.append(
            {
                "id": f["id"],
                "start": want_start[i],
                "length": n,
                "requested": req,
                "fulfilment": n / req if req else 0,
                "waterM3": n * f["flowM3h"] * SLOT_HOURS,
                "energyKwh": n * f["pumpKw"] * SLOT_HOURS,
            }
        )
    return {"kind": "baseline", "schedules": schedules, "on": on, "load": load, "attemptedLoad": attempted, "trips": trips, "solver": None}

