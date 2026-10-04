// Agronomy engine — FAO Irrigation & Drainage Paper 56 (Allen et al., 1998).
//   ET0: Penman–Monteith (eq. 6 daily, eq. 53 hourly)
//   ETc: single crop coefficient with climate-adjusted Kc mid/end (eq. 62, 65)
//   Root-zone soil-water balance (eq. 85) with TAW, RAW and water-stress Ks (eq. 84)

import { ROSTER } from './roster';
import type { CropId, CropSpec, DailyWeather, SoilId, StageInfo } from './types';

const SIGMA = 4.903e-9; // MJ K⁻⁴ m⁻² day⁻¹
const GSC = 0.082; // MJ m⁻² min⁻¹

export function satVapourPressure(t: number): number {
  return 0.6108 * Math.exp((17.27 * t) / (t + 237.3));
}

export function slopeSatVapour(t: number): number {
  return (4098 * satVapourPressure(t)) / (t + 237.3) ** 2;
}

export function psychrometric(elevation: number): number {
  const P = 101.3 * ((293 - 0.0065 * elevation) / 293) ** 5.26;
  return 0.000665 * P;
}

/** Extraterrestrial radiation Ra (MJ m⁻² day⁻¹), FAO-56 eq. 21. */
export function extraterrestrialDaily(latDeg: number, doy: number): number {
  const phi = (latDeg * Math.PI) / 180;
  const dr = 1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365);
  const delta = 0.409 * Math.sin((2 * Math.PI * doy) / 365 - 1.39);
  const ws = Math.acos(Math.min(1, Math.max(-1, -Math.tan(phi) * Math.tan(delta))));
  return ((24 * 60) / Math.PI) * GSC * dr * (ws * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(ws));
}

export interface Et0Breakdown {
  et0: number;
  radiationTerm: number; // mm/day from 0.408Δ(Rn−G)/(…)
  aeroTerm: number; // mm/day from γ(900/(T+273))u2(es−ea)/(…)
  rn: number;
  delta: number;
  gamma: number;
  es: number;
  ea: number;
  u2: number;
  tmean: number;
}

/** Daily reference evapotranspiration, FAO-56 eq. 6 (G = 0 for daily steps). */
export function et0Daily(d: Pick<DailyWeather, 'tmax' | 'tmin' | 'rhMax' | 'rhMin' | 'wind2' | 'rsMJ'>, latDeg: number, elevation: number, doy: number): Et0Breakdown {
  const tmean = (d.tmax + d.tmin) / 2;
  const delta = slopeSatVapour(tmean);
  const gamma = psychrometric(elevation);
  const es = (satVapourPressure(d.tmax) + satVapourPressure(d.tmin)) / 2;
  const ea = (satVapourPressure(d.tmin) * (d.rhMax / 100) + satVapourPressure(d.tmax) * (d.rhMin / 100)) / 2;
  const ra = extraterrestrialDaily(latDeg, doy);
  const rso = (0.75 + 2e-5 * elevation) * ra;
  const rs = Math.min(d.rsMJ, rso);
  const rns = 0.77 * rs;
  const tk4 = ((d.tmax + 273.16) ** 4 + (d.tmin + 273.16) ** 4) / 2;
  const ratio = rso > 0 ? Math.min(1, rs / rso) : 0.5;
  const rnl = SIGMA * tk4 * (0.34 - 0.14 * Math.sqrt(Math.max(ea, 0))) * (1.35 * ratio - 0.35);
  const rn = rns - rnl;
  const u2 = Math.max(0.5, d.wind2);
  const denom = delta + gamma * (1 + 0.34 * u2);
  const radiationTerm = (0.408 * delta * rn) / denom;
  const aeroTerm = (gamma * (900 / (tmean + 273)) * u2 * (es - ea)) / denom;
  return { et0: Math.max(0, radiationTerm + aeroTerm), radiationTerm, aeroTerm, rn, delta, gamma, es, ea, u2, tmean };
}

/** Hourly ET0, FAO-56 eq. 53 (used for the intraday curve only). */
export function et0Hourly(t: number, rh: number, u2: number, rsMJh: number, rsoMJh: number, elevation: number): number {
  const delta = slopeSatVapour(t);
  const gamma = psychrometric(elevation);
  const es = satVapourPressure(t);
  const ea = (es * rh) / 100;
  const rns = 0.77 * rsMJh;
  const ratio = rsoMJh > 0.05 ? Math.min(1, rsMJh / rsoMJh) : 0.6;
  const rnl = (SIGMA / 24) * (t + 273.16) ** 4 * (0.34 - 0.14 * Math.sqrt(Math.max(ea, 0))) * (1.35 * ratio - 0.35);
  const rn = rns - rnl;
  const g = rn > 0 ? 0.1 * rn : 0.5 * rn;
  const num = 0.408 * delta * (rn - g) + gamma * (37 / (t + 273)) * u2 * (es - ea);
  return Math.max(0, num / (delta + gamma * (1 + 0.34 * u2)));
}

export function cropSpec(id: CropId): CropSpec {
  return ROSTER.crops[id];
}

