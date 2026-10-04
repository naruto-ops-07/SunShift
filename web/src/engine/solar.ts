// PV model: GHI → POA → cell temperature → DC → AC, on the 15-minute scheduling grid.
// Browser mirror of the pvlib chain used by the API:
//   clear-sky index interpolation · Erbs decomposition · isotropic (Liu–Jordan) transposition
//   · ASHRAE IAM · Faiman cell temperature · PVWatts DC · PVWatts inverter with clipping.

import { addDays, dayOfYear, monthIndex } from './time';
import { clearSkyIneichen, cosAoi, erbs, sunPosition } from './solarPosition';
import { FEEDER, SLOT_COUNT, SLOT_HOURS, START_HOUR, getLocation, slotLabel } from './roster';
import type { Scenario, SolarDay, SolarSlot, WeatherBundle } from './types';

const DEG = Math.PI / 180;

export interface PlantParams {
  dcKwp: number;
  acKw: number;
  tiltDeg: number;
  azimuthDeg: number;
  gammaPdc: number;
  systemLosses: number;
  albedo: number;
}

export function plantFromScenario(s: Scenario): PlantParams {
  return { ...FEEDER.solar, dcKwp: s.solarKwp, acKw: s.inverterKw };
}

/** PVWatts DC model. */
export function pvwattsDc(poa: number, cellTemp: number, dcKwp: number, gamma: number): number {
  return Math.max(0, dcKwp * (poa / 1000) * (1 + gamma * (cellTemp - 25)));
}

/** PVWatts inverter model (Dobos 2014) with AC clipping. */
export function pvwattsAc(pdc: number, acKw: number, etaNom = 0.96, etaRef = 0.9637): number {
  if (pdc <= 0) return 0;
  const pdc0 = acKw / etaNom;
  const z = pdc / pdc0;
  const eta = (etaNom / etaRef) * (-0.0162 * z - 0.0059 / z + 0.9858);
  return Math.max(0, Math.min(eta * pdc, acKw));
}

/** Faiman module temperature model (pvlib.temperature.faiman defaults). */
export function faiman(poa: number, airTemp: number, wind: number, u0 = 25, u1 = 6.84): number {
  return airTemp + poa / (u0 + u1 * wind);
}

function poaIsotropic(ghi: number, dni: number, dhi: number, zenith: number, azimuth: number, p: PlantParams) {
  const ca = cosAoi(zenith, azimuth, p.tiltDeg, p.azimuthDeg);
  const aoiOk = ca > 0 && zenith < 90;
  const iam = aoiOk ? Math.max(0, 1 - 0.05 * (1 / ca - 1)) : 0; // ASHRAE b0 = 0.05
  const beam = aoiOk ? dni * ca * iam : 0;
  const sky = dhi * (1 + Math.cos(p.tiltDeg * DEG)) / 2;
  const ground = ghi * p.albedo * (1 - Math.cos(p.tiltDeg * DEG)) / 2;
  return Math.max(0, beam + sky + ground);
}

export interface SolarOptions {
  cloudEvent?: Scenario['cloudEvent'];
}

