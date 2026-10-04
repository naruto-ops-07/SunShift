// Farm demand: from soil-water state + forecast to an irrigation request and an explainable priority.

import { adjustedP, effectiveRain, et0Daily, stageInfo, totalAvailableWater } from './agronomy';
import { FEEDER, ROSTER, SLOT_COUNT, SLOT_HOURS, applyOverrides, farmCode, getLocation, hourToSlot, pumpFlowM3h, pumpKw } from './roster';
import { dayOfYear, diffDays } from './time';
import type { DailyWeather, FarmDay, FarmSpec, PriorityFactor, Problem, Scenario } from './types';

/** Irrigation trigger as a fraction of RAW. Drip systems irrigate little and often. */
export const TRIGGER: Record<FarmSpec['method'], number> = { drip: 0.35, sprinkler: 0.7, furrow: 0.85 };
/** Largest net depth a single irrigation event applies (the rest carries to following days). */
export const MAX_EVENT_NET_MM: Record<FarmSpec['method'], number> = { drip: 25, sprinkler: 40, furrow: 60 };

export interface DemandContext {
  scenario: Scenario;
  date: string;
  today: DailyWeather; // forecast for the day being planned (after what-if overrides)
  tomorrow: DailyWeather | null;
  /** depletion (mm) at start of day per farm id; if absent, initialised from the roster */
  depletion?: Record<number, number>;
  /** observed rain (mm) for the previous two days, used to correct roster initial states */
  recentRain?: [number, number];
}

export function expectedRain(d: DailyWeather | null): number {
  if (!d) return 0;
  return d.precip * Math.min(1, Math.max(0.15, d.precipProb / 100));
}

function level(v: number, hi: number, mid: number): 'HIGH' | 'MEDIUM' | 'LOW' {
  return v >= hi ? 'HIGH' : v >= mid ? 'MEDIUM' : 'LOW';
}

