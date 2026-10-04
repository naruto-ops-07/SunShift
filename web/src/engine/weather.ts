// Weather layer: real Open-Meteo forecast/archive data when reachable,
// a seeded climatological generator when not. The bundle always says which one it is.

import { gaussian, hashString, mulberry32 } from './prng';
import { addDays, dayOfYear, monthIndex } from './time';
import { clearSkyIneichen, sunPosition } from './solarPosition';
import { getLocation } from './roster';
import type { DailyWeather, HourlyWeather, LocationSpec, WeatherBundle } from './types';

const U10_TO_U2 = 4.87 / Math.log(67.8 * 10 - 5.42); // FAO-56 eq. 47

const HOURLY_VARS = [
  'temperature_2m',
  'relative_humidity_2m',
  'wind_speed_10m',
  'shortwave_radiation',
  'direct_normal_irradiance',
  'diffuse_radiation',
  'cloud_cover',
  'precipitation',
  'precipitation_probability',
  'et0_fao_evapotranspiration',
];

export function openMeteoForecastUrl(loc: LocationSpec, pastDays = 7, forecastDays = 7): string {
  const q = new URLSearchParams({
    latitude: String(loc.lat),
    longitude: String(loc.lon),
    hourly: HOURLY_VARS.join(','),
    timezone: loc.timezone,
    past_days: String(pastDays),
    forecast_days: String(forecastDays),
    wind_speed_unit: 'ms',
  });
  return `https://api.open-meteo.com/v1/forecast?${q.toString()}`;
}

export function openMeteoArchiveUrl(loc: LocationSpec, start: string, end: string): string {
  const q = new URLSearchParams({
    latitude: String(loc.lat),
    longitude: String(loc.lon),
    hourly: ['temperature_2m', 'relative_humidity_2m', 'wind_speed_10m', 'shortwave_radiation', 'cloud_cover', 'precipitation'].join(','),
    timezone: loc.timezone,
    start_date: start,
    end_date: end,
    wind_speed_unit: 'ms',
  });
  return `https://archive-api.open-meteo.com/v1/archive?${q.toString()}`;
}

