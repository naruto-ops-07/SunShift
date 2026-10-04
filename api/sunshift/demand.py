"""Farm demand and explainable priority — port of web/src/engine/demand.ts."""

from __future__ import annotations

import math

from . import agronomy as ag
from .roster import SLOT_COUNT, SLOT_HOURS, farm_code, feeder, hour_to_slot, js_round, location, pump_flow_m3h, pump_kw, roster
from .timeutil import day_of_year, diff_days

TRIGGER = {"drip": 0.35, "sprinkler": 0.7, "furrow": 0.85}
MAX_EVENT_NET_MM = {"drip": 25, "sprinkler": 40, "furrow": 60}


def expected_rain(d: dict | None) -> float:
    if not d:
        return 0.0
    return d["precip"] * min(1.0, max(0.15, d["precipProb"] / 100))


def _level(v: float, hi: float, mid: float) -> str:
    return "HIGH" if v >= hi else "MEDIUM" if v >= mid else "LOW"


def apply_overrides(spec: dict, scn: dict) -> dict:
    o = dict(scn.get("farmOverrides", {}).get(str(spec["id"]), scn.get("farmOverrides", {}).get(spec["id"], {})) or {})
    ds = o.pop("demandScale", 1)
    return {**spec, **o, "demandScale": ds}


