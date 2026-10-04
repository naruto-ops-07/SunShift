// Solar geometry — NOAA solar position algorithm (accuracy ~0.01° for 1950–2050),
// plus extraterrestrial irradiance, air mass and the Ineichen–Perez clear-sky model.
// Mirrors what pvlib does server-side (pvlib.solarposition / pvlib.clearsky.ineichen).

const DEG = Math.PI / 180;

export interface SunPosition {
  zenith: number; // degrees (refraction-corrected apparent zenith)
  azimuth: number; // degrees clockwise from north
  elevation: number;
}

/** Julian day from a UTC timestamp (ms). */
function julianDay(ms: number): number {
  return ms / 86400000 + 2440587.5;
}

export function sunPosition(utcMs: number, lat: number, lon: number): SunPosition {
  const jd = julianDay(utcMs);
  const T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C =
    Math.sin(M * DEG) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * M * DEG) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * M * DEG) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * DEG);
  const meanObliq = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const obliq = meanObliq + 0.00256 * Math.cos(omega * DEG);
  const decl = Math.asin(Math.sin(obliq * DEG) * Math.sin(appLong * DEG)) / DEG;
  const y = Math.tan((obliq / 2) * DEG) ** 2;
  // Equation of time in minutes (4 minutes per degree of hour angle).
  const eqMinutes =
    (4 / DEG) *
    (y * Math.sin(2 * L0 * DEG) -
      2 * e * Math.sin(M * DEG) +
      4 * e * y * Math.sin(M * DEG) * Math.cos(2 * L0 * DEG) -
      0.5 * y * y * Math.sin(4 * L0 * DEG) -
      1.25 * e * e * Math.sin(2 * M * DEG));
  const d = new Date(utcMs);
  const utcMinutes = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  let tst = (utcMinutes + eqMinutes + 4 * lon) % 1440;
  if (tst < 0) tst += 1440;
  let ha = tst / 4 - 180;
  if (ha < -180) ha += 360;
  const cosZ =
    Math.sin(lat * DEG) * Math.sin(decl * DEG) + Math.cos(lat * DEG) * Math.cos(decl * DEG) * Math.cos(ha * DEG);
  const zen = Math.acos(Math.min(1, Math.max(-1, cosZ))) / DEG;
  // Azimuth (clockwise from north)
  let az: number;
  const denom = Math.cos(lat * DEG) * Math.sin(zen * DEG);
  if (Math.abs(denom) > 1e-6) {
    let azCos = (Math.sin(lat * DEG) * Math.cos(zen * DEG) - Math.sin(decl * DEG)) / denom;
    azCos = Math.min(1, Math.max(-1, azCos));
    const a = Math.acos(azCos) / DEG;
    az = ha > 0 ? (a + 180) % 360 : (540 - a) % 360;
  } else {
    az = lat > 0 ? 180 : 0;
  }
  // Atmospheric refraction (NOAA approximation)
  const elev = 90 - zen;
  let refr = 0;
  if (elev <= 85) {
    const te = Math.tan(elev * DEG);
    if (elev > 5) refr = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
    else if (elev > -0.575) refr = 1735 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)));
    else refr = -20.772 / te;
    refr /= 3600;
  }
  const appElev = elev + refr;
  return { zenith: 90 - appElev, azimuth: az, elevation: appElev };
}

/** Extraterrestrial normal irradiance (W/m²), Spencer-style approximation. */
export function extraRadiation(doy: number): number {
  const b = (2 * Math.PI * doy) / 365;
  return 1366.1 * (1.00011 + 0.034221 * Math.cos(b) + 0.00128 * Math.sin(b) + 0.000719 * Math.cos(2 * b) + 0.000077 * Math.sin(2 * b));
}

/** Kasten–Young relative air mass. */
export function airMassRelative(zenith: number): number {
  if (zenith >= 90) return NaN;
  return 1 / (Math.cos(zenith * DEG) + 0.50572 * (96.07995 - zenith) ** -1.6364);
}

export function pressureFromAltitude(alt: number): number {
  return 101325 * (1 - 2.25577e-5 * alt) ** 5.25588;
}

/** Ineichen–Perez clear-sky model (as in pvlib.clearsky.ineichen). */
export function clearSkyIneichen(zenith: number, doy: number, altitude: number, linke: number): { ghi: number; dni: number; dhi: number } {
  if (zenith >= 90) return { ghi: 0, dni: 0, dhi: 0 };
  const I0 = extraRadiation(doy);
  const amRel = airMassRelative(zenith);
  const am = (amRel * pressureFromAltitude(altitude)) / 101325;
  const cosZ = Math.max(Math.cos(zenith * DEG), 0);
  const fh1 = Math.exp(-altitude / 8000);
  const fh2 = Math.exp(-altitude / 1250);
  const cg1 = 5.09e-5 * altitude + 0.868;
  const cg2 = 3.92e-5 * altitude + 0.0387;
  let ghi = cg1 * I0 * cosZ * Math.exp(-cg2 * am * (fh1 + fh2 * (linke - 1))) * Math.exp(0.01 * am ** 1.8);
  ghi = Math.max(ghi, 0);
  const b = 0.664 + 0.163 / fh1;
  let bnci = b * Math.exp(-0.09 * am * (linke - 1)) * I0;
  const bnci2 = ghi * ((1 - (0.1 - 0.2 * Math.exp(-linke)) / (0.1 + 0.882 / fh1)) / cosZ);
  bnci = Math.max(Math.min(bnci, bnci2), 0);
  const dhi = Math.max(ghi - bnci * cosZ, 0);
  return { ghi, dni: bnci, dhi };
}

/** Erbs decomposition: split GHI into DNI + DHI using the clearness index. */
export function erbs(ghi: number, zenith: number, doy: number): { dni: number; dhi: number } {
  if (zenith >= 87 || ghi <= 0) return { dni: 0, dhi: Math.max(ghi, 0) };
  const cosZ = Math.cos(zenith * DEG);
  const kt = Math.min(Math.max(ghi / (extraRadiation(doy) * cosZ), 0), 1);
  let df: number;
  if (kt <= 0.22) df = 1 - 0.09 * kt;
  else if (kt <= 0.8) df = 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4;
  else df = 0.165;
  const dhi = df * ghi;
  const dni = Math.max((ghi - dhi) / cosZ, 0);
  return { dni, dhi };
}

/** Cosine of the angle of incidence on a tilted plane. */
export function cosAoi(zenith: number, azimuth: number, tilt: number, surfAz: number): number {
  return (
    Math.cos(zenith * DEG) * Math.cos(tilt * DEG) +
    Math.sin(zenith * DEG) * Math.sin(tilt * DEG) * Math.cos((azimuth - surfAz) * DEG)
  );
}
