// Uncoordinated baseline: what the same 20 farms do without SunShift.
//
// Assumptions (shown in the UI, adjustable in code — not measured behaviour):
//  • Each farmer irrigates on a habit: every `everyDays` days, for a fixed number of hours,
//    starting around a habitual time (seeded ±30 min jitter). No soil-water information.
//  • Farmers skip a habit day only if yesterday brought > 10 mm of rain (no forecast use).
//  • Pumps draw from the feeder regardless of solar output; any shortfall is grid import.
//  • If total load exceeds the feeder limit, protection trips: all pumps stop for the
//    lockout period, then farmers reconnect gradually (70 % chance per slot each).
//  • Farmers do not extend their session to make up for time lost to trips.

import { hashString, mulberry32 } from './prng';
import { FEEDER, SLOT_COUNT, SLOT_HOURS, hourToSlot } from './roster';
import { diffDays } from './time';
import type { FarmDay, FarmSchedule, PlanResult } from './types';

export interface BaselineOptions {
  date: string;
  habitScale?: number;
  feederLimitKw: number;
  rainYesterdayMm: number;
  seedKey?: string;
}

export function habitIrrigatesToday(f: FarmDay, date: string, rainYesterdayMm: number): boolean {
  if (f.stage.index === -1 || f.stage.index === 4) return false;
  if (rainYesterdayMm > 10) return false;
  const dayNo = diffDays(date, '2026-01-01');
  const k = Math.max(1, f.spec.habit.everyDays);
  return (((dayNo + f.spec.habit.phase) % k) + k) % k === 0;
}

export function simulateBaseline(farms: FarmDay[], o: BaselineOptions): PlanResult {
  const T = SLOT_COUNT;
  const rand = mulberry32(hashString(`baseline:${o.seedKey ?? ''}:${o.date}`));
  const wantStart: number[] = [];
  const wantEnd: number[] = [];
  farms.forEach((f) => {
    if (!habitIrrigatesToday(f, o.date, o.rainYesterdayMm)) {
      wantStart.push(-1);
      wantEnd.push(-1);
      return;
    }
    const jitter = Math.round((rand() - 0.5) * 4); // ±2 slots
    const s = Math.max(0, Math.min(T - 1, hourToSlot(f.spec.habit.start) + jitter));
    const L = Math.round((f.spec.habit.hours * (o.habitScale ?? 1)) / SLOT_HOURS);
    wantStart.push(s);
    wantEnd.push(Math.min(T, s + L));
  });
  const on = farms.map(() => new Array<boolean>(T).fill(false));
  const load = new Array(T).fill(0);
  const attempted = new Array(T).fill(0);
  const trips = new Array<boolean>(T).fill(false);
  const connected = farms.map(() => true);
  let lockout = 0;
  for (let t = 0; t < T; t++) {
    if (lockout > 0) {
      lockout--;
      continue;
    }
    // After a trip, farmers walk back to their starters one by one.
    farms.forEach((_, i) => {
      if (!connected[i] && rand() < 0.7) connected[i] = true;
    });
    let l = 0;
    const active: number[] = [];
    farms.forEach((f, i) => {
      if (wantStart[i] >= 0 && t >= wantStart[i] && t < wantEnd[i] && connected[i]) {
        l += f.pumpKw;
        active.push(i);
      }
    });
    attempted[t] = l;
    if (l > o.feederLimitKw) {
      trips[t] = true;
      lockout = FEEDER.tripLockoutSlots;
      farms.forEach((_, i) => (connected[i] = false));
      continue;
    }
    load[t] = l;
    active.forEach((i) => (on[i][t] = true));
  }
  const schedules: FarmSchedule[] = farms.map((f, i) => {
    const n = on[i].filter(Boolean).length;
    const requested = wantStart[i] >= 0 ? wantEnd[i] - wantStart[i] : 0;
    const water = n * f.flowM3h * SLOT_HOURS;
    return {
      id: f.id,
      start: wantStart[i],
      length: n,
      requested,
      fulfilment: requested > 0 ? n / requested : 0,
      waterM3: water,
      energyKwh: n * f.pumpKw * SLOT_HOURS,
    };
  });
  return { kind: 'baseline', schedules, on, load, attemptedLoad: attempted, trips, solver: null };
}