def compute_farm_days(scn: dict, date: str, today: dict, tomorrow: dict | None, recent_rain: tuple[float, float] = (0, 0), depletion: dict | None = None) -> list[dict]:
    loc = location(scn["locationId"])
    et = ag.et0_daily(today, loc["lat"], loc["elevation"], day_of_year(date))
    r24 = expected_rain(today)
    r48 = r24 + 0.6 * expected_rain(tomorrow)
    max_prob = max(today["precipProb"], tomorrow["precipProb"] if tomorrow else 0) / 100
    out = []
    for base in roster()["farms"]:
        spec = apply_overrides(base, scn)
        crop = roster()["crops"][spec["crop"]]
        crop_day = spec["sowingDaysAgo"] + diff_days(date, scn["date"])
        st = ag.stage_info(spec["crop"], crop_day, today["wind2"], today["rhMin"])
        taw = ag.taw(spec["soil"], st.root_depth) if st.root_depth > 0 else 0.0
        scale = scn["demandScale"] * spec.get("demandScale", 1)
        etc = st.kc * et["et0"] * scale
        p = ag.adjusted_p(spec["crop"], etc)
        raw = p * taw
        eff = roster()["irrigationMethods"][spec["method"]]["efficiency"]
        kw = pump_kw(spec["pumpHp"])
        q = pump_flow_m3h(spec["pumpHp"], spec["headM"])
        dr = (depletion or {}).get(spec["id"])
        if dr is None:
            y1, y2 = recent_rain
            dr = max(0.0, spec["initDepletion"] * taw - ag.effective_rain(y1) - 0.5 * ag.effective_rain(y2))
        dr = min(dr, taw)
        projected = dr + etc - ag.effective_rain(r24)
        rain_buffer = ag.effective_rain(r48) - ag.effective_rain(r24)
        carry = min(1.0, max(0.0, float(scn.get("carryOver", {}).get(str(spec["id"]), scn.get("carryOver", {}).get(spec["id"], 0)))))
        ws = max(0, hour_to_slot(spec["window"][0]))
        we = min(SLOT_COUNT, hour_to_slot(spec["window"][1]))
        max_slots = max(0, min(js_round(spec["maxHours"] / SLOT_HOURS), we - ws))
        decision, reason, net = "irrigate", "", 0.0
        trig = TRIGGER[spec["method"]] * raw
        if st.index in (-1, 4):
            decision = "fallow"
            reason = "Not sown yet — no crop water requirement." if st.index == -1 else "Crop harvested — no irrigation needed."
        elif dr + etc < trig:
            decision = "sufficient"
            reserve = max(0.0, raw - projected)
            days = max(1, math.floor(reserve / etc)) if etc > 0 else 9
            reason = f"Root zone holds {reserve:.0f} mm before stress — irrigation not needed today (≈{days} d of reserve)."
        elif projected - rain_buffer < trig:
            decision = "rain"
            reason = f"Rain forecast ({today['precip'] + (tomorrow['precip'] if tomorrow else 0):.0f} mm over 48 h) covers the need — skip and save water."
        else:
            net = max(0.0, projected - max(0.0, rain_buffer))
        net = min(net, MAX_EVENT_NET_MM[spec["method"]])
        gross = net * spec["areaHa"] * 10 / eff if decision == "irrigate" else 0.0
        requested = math.ceil(gross / (q * SLOT_HOURS) - 1e-9) if decision == "irrigate" else 0
        if requested > 0:
            requested = max(feeder()["minRunSlots"], min(max_slots, requested))
        if decision == "irrigate" and requested == 0:
            decision, reason = "sufficient", "Need is below one pump run — deferred to a later day."
        stress = min(1.0, max(0.0, (projected / max(raw, 1e-6) - 0.6) / 0.8))
        w_soil, w_stage, w_carry, w_rain = 2.0 * stress, 1.0 * st.sensitivity, 1.5 * carry, -0.6 * max_prob
        priority = max(0.3, 1 + w_soil + w_stage + w_carry + w_rain)
        factors = [
            {"key": "soil", "label": "Soil stress", "value": f"{projected:.0f} / {raw:.0f} mm RAW", "level": _level(stress, 0.6, 0.25), "contribution": w_soil},
            {"key": "stage", "label": "Crop stage", "value": st.label, "level": _level(st.sensitivity, 0.9, 0.6), "contribution": w_stage},
            {"key": "rain", "label": "Rain probability", "value": f"{js_round(max_prob * 100)} % · {r48:.1f} mm expected", "level": _level(max_prob, 0.6, 0.3), "contribution": w_rain},
            {"key": "carry", "label": "Unmet yesterday", "value": f"{js_round(carry * 100)} %", "level": _level(carry, 0.35, 0.1), "contribution": w_carry},
        ]
        if decision == "irrigate" and not reason:
            parts = ["High water need" if stress >= 0.6 else "Moderate water need" if stress >= 0.25 else "Top-up need"]
            if st.sensitivity >= 0.9:
                parts.append(f"{st.label.lower()} stage")
            if max_prob < 0.3:
                parts.append("no rain expected")
            if carry >= 0.1:
                parts.append(f"short {js_round(carry * 100)} % yesterday")
            reason = " + ".join(parts)
        out.append(
            {
                "id": spec["id"],
                "code": farm_code(spec["id"]),
                "spec": spec,
                "cropLabel": crop["label"],
                "soilLabel": roster()["soils"][spec["soil"]]["label"],
                "methodLabel": roster()["irrigationMethods"][spec["method"]]["label"],
                "stage": st.to_json(),
                "pumpKw": kw,
                "flowM3h": q,
                "efficiency": eff,
                "taw": taw,
                "raw": raw,
                "depletionStart": dr,
                "et0": et["et0"],
                "etc": etc,
                "rainForecast24": r24,
                "rainForecast48": r48,
                "projectedDepletion": projected,
                "netNeedMm": net,
                "grossNeedM3": gross,
                "requestM3": min(gross, requested * q * SLOT_HOURS),
                "requestedSlots": requested,
                "decision": decision,
                "reason": reason,
                "priority": priority,
                "priorityLevel": "HIGH" if priority >= 3.2 else "MEDIUM" if priority >= 2.2 else "LOW",
                "factors": factors,
                "soilStatusPct": max(0.0, min(100.0, (taw - dr) / taw * 100)) if taw > 0 else 0.0,
            }
        )
    return out


def build_problem(farms: list[dict], cap: list[float], solar_ac: list[float], scn: dict) -> dict:
    return {
        "T": SLOT_COUNT,
        "slotHours": SLOT_HOURS,
        "cap": cap,
        "solar": solar_ac,
        "fairnessWeight": scn["fairnessWeight"],
        "farms": [
            {
                "id": f["id"],
                "powerKw": f["pumpKw"],
                "requested": f["requestedSlots"],
                "minRun": feeder()["minRunSlots"],
                "windowStart": max(0, hour_to_slot(f["spec"]["window"][0])),
                "windowEnd": min(SLOT_COUNT, hour_to_slot(f["spec"]["window"][1])),
                "weight": f["priority"],
            }
            for f in farms
            if f["requestedSlots"] > 0
        ],
    }