export function seasonLength(c: CropSpec): number {
  return c.stageDays.reduce((a, b) => a + b, 0);
}

/** Climate-adjusted Kc for mid/late stages, FAO-56 eq. 62. */
export function adjustKc(kc: number, u2: number, rhMin: number, height: number): number {
  if (kc < 0.45) return kc;
  return kc + (0.04 * (u2 - 2) - 0.004 * (rhMin - 45)) * (height / 3) ** 0.3;
}

/** Crop stage, Kc and root depth for a given day after sowing (FAO-56 Fig. 25 piecewise curve). */
export function stageInfo(cropId: CropId, cropDay: number, climate?: { u2: number; rhMin: number }): StageInfo {
  const c = cropSpec(cropId);
  const [Lini, Ldev, Lmid, Llate] = c.stageDays;
  const total = Lini + Ldev + Lmid + Llate;
  if (cropDay < 0) return { index: -1, label: 'Not sown', cropDay, kc: 0, rootDepth: 0, sensitivity: 0 };
  if (cropDay >= total) return { index: 4, label: 'Harvested', cropDay, kc: 0, rootDepth: 0, sensitivity: 0 };
  const kcMid = climate ? adjustKc(c.kcMid, climate.u2, climate.rhMin, c.heightM) : c.kcMid;
  const kcEnd = climate ? adjustKc(c.kcEnd, climate.u2, climate.rhMin, c.heightM) : c.kcEnd;
  let kc: number;
  let index: 0 | 1 | 2 | 3;
  if (cropDay < Lini) {
    kc = c.kcIni;
    index = 0;
  } else if (cropDay < Lini + Ldev) {
    kc = c.kcIni + ((cropDay - Lini) / Ldev) * (kcMid - c.kcIni);
    index = 1;
  } else if (cropDay < Lini + Ldev + Lmid) {
    kc = kcMid;
    index = 2;
  } else {
    kc = kcMid + ((cropDay - Lini - Ldev - Lmid) / Llate) * (kcEnd - kcMid);
    index = 3;
  }
  const rootFrac = Math.min(1, cropDay / (Lini + Ldev));
  return {
    index,
    label: c.stageLabels[index],
    cropDay,
    kc,
    rootDepth: c.rootMin + (c.rootMax - c.rootMin) * rootFrac,
    sensitivity: c.stageSensitivity[index],
  };
}

/** Kc curve sampled for charts. */
export function kcCurve(cropId: CropId, step = 2): { day: number; kc: number; stage: number }[] {
  const c = cropSpec(cropId);
  const total = seasonLength(c);
  const out: { day: number; kc: number; stage: number }[] = [];
  for (let d = 0; d < total; d += step) {
    const s = stageInfo(cropId, d);
    out.push({ day: d, kc: s.kc, stage: s.index });
  }
  return out;
}

export function totalAvailableWater(soil: SoilId, rootDepth: number): number {
  const s = ROSTER.soils[soil];
  return 1000 * (s.thetaFC - s.thetaWP) * rootDepth;
}

/** Depletion fraction p adjusted for evaporative demand (FAO-56 Table 22 footnote). */
export function adjustedP(cropId: CropId, etc: number): number {
  return Math.min(0.8, Math.max(0.1, cropSpec(cropId).p + 0.04 * (5 - etc)));
}

/** Water-stress coefficient Ks, FAO-56 eq. 84. */
export function waterStressKs(dr: number, taw: number, raw: number): number {
  if (dr <= raw) return 1;
  return Math.max(0, (taw - dr) / Math.max(1e-6, taw - raw));
}

/** Effective rainfall reaching the root zone (simple intensity-based runoff/interception). */
export function effectiveRain(p: number): number {
  if (p < 2) return 0; // intercepted / evaporated from canopy and surface
  if (p <= 25) return 0.9 * p;
  if (p <= 50) return 22.5 + 0.75 * (p - 25);
  return 41.25 + 0.55 * (p - 50);
}

export interface BalanceStep {
  drEnd: number;
  deepPercolation: number;
  ks: number;
  etcAdj: number;
  beneficialIrrigationMm: number;
}

/** One day of the root-zone water balance, FAO-56 eq. 85. Depletion Dr in mm (0 = field capacity). */
export function balanceStep(drStart: number, taw: number, raw: number, etc: number, rainMm: number, netIrrigationMm: number): BalanceStep {
  const ks = waterStressKs(drStart, taw, raw);
  const etcAdj = ks * etc;
  const pe = effectiveRain(rainMm);
  let dr = drStart - pe - netIrrigationMm + etcAdj;
  let dp = 0;
  if (dr < 0) {
    dp = -dr;
    dr = 0;
  }
  dr = Math.min(dr, taw);
  // Irrigation that ended up below the root zone was not beneficial.
  const roomForIrrigation = Math.max(0, drStart + etcAdj - pe);
  const beneficial = Math.min(netIrrigationMm, roomForIrrigation);
  return { drEnd: dr, deepPercolation: dp, ks, etcAdj, beneficialIrrigationMm: beneficial };
}
