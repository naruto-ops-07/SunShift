"""Weather: Open-Meteo forecast/archive with a seeded climatology fallback.

The fallback generator is a bit-exact port of web/src/engine/weather.ts (same PRNG, same
formulas), so a browser without internet and a server without internet agree."""

from __future__ import annotations

import math
import time
from datetime import datetime, timezone
from typing import Any

import httpx

from .prng import gaussian, hash_string, mulberry32
from .roster import js_round, location
from .solarpos import clear_sky_ghi, sun_position
from .timeutil import add_days, day_of_year, month_index

U10_TO_U2 = 4.87 / math.log(67.8 * 10 - 5.42)

HOURLY_VARS = [
    "temperature_2m",
    "relative_humidity_2m",
    "wind_speed_10m",
    "shortwave_radiation",
    "direct_normal_irradiance",
    "diffuse_radiation",
    "cloud_cover",
    "precipitation",
    "precipitation_probability",
    "et0_fao_evapotranspiration",
]

_cache: dict[str, tuple[float, dict]] = {}
CACHE_SECONDS = 900


def _num(arr: list | None, i: int, fallback: float = 0.0) -> float:
    if not arr or i >= len(arr):
        return fallback
    v = arr[i]
    return float(v) if isinstance(v, (int, float)) and math.isfinite(v) else fallback


def parse_hourly(js: dict) -> dict[str, Any]:
    h = js["hourly"]
    n = len(h["time"])

    def pick(k: str, fb: float = 0.0) -> list[float]:
        return [_num(h.get(k), i, fb) for i in range(n)]

    return {
        "time": h["time"],
        "temp": pick("temperature_2m", 25),
        "rh": pick("relative_humidity_2m", 60),
        "wind10": pick("wind_speed_10m", 2),
        "ghi": pick("shortwave_radiation"),
        "dni": pick("direct_normal_irradiance") if h.get("direct_normal_irradiance") else None,
        "dhi": pick("diffuse_radiation") if h.get("diffuse_radiation") else None,
        "cloud": [c / 100 for c in pick("cloud_cover", 30)],
        "precip": pick("precipitation"),
        "precipProb": pick("precipitation_probability") if h.get("precipitation_probability") else None,
        "et0Ref": pick("et0_fao_evapotranspiration") if h.get("et0_fao_evapotranspiration") else None,
    }


def aggregate_daily(h: dict[str, Any]) -> list[dict[str, Any]]:
    by_date: dict[str, list[int]] = {}
    for i, t in enumerate(h["time"]):
        by_date.setdefault(t[:10], []).append(i)
    out = []
    for date, idx in by_date.items():
        if len(idx) < 20:
            continue
        T = [h["temp"][i] for i in idx]
        RH = [h["rh"][i] for i in idx]
        out.append(
            {
                "date": date,
                "tmax": max(T),
                "tmin": min(T),
                "rhMax": min(100.0, max(RH)),
                "rhMin": max(1.0, min(RH)),
                "rhMean": sum(RH) / len(RH),
                "wind2": sum(h["wind10"][i] for i in idx) / len(idx) * U10_TO_U2,
                "rsMJ": sum(h["ghi"][i] * 0.0036 for i in idx),
                "precip": sum(h["precip"][i] for i in idx),
                "precipProb": max(h["precipProb"][i] for i in idx)
                if h.get("precipProb")
                else (70 if any(h["precip"][i] > 0.2 for i in idx) else 10),
                "cloudMean": sum(h["cloud"][i] for i in idx) / len(idx),
                "et0Ref": sum(h["et0Ref"][i] for i in idx) if h.get("et0Ref") else None,
            }
        )
    return out


def fetch_forecast(loc_id: str, timeout: float = 8.0) -> dict[str, Any]:
    key = f"fc:{loc_id}"
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1]
    loc = location(loc_id)
    params = {
        "latitude": loc["lat"],
        "longitude": loc["lon"],
        "hourly": ",".join(HOURLY_VARS),
        "timezone": loc["timezone"],
        "past_days": 7,
        "forecast_days": 7,
        "wind_speed_unit": "ms",
    }
    r = httpx.get("https://api.open-meteo.com/v1/forecast", params=params, timeout=timeout)
    r.raise_for_status()
    hourly = parse_hourly(r.json())
    bundle = {
        "source": "open-meteo",
        "label": "LIVE WEATHER · Open-Meteo forecast (past 7 + next 7 days)",
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "locationId": loc_id,
        "hourly": hourly,
        "daily": aggregate_daily(hourly),
    }
    _cache[key] = (time.time(), bundle)
    return bundle


def _interp_monthly(arr: list[float], date: str) -> float:
    m = month_index(date)
    day = int(date[8:10])
    frac = (day - 15) / 30
    j = (m + 1) % 12 if frac >= 0 else (m + 11) % 12
    w = abs(frac)
    return arr[m] * (1 - w) + arr[j] * w


def _sat_vap(t: float) -> float:
    return 0.6108 * math.exp(17.27 * t / (t + 237.3))


def _parse_ms(date: str) -> float:
    return datetime.fromisoformat(f"{date}T00:00:00+00:00").timestamp() * 1000