async function fetchJson(url: string, timeoutMs: number): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function num(arr: unknown[] | undefined, i: number, fallback = 0): number {
  const v = arr?.[i];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function parseOpenMeteoHourly(json: any): HourlyWeather {
  const h = json.hourly;
  const n = h.time.length;
  const pick = (k: string, fb = 0) => Array.from({ length: n }, (_, i) => num(h[k], i, fb));
  return {
    time: h.time,
    temp: pick('temperature_2m', 25),
    rh: pick('relative_humidity_2m', 60),
    wind10: pick('wind_speed_10m', 2),
    ghi: pick('shortwave_radiation'),
    dni: h.direct_normal_irradiance ? pick('direct_normal_irradiance') : null,
    dhi: h.diffuse_radiation ? pick('diffuse_radiation') : null,
    cloud: pick('cloud_cover', 30).map((c) => c / 100),
    precip: pick('precipitation'),
    precipProb: h.precipitation_probability ? pick('precipitation_probability', 0) : null,
    et0Ref: h.et0_fao_evapotranspiration ? pick('et0_fao_evapotranspiration') : null,
  };
}

/** Aggregate hourly series into FAO-56 daily inputs. */
export function aggregateDaily(h: HourlyWeather): DailyWeather[] {
  const byDate = new Map<string, number[]>();
  h.time.forEach((t, i) => {
    const d = t.slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(i);
  });
  const out: DailyWeather[] = [];
  for (const [date, idx] of byDate) {
    if (idx.length < 20) continue; // partial day at the edge of a request
    const T = idx.map((i) => h.temp[i]);
    const RH = idx.map((i) => h.rh[i]);
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    out.push({
      date,
      tmax: Math.max(...T),
      tmin: Math.min(...T),
      rhMax: Math.min(100, Math.max(...RH)),
      rhMin: Math.max(1, Math.min(...RH)),
      rhMean: mean(RH),
      wind2: mean(idx.map((i) => h.wind10[i])) * U10_TO_U2,
      rsMJ: idx.reduce((s, i) => s + h.ghi[i] * 0.0036, 0),
      precip: idx.reduce((s, i) => s + h.precip[i], 0),
      precipProb: h.precipProb ? Math.max(...idx.map((i) => h.precipProb![i])) : idx.some((i) => h.precip[i] > 0.2) ? 70 : 10,
      cloudMean: mean(idx.map((i) => h.cloud[i])),
      et0Ref: h.et0Ref ? idx.reduce((s, i) => s + h.et0Ref![i], 0) : null,
    });
  }
  return out;
}

export async function fetchForecast(locationId: string, timeoutMs = 9000): Promise<WeatherBundle> {
  const loc = getLocation(locationId);
  const json = await fetchJson(openMeteoForecastUrl(loc), timeoutMs);
  const hourly = parseOpenMeteoHourly(json);
  return {
    source: 'open-meteo',
    label: 'LIVE WEATHER · Open-Meteo forecast (past 7 + next 7 days)',
    fetchedAt: new Date().toISOString(),
    locationId,
    hourly,
    daily: aggregateDaily(hourly),
  };
}

export async function fetchArchive(locationId: string, start: string, end: string, timeoutMs = 12000): Promise<WeatherBundle> {
  const loc = getLocation(locationId);
  const json = await fetchJson(openMeteoArchiveUrl(loc, start, end), timeoutMs);
  const hourly = parseOpenMeteoHourly(json);
  return {
    source: 'open-meteo-archive',
    label: `HISTORICAL WEATHER · ERA5 reanalysis via Open-Meteo (${start} → ${end})`,
    fetchedAt: new Date().toISOString(),
    locationId,
    hourly,
    daily: aggregateDaily(hourly),
  };
}

// ---------------------------------------------------------------------------
// Synthetic climatology — used when the API is unreachable. Seeded per day so a
// given date always produces the same weather.

function interpMonthly(arr: number[], date: string): number {
  const m = monthIndex(date);
  const day = Number(date.slice(8, 10));
  const frac = (day - 15) / 30;
  const j = frac >= 0 ? (m + 1) % 12 : (m + 11) % 12;
  const w = Math.abs(frac);
  return arr[m] * (1 - w) + arr[j] * w;
}

function satVap(t: number): number {
  return 0.6108 * Math.exp((17.27 * t) / (t + 237.3));
}

export function syntheticWeather(locationId: string, start: string, days: number): WeatherBundle {
  const loc = getLocation(locationId);
  const time: string[] = [];
  const temp: number[] = [];
  const rh: number[] = [];
  const wind10: number[] = [];
  const ghi: number[] = [];
  const cloud: number[] = [];
  const precip: number[] = [];
  const precipProb: number[] = [];
  let wetYesterday = false;
  // Warm up the Markov chain a few days before the window so day 0 isn't biased.
  for (let w = -5; w < 0; w++) {
    const date = addDays(start, w);
    const r = mulberry32(hashString(`${locationId}:${date}:wet`));
    const p = Math.min(0.9, interpMonthly(loc.climate.rainDays, date) / 30);
    const pww = Math.min(0.85, p + 0.3);
    const pwd = p >= 1 ? 1 : (p * (1 - pww)) / (1 - p);
    wetYesterday = r() < (wetYesterday ? pww : pwd);
  }
  for (let d = 0; d < days; d++) {
    const date = addDays(start, d);
    const doy = dayOfYear(date);
    const rWet = mulberry32(hashString(`${locationId}:${date}:wet`));
    const rand = mulberry32(hashString(`${locationId}:${date}:wx`));
    const c = loc.climate;
    const p = Math.min(0.9, interpMonthly(c.rainDays, date) / 30);
    const pww = Math.min(0.85, p + 0.3);
    const pwd = p >= 1 ? 1 : (p * (1 - pww)) / (1 - p);
    const wet = rWet() < (wetYesterday ? pww : pwd);
    wetYesterday = wet;
    const meanRain = interpMonthly(c.rainMm, date) / Math.max(0.5, interpMonthly(c.rainDays, date));
    const rainTotal = wet ? Math.min(90, -Math.log(Math.max(1e-6, rand())) * meanRain) : 0;
    const baseCloud = interpMonthly(c.cloud, date);
    const dayCloud = wet ? 0.7 + 0.25 * rand() : Math.min(0.95, Math.max(0, baseCloud * (0.35 + 0.9 * rand())));
    const tmax = interpMonthly(c.tmax, date) + gaussian(rand) * 1.2 - (wet ? 2.4 : 0) - dayCloud * 1.0;
    const tmin = interpMonthly(c.tmin, date) + gaussian(rand) * 0.8 + (wet ? 0.6 : 0);
    const rhMean = Math.min(96, Math.max(20, interpMonthly(c.rhMean, date) + (wet ? 10 : -2) + gaussian(rand) * 4));
    const wind = interpMonthly(c.wind10, date) * (0.7 + 0.6 * rand());
    // Convective showers cluster in the afternoon/evening.
    const rainStart = 13 + Math.floor(rand() * 5);
    const rainHours = 1 + Math.floor(rand() * 3);
    const prob = wet ? Math.round(55 + 40 * rand()) : Math.round(5 + 20 * rand());
    // Keep vapour pressure roughly constant through the day; RH then follows temperature.
    const tMeanDay = (tmax + tmin) / 2;
    const ea = (satVap(tMeanDay) * rhMean) / 100;
    for (let hr = 1; hr <= 24; hr++) {
      // Value at HH:00 = mean of the preceding hour, matching Open-Meteo.
      const hc = hr - 0.5;
      const hh = hr % 24;
      const dateForStamp = hr === 24 ? addDays(date, 1) : date;
      // Diurnal temperature: minimum ~06:00, maximum ~14:30, cosine decay overnight.
      const range = tmax - tmin;
      let t: number;
      if (hc < 6) t = tmin + range * 0.12 * (1 - hc / 6);
      else if (hc <= 14.5) t = tmin + range * Math.sin((Math.PI / 2) * ((hc - 6) / 8.5));
      else t = tmin + range * (0.12 + 0.88 * Math.cos((Math.PI / 2) * ((hc - 14.5) / 9.5)));
      const hourCloud = Math.min(1, Math.max(0, dayCloud + gaussian(rand) * 0.08 + (wet && hc >= rainStart - 1 && hc <= rainStart + rainHours ? 0.15 : 0)));
      const utcMs = Date.parse(`${date}T00:00:00Z`) + (hc - loc.utcOffsetHours) * 3600_000;
      const sp = sunPosition(utcMs, loc.lat, loc.lon);
      const cs = clearSkyIneichen(sp.zenith, doy, loc.elevation, loc.linkeTurbidity[monthIndex(date)]);
      const g = cs.ghi * (1 - 0.75 * hourCloud ** 3.4); // Kasten–Czeplak cloud attenuation
      const raining = wet && hc >= rainStart && hc < rainStart + rainHours;
      time.push(`${dateForStamp}T${String(hh).padStart(2, '0')}:00`);
      temp.push(Number(t.toFixed(2)));
      rh.push(Math.min(100, Math.max(12, (ea / satVap(t)) * 100)));
      wind10.push(Number((wind * (0.6 + 0.8 * Math.max(0, Math.sin(((hc - 6) / 14) * Math.PI)))).toFixed(2)));
      ghi.push(Math.max(0, g));
      cloud.push(hourCloud);
      precip.push(raining ? rainTotal / rainHours : 0);
      precipProb.push(prob);
    }
  }
  const hourly: HourlyWeather = { time, temp, rh, wind10, ghi, dni: null, dhi: null, cloud, precip, precipProb, et0Ref: null };
  return {
    source: 'synthetic',
    label: 'SIMULATED WEATHER · seeded climatology (Open-Meteo not reached)',
    fetchedAt: new Date().toISOString(),
    locationId,
    hourly,
    daily: aggregateDaily(hourly),
  };
}

/** Synthetic window centred on `date` matching the live request (past 7 + next 7). */
export function syntheticAround(locationId: string, date: string): WeatherBundle {
  return syntheticWeather(locationId, addDays(date, -7), 14);
}

export function dailyIndex(bundle: WeatherBundle, date: string): number {
  return bundle.daily.findIndex((d) => d.date === date);
}

/** Hourly indices belonging to a local date (values for hours ending 01:00..24:00). */
export function hourlyIndicesFor(bundle: WeatherBundle, date: string): number[] {
  const out: number[] = [];
  bundle.hourly.time.forEach((t, i) => {
    if (t.slice(0, 10) === date) out.push(i);
  });
  return out;
}