export function computeFarmDays(ctx: DemandContext): FarmDay[] {
  const { scenario: s, date, today, tomorrow } = ctx;
  const loc = getLocation(s.locationId);
  const et = et0Daily(today, loc.lat, loc.elevation, dayOfYear(date));
  const r24 = expectedRain(today);
  const r48 = r24 + 0.6 * expectedRain(tomorrow);
  const maxProb = Math.max(today.precipProb, tomorrow?.precipProb ?? 0) / 100;

  return ROSTER.farms.map((base) => {
    const spec = applyOverrides(base, s);
    const crop = ROSTER.crops[spec.crop];
    const cropDay = spec.sowingDaysAgo + diffDays(date, s.date);
    const stage = stageInfo(spec.crop, cropDay, { u2: today.wind2, rhMin: today.rhMin });
    const taw = stage.rootDepth > 0 ? totalAvailableWater(spec.soil, stage.rootDepth) : 0;
    const scale = s.demandScale * (spec.demandScale ?? 1);
    const etc = stage.kc * et.et0 * scale;
    const p = adjustedP(spec.crop, etc);
    const raw = p * taw;
    const eff = ROSTER.irrigationMethods[spec.method].efficiency;
    const kw = pumpKw(spec.pumpHp);
    const q = pumpFlowM3h(spec.pumpHp, spec.headM);
    let dr = ctx.depletion?.[spec.id];
    if (dr === undefined) {
      const [y1, y2] = ctx.recentRain ?? [0, 0];
      dr = Math.max(0, spec.initDepletion * taw - effectiveRain(y1) - 0.5 * effectiveRain(y2));
    }
    dr = Math.min(dr, taw);
    const projected = dr + etc - effectiveRain(r24);
    const rainBuffer = effectiveRain(r48) - effectiveRain(r24);
    const carry = Math.min(1, Math.max(0, s.carryOver[spec.id] ?? 0));
    const windowStart = Math.max(0, hourToSlot(spec.window[0]));
    const windowEnd = Math.min(SLOT_COUNT, hourToSlot(spec.window[1]));
    const maxSlots = Math.max(0, Math.min(Math.round(spec.maxHours / SLOT_HOURS), windowEnd - windowStart));

    let decision: FarmDay['decision'] = 'irrigate';
    let reason = '';
    let net = 0;
    if (stage.index === -1 || stage.index === 4) {
      decision = 'fallow';
      reason = stage.index === -1 ? 'Not sown yet — no crop water requirement.' : 'Crop harvested — no irrigation needed.';
    } else if (dr + etc < TRIGGER[spec.method] * raw) {
      decision = 'sufficient';
      const reserve = Math.max(0, raw - projected);
      const days = etc > 0 ? Math.max(1, Math.floor(reserve / etc)) : 9;
      reason = `Root zone holds ${reserve.toFixed(0)} mm before stress — irrigation not needed today (≈${days} d of reserve).`;
    } else if (projected - rainBuffer < TRIGGER[spec.method] * raw) {
      decision = 'rain';
      reason = `Rain forecast (${(today.precip + (tomorrow?.precip ?? 0)).toFixed(0)} mm over 48 h) covers the need — skip and save water.`;
    } else {
      net = Math.max(0, projected - Math.max(0, rainBuffer));
    }
    net = Math.min(net, MAX_EVENT_NET_MM[spec.method]);
    const grossM3 = decision === 'irrigate' ? (net * spec.areaHa * 10) / eff : 0;
    let requested = decision === 'irrigate' ? Math.ceil(grossM3 / (q * SLOT_HOURS) - 1e-9) : 0;
    if (requested > 0) requested = Math.max(FEEDER.minRunSlots, Math.min(maxSlots, requested));
    if (decision === 'irrigate' && requested === 0) {
      decision = 'sufficient';
      reason = 'Need is below one pump run — deferred to a later day.';
    }

    // Priority — every term is shown to the user as an explanation.
    const stress = Math.min(1, Math.max(0, (projected / Math.max(raw, 1e-6) - 0.6) / 0.8));
    const wSoil = 2.0 * stress;
    const wStage = 1.0 * stage.sensitivity;
    const wCarry = 1.5 * carry;
    const wRain = -0.6 * maxProb;
    const priority = Math.max(0.3, 1 + wSoil + wStage + wCarry + wRain);
    const factors: PriorityFactor[] = [
      { key: 'soil', label: 'Soil stress', value: `${projected.toFixed(0)} / ${raw.toFixed(0)} mm RAW`, level: level(stress, 0.6, 0.25), contribution: wSoil },
      { key: 'stage', label: 'Crop stage', value: stage.label, level: level(stage.sensitivity, 0.9, 0.6), contribution: wStage },
      { key: 'rain', label: 'Rain probability', value: `${Math.round(maxProb * 100)} % · ${r48.toFixed(1)} mm expected`, level: level(maxProb, 0.6, 0.3), contribution: wRain },
      { key: 'carry', label: 'Unmet yesterday', value: `${Math.round(carry * 100)} %`, level: level(carry, 0.35, 0.1), contribution: wCarry },
    ];
    if (decision === 'irrigate' && !reason) {
      const parts = [stress >= 0.6 ? 'High water need' : stress >= 0.25 ? 'Moderate water need' : 'Top-up need'];
      if (stage.sensitivity >= 0.9) parts.push(`${stage.label.toLowerCase()} stage`);
      if (maxProb < 0.3) parts.push('no rain expected');
      if (carry >= 0.1) parts.push(`short ${Math.round(carry * 100)} % yesterday`);
      reason = parts.join(' + ');
    }

    return {
      id: spec.id,
      code: farmCode(spec.id),
      spec,
      cropLabel: crop.label,
      soilLabel: ROSTER.soils[spec.soil].label,
      methodLabel: ROSTER.irrigationMethods[spec.method].label,
      stage,
      pumpKw: kw,
      flowM3h: q,
      efficiency: eff,
      taw,
      raw,
      depletionStart: dr,
      et0: et.et0,
      etc,
      rainForecast24: r24,
      rainForecast48: r48,
      projectedDepletion: projected,
      netNeedMm: net,
      grossNeedM3: grossM3,
      requestM3: Math.min(grossM3, requested * q * SLOT_HOURS),
      requestedSlots: requested,
      decision,
      reason,
      priority,
      priorityLevel: priority >= 3.2 ? 'HIGH' : priority >= 2.2 ? 'MEDIUM' : 'LOW',
      factors,
      soilStatusPct: taw > 0 ? Math.max(0, Math.min(100, ((taw - dr) / taw) * 100)) : 0,
    };
  });
}

export function buildProblem(farms: FarmDay[], cap: number[], solarAc: number[], s: Scenario): Problem {
  return {
    T: SLOT_COUNT,
    slotHours: SLOT_HOURS,
    cap,
    solar: solarAc,
    fairnessWeight: s.fairnessWeight,
    farms: farms
      .filter((f) => f.requestedSlots > 0)
      .map((f) => ({
        id: f.id,
        powerKw: f.pumpKw,
        requested: f.requestedSlots,
        minRun: FEEDER.minRunSlots,
        windowStart: Math.max(0, hourToSlot(f.spec.window[0])),
        windowEnd: Math.min(SLOT_COUNT, hourToSlot(f.spec.window[1])),
        weight: f.priority,
      })),
  };
}
