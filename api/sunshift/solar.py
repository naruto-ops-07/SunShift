"""PV model with pvlib: Ineichen clear sky · clear-sky-index interpolation of hourly forecast
GHI · Erbs decomposition · Hay–Davies transposition · ASHRAE IAM · Faiman cell temperature ·
PVWatts DC and inverter. Runs on the same 15-minute grid as the optimiser."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pvlib

from .roster import SLOT_COUNT, SLOT_HOURS, START_HOUR, feeder, location, slot_label
from .timeutil import add_days, month_index


def plant(scn: dict) -> dict:
    p = dict(feeder()["solar"])
    p["dcKwp"] = scn["solarKwp"]
    p["acKw"] = scn["inverterKw"]
    return p


def compute_solar_day(weather: dict, date: str, pl: dict, cloud_event: dict | None = None) -> dict:
    loc = location(weather["locationId"])
    site = pvlib.location.Location(loc["lat"], loc["lon"], tz=loc["timezone"], altitude=loc["elevation"])
    linke = loc["linkeTurbidity"][month_index(date)]
    # Slot centres, local time.
    centres = pd.date_range(f"{date} {START_HOUR:02d}:07:30", periods=SLOT_COUNT, freq="15min", tz=loc["timezone"])
    sp = site.get_solarposition(centres)
    cs = site.get_clearsky(centres, model="ineichen", linke_turbidity=linke, solar_position=sp)

    # Hourly clear-sky means to turn provider GHI into a clear-sky index per hour.
    h = weather["hourly"]
    stamp = {t: i for i, t in enumerate(h["time"])}

    def idx(hour_ending: int):
        key = f"{add_days(date, 1)}T00:00" if hour_ending >= 24 else f"{date}T{hour_ending:02d}:00"
        return stamp.get(key)

    sub = pd.date_range(f"{date} 04:07:30", f"{date} 20:52:30", freq="15min", tz=loc["timezone"])
    cs_sub = site.get_clearsky(sub, model="ineichen", linke_turbidity=linke)["ghi"]
    kt_hour: dict[int, float] = {}
    for he in range(5, 21):
        i = idx(he)
        if i is None:
            continue
        mask = (sub.hour == he - 1)
        cs_mean = float(cs_sub[mask].mean()) if mask.any() else 0.0
        g = h["ghi"][i]
        kt = g / cs_mean if cs_mean > 25 else 1 - 0.75 * h["cloud"][i] ** 3.4
        kt_hour[he] = min(1.15, max(0.0, kt))

    def interp(map_: dict[int, float], hc: float, fb: float) -> float:
        lo = int(np.floor(hc + 0.5))
        a, b = map_.get(lo), map_.get(lo + 1)
        w = hc + 0.5 - lo
        if a is not None and b is not None:
            return a * (1 - w) + b * w
        return a if a is not None else (b if b is not None else fb)

    def series(arr: list[float], hc: float, fb: float) -> float:
        lo = int(np.floor(hc + 0.5))
        ia, ib = idx(lo), idx(lo + 1)
        w = hc + 0.5 - lo
        if ia is not None and ib is not None:
            return arr[ia] * (1 - w) + arr[ib] * w
        if ia is not None:
            return arr[ia]
        if ib is not None:
            return arr[ib]
        return fb

    hcs = [START_HOUR + (t + 0.5) * SLOT_HOURS for t in range(SLOT_COUNT)]
    kts = []
    for hc in hcs:
        k = interp(kt_hour, hc, 0.8)
        if cloud_event and cloud_event["fromHour"] <= hc < cloud_event["toHour"]:
            k *= cloud_event["factor"]
        kts.append(k)
    ghi = pd.Series(np.maximum(0, np.array(kts) * cs["ghi"].to_numpy()), index=centres)
    dec = pvlib.irradiance.erbs(ghi, sp["apparent_zenith"], centres)
    dni_extra = pvlib.irradiance.get_extra_radiation(centres)
    poa = pvlib.irradiance.get_total_irradiance(
        pl["tiltDeg"], pl["azimuthDeg"], sp["apparent_zenith"], sp["azimuth"],
        dec["dni"], ghi, dec["dhi"], dni_extra=dni_extra, albedo=pl["albedo"], model="haydavies",
    )
    aoi = pvlib.irradiance.aoi(pl["tiltDeg"], pl["azimuthDeg"], sp["apparent_zenith"], sp["azimuth"])
    iam = pvlib.iam.ashrae(aoi, b=0.05)
    effective = (poa["poa_direct"] * iam + poa["poa_diffuse"]).clip(lower=0).fillna(0)
    temp_air = pd.Series([series(h["temp"], hc, 28) for hc in hcs], index=centres)
    wind = pd.Series([series(h["wind10"], hc, 2) * 0.75 for hc in hcs], index=centres)
    tcell = pvlib.temperature.faiman(poa["poa_global"].fillna(0), temp_air, wind)
    pdc = pvlib.pvsystem.pvwatts_dc(effective, tcell, pl["dcKwp"] * 1000, pl["gammaPdc"]) * (1 - pl["systemLosses"])
    pac = pvlib.inverter.pvwatts(pdc, pl["acKw"] * 1000 / 0.96).clip(lower=0).fillna(0) / 1000

    # Clear-sky reference
    poa_cs = pvlib.irradiance.get_total_irradiance(
        pl["tiltDeg"], pl["azimuthDeg"], sp["apparent_zenith"], sp["azimuth"],
        cs["dni"], cs["ghi"], cs["dhi"], dni_extra=dni_extra, albedo=pl["albedo"], model="haydavies",
    )
    eff_cs = (poa_cs["poa_direct"] * iam + poa_cs["poa_diffuse"]).clip(lower=0).fillna(0)
    tcell_cs = pvlib.temperature.faiman(poa_cs["poa_global"].fillna(0), temp_air, wind)
    pac_cs = pvlib.inverter.pvwatts(
        pvlib.pvsystem.pvwatts_dc(eff_cs, tcell_cs, pl["dcKwp"] * 1000, pl["gammaPdc"]) * (1 - pl["systemLosses"]),
        pl["acKw"] * 1000 / 0.96,
    ).clip(lower=0).fillna(0) / 1000

    slots = []
    for t in range(SLOT_COUNT):
        slots.append(
            {
                "t": t,
                "label": slot_label(t),
                "hourCenter": hcs[t],
                "zenith": float(sp["apparent_zenith"].iloc[t]),
                "ghi": float(ghi.iloc[t]),
                "dni": float(dec["dni"].fillna(0).iloc[t]),
                "dhi": float(dec["dhi"].fillna(0).iloc[t]),
                "poa": float(poa["poa_global"].fillna(0).iloc[t]),
                "cellTemp": float(tcell.iloc[t]),
                "dcKw": float(pdc.iloc[t] / 1000),
                "acKw": float(pac.iloc[t]),
                "clearSkyAcKw": float(pac_cs.iloc[t]),
            }
        )
    return {
        "slots": slots,
        "energyKwh": float(pac.sum() * SLOT_HOURS),
        "peakKw": float(pac.max()),
        "clearSkyEnergyKwh": float(pac_cs.sum() * SLOT_HOURS),
        "model": f"pvlib {pvlib.__version__} · Ineichen · Erbs · Hay–Davies · Faiman · PVWatts",
    }


def capacity_profile(solar: dict, scn: dict) -> list[float]:
    return [
        max(0.0, min(scn["feederLimitKw"], s["acKw"] * (1 - scn["forecastReserve"]) + scn["gridAllowanceKw"]))
        for s in solar["slots"]
    ]
