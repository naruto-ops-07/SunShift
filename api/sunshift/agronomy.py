"""FAO-56 agronomy — Penman–Monteith ET0, crop coefficients, root-zone water balance.
Port of web/src/engine/agronomy.ts (Allen et al., 1998)."""

from __future__ import annotations

import math
from dataclasses import dataclass

from .roster import roster

SIGMA = 4.903e-9
GSC = 0.082


def sat_vp(t: float) -> float:
    return 0.6108 * math.exp(17.27 * t / (t + 237.3))


def slope_svp(t: float) -> float:
    return 4098 * sat_vp(t) / (t + 237.3) ** 2


def psychrometric(elevation: float) -> float:
    P = 101.3 * ((293 - 0.0065 * elevation) / 293) ** 5.26
    return 0.000665 * P


def ra_daily(lat: float, doy: int) -> float:
    phi = math.radians(lat)
    dr = 1 + 0.033 * math.cos(2 * math.pi * doy / 365)
    delta = 0.409 * math.sin(2 * math.pi * doy / 365 - 1.39)
    ws = math.acos(min(1, max(-1, -math.tan(phi) * math.tan(delta))))
    return 24 * 60 / math.pi * GSC * dr * (ws * math.sin(phi) * math.sin(delta) + math.cos(phi) * math.cos(delta) * math.sin(ws))


def et0_daily(d: dict, lat: float, elevation: float, doy: int) -> dict:
    """FAO-56 eq. 6 with G = 0. Returns ET0 and its radiation/aerodynamic split."""
    tmean = (d["tmax"] + d["tmin"]) / 2
    delta = slope_svp(tmean)
    gamma = psychrometric(elevation)
    es = (sat_vp(d["tmax"]) + sat_vp(d["tmin"])) / 2
    ea = (sat_vp(d["tmin"]) * d["rhMax"] / 100 + sat_vp(d["tmax"]) * d["rhMin"] / 100) / 2
    ra = ra_daily(lat, doy)
    rso = (0.75 + 2e-5 * elevation) * ra
    rs = min(d["rsMJ"], rso)
    rns = 0.77 * rs
    tk4 = ((d["tmax"] + 273.16) ** 4 + (d["tmin"] + 273.16) ** 4) / 2
    ratio = min(1, rs / rso) if rso > 0 else 0.5
    rnl = SIGMA * tk4 * (0.34 - 0.14 * math.sqrt(max(ea, 0))) * (1.35 * ratio - 0.35)
    rn = rns - rnl
    u2 = max(0.5, d["wind2"])
    denom = delta + gamma * (1 + 0.34 * u2)
    rad = 0.408 * delta * rn / denom
    aero = gamma * (900 / (tmean + 273)) * u2 * (es - ea) / denom
    return {"et0": max(0.0, rad + aero), "radiationTerm": rad, "aeroTerm": aero, "rn": rn, "es": es, "ea": ea, "u2": u2}


def crop(cid: str) -> dict:
    return roster()["crops"][cid]


def adjust_kc(kc: float, u2: float, rh_min: float, height: float) -> float:
    if kc < 0.45:
        return kc
    return kc + (0.04 * (u2 - 2) - 0.004 * (rh_min - 45)) * (height / 3) ** 0.3


@dataclass
class Stage:
    index: int
    label: str
    crop_day: int
    kc: float
    root_depth: float
    sensitivity: float

    def to_json(self) -> dict:
        return {"index": self.index, "label": self.label, "cropDay": self.crop_day, "kc": self.kc, "rootDepth": self.root_depth, "sensitivity": self.sensitivity}


def stage_info(cid: str, crop_day: int, u2: float | None = None, rh_min: float | None = None) -> Stage:
    c = crop(cid)
    Lini, Ldev, Lmid, Llate = c["stageDays"]
    total = Lini + Ldev + Lmid + Llate
    if crop_day < 0:
        return Stage(-1, "Not sown", crop_day, 0, 0, 0)
    if crop_day >= total:
        return Stage(4, "Harvested", crop_day, 0, 0, 0)
    kc_mid = adjust_kc(c["kcMid"], u2, rh_min, c["heightM"]) if u2 is not None else c["kcMid"]
    kc_end = adjust_kc(c["kcEnd"], u2, rh_min, c["heightM"]) if u2 is not None else c["kcEnd"]
    if crop_day < Lini:
        kc, idx = c["kcIni"], 0
    elif crop_day < Lini + Ldev:
        kc, idx = c["kcIni"] + (crop_day - Lini) / Ldev * (kc_mid - c["kcIni"]), 1
    elif crop_day < Lini + Ldev + Lmid:
        kc, idx = kc_mid, 2
    else:
        kc, idx = kc_mid + (crop_day - Lini - Ldev - Lmid) / Llate * (kc_end - kc_mid), 3
    frac = min(1, crop_day / (Lini + Ldev))
    return Stage(idx, c["stageLabels"][idx], crop_day, kc, c["rootMin"] + (c["rootMax"] - c["rootMin"]) * frac, c["stageSensitivity"][idx])


def taw(soil: str, root_depth: float) -> float:
    s = roster()["soils"][soil]
    return 1000 * (s["thetaFC"] - s["thetaWP"]) * root_depth


def adjusted_p(cid: str, etc: float) -> float:
    return min(0.8, max(0.1, crop(cid)["p"] + 0.04 * (5 - etc)))


def ks(dr: float, taw_mm: float, raw_mm: float) -> float:
    if dr <= raw_mm:
        return 1.0
    return max(0.0, (taw_mm - dr) / max(1e-6, taw_mm - raw_mm))


def effective_rain(p: float) -> float:
    if p < 2:
        return 0.0
    if p <= 25:
        return 0.9 * p
    if p <= 50:
        return 22.5 + 0.75 * (p - 25)
    return 41.25 + 0.55 * (p - 50)


def balance_step(dr_start: float, taw_mm: float, raw_mm: float, etc: float, rain: float, net_irr: float) -> dict:
    k = ks(dr_start, taw_mm, raw_mm)
    etc_adj = k * etc
    pe = effective_rain(rain)
    dr = dr_start - pe - net_irr + etc_adj
    dp = 0.0
    if dr < 0:
        dp, dr = -dr, 0.0
    dr = min(dr, taw_mm)
    room = max(0.0, dr_start + etc_adj - pe)
    return {"drEnd": dr, "deepPercolation": dp, "ks": k, "etcAdj": etc_adj, "beneficialIrrigationMm": min(net_irr, room)}
