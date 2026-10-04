"""NOAA solar position + Ineichen clear sky — ports of web/src/engine/solarPosition.ts.
Used by the synthetic weather generator so both engines produce identical fallback weather.
The PV model itself uses pvlib (see solar.py)."""

from __future__ import annotations

import math
from datetime import datetime, timezone

DEG = math.pi / 180


def sun_position(utc_ms: float, lat: float, lon: float) -> tuple[float, float]:
    jd = utc_ms / 86400000 + 2440587.5
    T = (jd - 2451545) / 36525
    L0 = math.fmod(280.46646 + T * (36000.76983 + T * 0.0003032), 360)
    M = 357.52911 + T * (35999.05029 - 0.0001537 * T)
    e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T)
    C = (
        math.sin(M * DEG) * (1.914602 - T * (0.004817 + 0.000014 * T))
        + math.sin(2 * M * DEG) * (0.019993 - 0.000101 * T)
        + math.sin(3 * M * DEG) * 0.000289
    )
    true_long = L0 + C
    omega = 125.04 - 1934.136 * T
    app_long = true_long - 0.00569 - 0.00478 * math.sin(omega * DEG)
    mean_obliq = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60
    obliq = mean_obliq + 0.00256 * math.cos(omega * DEG)
    decl = math.asin(math.sin(obliq * DEG) * math.sin(app_long * DEG)) / DEG
    y = math.tan(obliq / 2 * DEG) ** 2
    eq_minutes = (4 / DEG) * (
        y * math.sin(2 * L0 * DEG)
        - 2 * e * math.sin(M * DEG)
        + 4 * e * y * math.sin(M * DEG) * math.cos(2 * L0 * DEG)
        - 0.5 * y * y * math.sin(4 * L0 * DEG)
        - 1.25 * e * e * math.sin(2 * M * DEG)
    )
    d = datetime.fromtimestamp(utc_ms / 1000, tz=timezone.utc)
    utc_minutes = d.hour * 60 + d.minute + d.second / 60
    tst = math.fmod(utc_minutes + eq_minutes + 4 * lon, 1440)
    if tst < 0:
        tst += 1440
    ha = tst / 4 - 180
    if ha < -180:
        ha += 360
    cos_z = math.sin(lat * DEG) * math.sin(decl * DEG) + math.cos(lat * DEG) * math.cos(decl * DEG) * math.cos(ha * DEG)
    zen = math.acos(min(1, max(-1, cos_z))) / DEG
    denom = math.cos(lat * DEG) * math.sin(zen * DEG)
    if abs(denom) > 1e-6:
        az_cos = min(1, max(-1, (math.sin(lat * DEG) * math.cos(zen * DEG) - math.sin(decl * DEG)) / denom))
        a = math.acos(az_cos) / DEG
        az = math.fmod(a + 180, 360) if ha > 0 else math.fmod(540 - a, 360)
    else:
        az = 180 if lat > 0 else 0
    elev = 90 - zen
    refr = 0.0
    if elev <= 85:
        te = math.tan(elev * DEG)
        if elev > 5:
            refr = 58.1 / te - 0.07 / te**3 + 0.000086 / te**5
        elif elev > -0.575:
            refr = 1735 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)))
        else:
            refr = -20.772 / te
        refr /= 3600
    return 90 - (elev + refr), az


def extra_radiation(doy: int) -> float:
    b = 2 * math.pi * doy / 365
    return 1366.1 * (1.00011 + 0.034221 * math.cos(b) + 0.00128 * math.sin(b) + 0.000719 * math.cos(2 * b) + 0.000077 * math.sin(2 * b))


def clear_sky_ghi(zenith: float, doy: int, altitude: float, linke: float) -> float:
    if zenith >= 90:
        return 0.0
    I0 = extra_radiation(doy)
    am_rel = 1 / (math.cos(zenith * DEG) + 0.50572 * (96.07995 - zenith) ** -1.6364)
    pressure = 101325 * (1 - 2.25577e-5 * altitude) ** 5.25588
    am = am_rel * pressure / 101325
    cos_z = max(math.cos(zenith * DEG), 0)
    fh1 = math.exp(-altitude / 8000)
    fh2 = math.exp(-altitude / 1250)
    cg1 = 5.09e-5 * altitude + 0.868
    cg2 = 3.92e-5 * altitude + 0.0387
    ghi = cg1 * I0 * cos_z * math.exp(-cg2 * am * (fh1 + fh2 * (linke - 1))) * math.exp(0.01 * am**1.8)
    return max(ghi, 0.0)
