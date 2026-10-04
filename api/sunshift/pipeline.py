"""Server pipeline: weather → pvlib PV → FAO-56 → demand → CP-SAT → baseline → metrics.
Returns the same JSON shape as the web engine's PipelineResult."""

from __future__ import annotations

from datetime import datetime, timezone

from .baseline import simulate_baseline
from .demand import build_problem, compute_farm_days
from .heuristic import warm_start
from .metrics import day_metrics
from .model import evaluate, to_int_model
from .optimiser import solve_cpsat
from .roster import SLOT_COUNT, SLOT_HOURS, feeder, roster
from .solar import capacity_profile, compute_solar_day, plant
from .timeutil import today_local
from .weather import weather_for


def default_scenario(date: str | None = None) -> dict:
    f = feeder()
    return {
        "date": date or today_local(),
        "locationId": roster()["locations"][0]["id"],
        "solarKwp": f["solar"]["dcKwp"],
        "inverterKw": f["solar"]["acKw"],
        "feederLimitKw": f["feederLimitKw"],
        "gridAllowanceKw": f["gridAllowanceKw"],
        "forecastReserve": f["forecastReserve"],
        "demandScale": 1.0,
        "fairnessWeight": 40,
        "rainOverrideMm": None,
        "cloudEvent": None,
        "farmOverrides": {},
        "carryOver": {},
        "baselineHabitScale": 1.0,
    }


def plan_from_solution(m, start: list[int], length: list[int], farms: list[dict], solver: dict | None) -> dict:
    on = [[False] * SLOT_COUNT for _ in farms]
    load = [0.0] * SLOT_COUNT
    pos = {fid: i for i, fid in enumerate(m.ids)}
    schedules = []
    for fi, f in enumerate(farms):
        i = pos.get(f["id"])
        s = start[i] if i is not None else -1
        L = length[i] if i is not None else 0
        for t in range(s, s + L) if L > 0 else []:
            on[fi][t] = True
            load[t] += f["pumpKw"]
        schedules.append(
            {
                "id": f["id"],
                "start": s if L > 0 else -1,
                "length": L,
                "requested": f["requestedSlots"],
                "fulfilment": L / f["requestedSlots"] if f["requestedSlots"] else 0,
                "waterM3": L * f["flowM3h"] * SLOT_HOURS,
                "energyKwh": L * f["pumpKw"] * SLOT_HOURS,
            }
        )
    return {"kind": "sunshift", "schedules": schedules, "on": on, "load": load, "attemptedLoad": list(load), "trips": [False] * SLOT_COUNT, "solver": solver}


def explain(farms: list[dict], plan: dict, solar_ac: list[float], cap: list[float]) -> list[dict]:
    peak_pv = max([1e-6, *solar_ac])
    out = []
    for i, f in enumerate(farms):
        sch = plan["schedules"][i]
        factors = [x for x in f["factors"] if x["key"] not in ("solar", "feeder")]
        if sch["length"] > 0:
            rng = range(sch["start"], sch["start"] + sch["length"])
            pv = sum(solar_ac[t] for t in rng) / sch["length"]
            head = sum(cap[t] - plan["load"][t] for t in rng) / sch["length"]
            rel = pv / peak_pv
            factors.append({"key": "solar", "label": "Solar availability", "value": f"{pv:.0f} kW avg in window", "level": "HIGH" if rel >= 0.7 else "MEDIUM" if rel >= 0.4 else "LOW", "contribution": 0})
            factors.append({"key": "feeder", "label": "Feeder capacity", "value": f"{head:.1f} kW spare in window", "level": "AVAILABLE" if head >= f["pumpKw"] * 0.5 else "LIMITED", "contribution": 0})
        elif f["requestedSlots"] > 0:
            factors.append({"key": "feeder", "label": "Feeder capacity", "value": "No room in window today", "level": "LIMITED", "contribution": 0})
        out.append({**f, "factors": factors})
    return out


def optimise_problem(problem: dict, hint: dict | None = None, time_limit: float = 5.0) -> tuple[dict, dict]:
    """Solve a Problem with CP-SAT. Returns (solution, solver-info)."""
    m = to_int_model(problem)
    if hint and len(hint.get("start", [])) == m.F:
        hs, hl = list(hint["start"]), list(hint["length"])
        if not evaluate(m, hs, hl).feasible:
            hs, hl = warm_start(m)
    else:
        hs, hl = warm_start(m)
    r = solve_cpsat(m, hint=(hs, hl), time_limit=time_limit)
    if r.status not in ("OPTIMAL", "FEASIBLE"):
        ev = evaluate(m, hs, hl)
        start, length, status, obj = hs, hl, "FEASIBLE" if ev.feasible else "ERROR", float(ev.objective)
    else:
        start, length, status, obj = r.start, r.length, r.status, r.objective
    info = {
        "name": "cp-sat",
        "label": "OR-Tools CP-SAT",
        "status": status,
        "objective": obj,
        "bound": r.bound,
        "gap": r.gap,
        "timeMs": r.time_ms,
        "variables": r.variables,
        "constraints": r.constraints,
        "where": "server",
        "note": f"8 workers · warm-started (hint objective {r.hint_objective})" if r.hint_objective is not None else "8 workers",
    }
    return {"start": start, "length": length, "ids": m.ids}, info


def run_pipeline(scn: dict, weather: dict | None = None, time_limit: float = 5.0) -> dict:
    weather = weather or weather_for(scn["locationId"], scn["date"])
    daily = weather["daily"]
    idx = next((i for i, d in enumerate(daily) if d["date"] == scn["date"]), -1)
    if idx < 0:
        raise ValueError(f"weather does not cover {scn['date']}")
    today = dict(daily[idx])
    if scn.get("rainOverrideMm") is not None:
        today["precip"] = float(scn["rainOverrideMm"])
        today["precipProb"] = max(today["precipProb"], 90)
    tomorrow = daily[idx + 1] if idx + 1 < len(daily) else None
    y1 = daily[idx - 1]["precip"] if idx >= 1 else 0.0
    y2 = daily[idx - 2]["precip"] if idx >= 2 else 0.0
    solar = compute_solar_day(weather, scn["date"], plant(scn), scn.get("cloudEvent"))
    cap = capacity_profile(solar, scn)
    farms0 = compute_farm_days(scn, scn["date"], today, tomorrow, (y1, y2))
    solar_ac = [s["acKw"] for s in solar["slots"]]
    problem = build_problem(farms0, cap, solar_ac, scn)
    m = to_int_model(problem)
    sol, info = optimise_problem(problem, None, time_limit)
    plan = plan_from_solution(m, sol["start"], sol["length"], farms0, info)
    farms = explain(farms0, plan, solar_ac, cap)
    baseline = simulate_baseline(farms, scn["date"], scn["feederLimitKw"], y1, scn["locationId"], scn.get("baselineHabitScale", 1.0))
    return {
        "scenario": scn,
        "weather": weather,
        "todayIndex": idx,
        "solar": solar,
        "capacity": cap,
        "farms": farms,
        "problem": problem,
        "plan": plan,
        "baseline": baseline,
        "metrics": {
            "sunshift": day_metrics(plan, farms, solar, scn["feederLimitKw"]),
            "baseline": day_metrics(baseline, farms, solar, scn["feederLimitKw"]),
        },
        "computedAt": datetime.now(timezone.utc).isoformat(),
        "engine": "server",
    }
