"""Day metrics — port of web/src/engine/metrics.ts."""

from __future__ import annotations

from .roster import SLOT_HOURS


def jain(xs: list[float]) -> float:
    if not xs:
        return 1.0
    s, s2 = sum(xs), sum(x * x for x in xs)
    return s * s / (len(xs) * s2) if s2 > 0 else 1.0


def farm_water(f: dict, slots: int) -> dict:
    pumped = slots * f["flowM3h"] * SLOT_HOURS
    net_mm = pumped * f["efficiency"] / (f["spec"]["areaHa"] * 10)
    room = max(0.0, f["projectedDepletion"])
    ben_mm = min(net_mm, room)
    ben = ben_mm * f["spec"]["areaHa"] * 10 / f["efficiency"]
    return {"pumped": pumped, "beneficialGross": ben, "lost": max(0.0, pumped - ben)}


def day_metrics(plan: dict, farms: list[dict], solar: dict, feeder_limit_kw: float) -> dict:
    pumped = beneficial = lost = need = delivered = 0.0
    fulfil, per_farm, served = [], {}, 0
    for i, f in enumerate(farms):
        w = farm_water(f, sum(plan["on"][i]))
        pumped += w["pumped"]
        beneficial += w["beneficialGross"]
        lost += w["lost"]
        if f["requestM3"] > 0:
            need += f["requestM3"]
            ff = min(1.0, w["beneficialGross"] / f["requestM3"])
            delivered += min(f["requestM3"], w["beneficialGross"])
            fulfil.append(ff)
            per_farm[f["id"]] = ff
            served += 1 if ff >= 0.9 else 0
    energy = solar_used = grid = spill = solar_e = 0.0
    overload = 0
    for t, l in enumerate(plan["load"]):
        pv = solar["slots"][t]["acKw"]
        energy += l * SLOT_HOURS
        solar_used += min(l, pv) * SLOT_HOURS
        grid += max(0.0, l - pv) * SLOT_HOURS
        spill += max(0.0, pv - l) * SLOT_HOURS
        solar_e += pv * SLOT_HOURS
        overload += 1 if plan["attemptedLoad"][t] > feeder_limit_kw + 1e-6 else 0
    return {
        "waterPumpedM3": pumped,
        "waterBeneficialM3": beneficial,
        "waterLostM3": lost,
        "energyKwh": energy,
        "solarUsedKwh": solar_used,
        "gridImportKwh": grid,
        "solarSpillKwh": spill,
        "solarEnergyKwh": solar_e,
        "peakKw": max([0.0, *plan["attemptedLoad"]]),
        "overloadSlots": overload,
        "trips": sum(plan["trips"]),
        "needM3": need,
        "fulfilment": delivered / need if need > 0 else 1.0,
        "solarShare": solar_used / energy if energy > 0 else 1.0,
        "solarAbsorbed": solar_used / solar_e if solar_e > 0 else 0.0,
        "jain": jain(fulfil),
        "minFulfilment": min(fulfil) if fulfil else 1.0,
        "farmsNeeding": len(fulfil),
        "farmsServed": served,
        "farmFulfilment": per_farm,
    }