export function computeSolarDay(weather: WeatherBundle, date: string, plant: PlantParams, opts: SolarOptions = {}): SolarDay {
  const loc = getLocation(weather.locationId);
  const doy = dayOfYear(date);
  const linke = loc.linkeTurbidity[monthIndex(date)];
  const stampIndex = new Map<string, number>();
  weather.hourly.time.forEach((t, i) => stampIndex.set(t, i));
  const hourIdx = (hourEnding: number): number | undefined => {
    const stamp = hourEnding >= 24 ? `${addDays(date, 1)}T00:00` : `${date}T${String(hourEnding).padStart(2, '0')}:00`;
    return stampIndex.get(stamp);
  };
  const utcAt = (h: number) => Date.parse(`${date}T00:00:00Z`) + (h - loc.utcOffsetHours) * 3600_000;
  const csGhiAt = (h: number) => clearSkyIneichen(sunPosition(utcAt(h), loc.lat, loc.lon).zenith, doy, loc.elevation, linke).ghi;

  // Clear-sky index and diffuse fraction per hour (keyed by hour-ending), from the provider's hourly mean.
  const ktByHour = new Map<number, number>();
  const dfByHour = new Map<number, number>();
  for (let he = 5; he <= 20; he++) {
    const i = hourIdx(he);
    if (i === undefined) continue;
    const csMean = [0.125, 0.375, 0.625, 0.875].reduce((s, f) => s + csGhiAt(he - 1 + f), 0) / 4;
    const g = weather.hourly.ghi[i];
    const cloud = weather.hourly.cloud[i];
    const kt = csMean > 25 ? g / csMean : 1 - 0.75 * cloud ** 3.4;
    ktByHour.set(he, Math.min(1.15, Math.max(0, kt)));
    if (weather.hourly.dhi && g > 25) dfByHour.set(he, Math.min(1, Math.max(0.08, weather.hourly.dhi[i] / g)));
  }
  const interpHourly = (map: Map<number, number>, h: number): number | undefined => {
    // Values represent hour centres (hourEnding - 0.5).
    const lo = Math.floor(h + 0.5);
    const hi = lo + 1;
    const a = map.get(lo);
    const b = map.get(hi);
    const w = h + 0.5 - lo;
    if (a !== undefined && b !== undefined) return a * (1 - w) + b * w;
    return a ?? b;
  };
  const interpSeries = (arr: number[], h: number, fb: number): number => {
    const lo = Math.floor(h + 0.5);
    const ia = hourIdx(lo);
    const ib = hourIdx(lo + 1);
    const w = h + 0.5 - lo;
    if (ia !== undefined && ib !== undefined) return arr[ia] * (1 - w) + arr[ib] * w;
    if (ia !== undefined) return arr[ia];
    if (ib !== undefined) return arr[ib];
    return fb;
  };

  const slots: SolarSlot[] = [];
  let energy = 0;
  let csEnergy = 0;
  let peak = 0;
  for (let t = 0; t < SLOT_COUNT; t++) {
    const hc = START_HOUR + (t + 0.5) * SLOT_HOURS;
    const sp = sunPosition(utcAt(hc), loc.lat, loc.lon);
    const cs = clearSkyIneichen(sp.zenith, doy, loc.elevation, linke);
    let kt = interpHourly(ktByHour, hc) ?? 0.8;
    if (opts.cloudEvent && hc >= opts.cloudEvent.fromHour && hc < opts.cloudEvent.toHour) kt *= opts.cloudEvent.factor;
    const ghi = Math.max(0, kt * cs.ghi);
    const df = interpHourly(dfByHour, hc);
    let dni: number;
    let dhi: number;
    if (df !== undefined && !opts.cloudEvent) {
      dhi = df * ghi;
      dni = sp.zenith < 87 ? Math.max(0, (ghi - dhi) / Math.cos(sp.zenith * DEG)) : 0;
    } else {
      ({ dni, dhi } = erbs(ghi, sp.zenith, doy));
    }
    const poa = poaIsotropic(ghi, dni, dhi, sp.zenith, sp.azimuth, plant);
    const airT = interpSeries(weather.hourly.temp, hc, 28);
    const wind = interpSeries(weather.hourly.wind10, hc, 2) * 0.75;
    const cellT = faiman(poa, airT, wind);
    const dc = pvwattsDc(poa, cellT, plant.dcKwp, plant.gammaPdc) * (1 - plant.systemLosses);
    const ac = pvwattsAc(dc, plant.acKw);
    const poaCs = poaIsotropic(cs.ghi, cs.dni, cs.dhi, sp.zenith, sp.azimuth, plant);
    const acCs = pvwattsAc(pvwattsDc(poaCs, faiman(poaCs, airT, wind), plant.dcKwp, plant.gammaPdc) * (1 - plant.systemLosses), plant.acKw);
    slots.push({
      t,
      label: slotLabel(t),
      hourCenter: hc,
      zenith: sp.zenith,
      ghi,
      dni,
      dhi,
      poa,
      cellTemp: cellT,
      dcKw: dc,
      acKw: ac,
      clearSkyAcKw: acCs,
    });
    energy += ac * SLOT_HOURS;
    csEnergy += acCs * SLOT_HOURS;
    peak = Math.max(peak, ac);
  }
  return { slots, energyKwh: energy, peakKw: peak, clearSkyEnergyKwh: csEnergy };
}

/** Schedulable capacity: min(feeder limit, derated PV + permitted grid draw). */
export function capacityProfile(solar: SolarDay, s: Scenario): number[] {
  return solar.slots.map((sl) => Math.max(0, Math.min(s.feederLimitKw, sl.acKw * (1 - s.forecastReserve) + s.gridAllowanceKw)));
}