def synthetic_weather(loc_id: str, start: str, days: int) -> dict[str, Any]:
    loc = location(loc_id)
    c = loc["climate"]
    H: dict[str, list] = {k: [] for k in ("time", "temp", "rh", "wind10", "ghi", "cloud", "precip", "precipProb")}

    def markov(date: str) -> tuple[float, float]:
        p = min(0.9, _interp_monthly(c["rainDays"], date) / 30)
        pww = min(0.85, p + 0.3)
        pwd = 1 if p >= 1 else p * (1 - pww) / (1 - p)
        return pww, pwd

    wet_yesterday = False
    for w in range(-5, 0):
        date = add_days(start, w)
        r = mulberry32(hash_string(f"{loc_id}:{date}:wet"))
        pww, pwd = markov(date)
        wet_yesterday = r() < (pww if wet_yesterday else pwd)

    for d in range(days):
        date = add_days(start, d)
        doy = day_of_year(date)
        r_wet = mulberry32(hash_string(f"{loc_id}:{date}:wet"))
        rand = mulberry32(hash_string(f"{loc_id}:{date}:wx"))
        pww, pwd = markov(date)
        wet = r_wet() < (pww if wet_yesterday else pwd)
        wet_yesterday = wet
        mean_rain = _interp_monthly(c["rainMm"], date) / max(0.5, _interp_monthly(c["rainDays"], date))
        rain_total = min(90, -math.log(max(1e-6, rand())) * mean_rain) if wet else 0.0
        base_cloud = _interp_monthly(c["cloud"], date)
        day_cloud = 0.7 + 0.25 * rand() if wet else min(0.95, max(0.0, base_cloud * (0.35 + 0.9 * rand())))
        tmax = _interp_monthly(c["tmax"], date) + gaussian(rand) * 1.2 - (2.4 if wet else 0) - day_cloud * 1.0
        tmin = _interp_monthly(c["tmin"], date) + gaussian(rand) * 0.8 + (0.6 if wet else 0)
        rh_mean = min(96, max(20, _interp_monthly(c["rhMean"], date) + (10 if wet else -2) + gaussian(rand) * 4))
        wind = _interp_monthly(c["wind10"], date) * (0.7 + 0.6 * rand())
        rain_start = 13 + math.floor(rand() * 5)
        rain_hours = 1 + math.floor(rand() * 3)
        prob = js_round(55 + 40 * rand()) if wet else js_round(5 + 20 * rand())
        t_mean_day = (tmax + tmin) / 2
        ea = _sat_vap(t_mean_day) * rh_mean / 100
        for hr in range(1, 25):
            hc = hr - 0.5
            hh = hr % 24
            stamp_date = add_days(date, 1) if hr == 24 else date
            rng = tmax - tmin
            if hc < 6:
                t = tmin + rng * 0.12 * (1 - hc / 6)
            elif hc <= 14.5:
                t = tmin + rng * math.sin(math.pi / 2 * ((hc - 6) / 8.5))
            else:
                t = tmin + rng * (0.12 + 0.88 * math.cos(math.pi / 2 * ((hc - 14.5) / 9.5)))
            bump = 0.15 if (wet and rain_start - 1 <= hc <= rain_start + rain_hours) else 0
            hour_cloud = min(1, max(0, day_cloud + gaussian(rand) * 0.08 + bump))
            utc_ms = _parse_ms(date) + (hc - loc["utcOffsetHours"]) * 3600_000
            zen, _ = sun_position(utc_ms, loc["lat"], loc["lon"])
            cs = clear_sky_ghi(zen, doy, loc["elevation"], loc["linkeTurbidity"][month_index(date)])
            g = cs * (1 - 0.75 * hour_cloud**3.4)
            raining = wet and rain_start <= hc < rain_start + rain_hours
            H["time"].append(f"{stamp_date}T{hh:02d}:00")
            H["temp"].append(round(t, 2))
            H["rh"].append(min(100, max(12, ea / _sat_vap(t) * 100)))
            H["wind10"].append(round(wind * (0.6 + 0.8 * max(0, math.sin((hc - 6) / 14 * math.pi))), 2))
            H["ghi"].append(max(0.0, g))
            H["cloud"].append(hour_cloud)
            H["precip"].append(rain_total / rain_hours if raining else 0.0)
            H["precipProb"].append(prob)
    hourly = {**H, "dni": None, "dhi": None, "et0Ref": None}
    return {
        "source": "synthetic",
        "label": "SIMULATED WEATHER · seeded climatology (Open-Meteo not reached)",
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "locationId": loc_id,
        "hourly": hourly,
        "daily": aggregate_daily(hourly),
    }


def weather_for(loc_id: str, date: str, prefer_live: bool = True) -> dict[str, Any]:
    """Live Open-Meteo when reachable and covering `date`; otherwise the seeded fallback."""
    if prefer_live:
        try:
            b = fetch_forecast(loc_id)
            if any(d["date"] == date for d in b["daily"]):
                return b
        except Exception:  # network, DNS, HTTP — fall through to climatology
            pass
    return synthetic_weather(loc_id, add_days(date, -7), 14)
