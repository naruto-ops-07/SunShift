// The SunShift scheduling model — one definition shared by every solver.
//
//   x[f,t] ∈ {0,1}   pump f runs in slot t           (only inside the farmer's window)
//   s[f,t] ∈ {0,1}   pump f starts in slot t
//   Σ_t x[f,t] ≤ R_f                                 requested runtime (slots)
//   s[f,t] ≥ x[f,t] − x[f,t−1],  Σ_t s[f,t] ≤ 1      one contiguous window per farm per day
//   s[f,t] ⇒ x[f,t..t+minRun−1]                      no short-cycling of the motor
//   Σ_f P_f x[f,t] ≤ C_t                             C_t = min(feeder limit, derated PV + grid allowance)
//   peak ≥ Σ_f P_f x[f,t]
//   R_f · z ≤ 1000 · Σ_t x[f,t]   (servable farms)   z = worst-served farm's fulfilment ‰
//
//   maximise  Σ_f Σ_t (c_f + b_t) x[f,t]  +  W·z  −  30 Σ s  −  3·peak
//     c_f = round(1000 · w_f / R_f)   priority-weighted fulfilment
//     b_t = round(5 · PV_t / max PV)  prefer slots with the most solar headroom
//     W   = fairness weight (max-min term dominates under scarcity)
//
// The API's CP-SAT model (api/sunshift/optimiser.py) implements exactly this.

import type { Problem, Solution } from '../types';

export const FULFIL_SCALE = 1000;
export const START_PENALTY = 30;
export const POWER_SCALE = 10; // 0.1 kW integer units
export const PEAK_WEIGHT = 3; // per 0.1 kW of peak load — flattens the feeder profile
export const SOLAR_BONUS = 5; // max per-slot bonus for running when PV is strongest

export interface IntModel {
  T: number;
  F: number;
  ids: number[];
  pw: number[]; // power, 0.1 kW
  R: number[];
  minRun: number[];
  ws: number[];
  we: number[];
  c: number[]; // per-slot priority coefficient
  b: number[]; // per-slot solar alignment bonus
  cap: number[]; // capacity, 0.1 kW
  W: number; // fairness weight
  servable: boolean[];
}

export function toIntModel(p: Problem): IntModel {
  const T = p.T;
  const maxSolar = Math.max(1e-6, ...p.solar);
  const cap = p.cap.map((c) => Math.max(0, Math.floor(c * POWER_SCALE + 1e-6)));
  const farms = p.farms.filter((f) => f.requested > 0 && f.windowEnd - f.windowStart >= f.minRun);
  const pw = farms.map((f) => Math.round(f.powerKw * POWER_SCALE));
  const R = farms.map((f) => Math.min(f.requested, f.windowEnd - f.windowStart));
  const minRun = farms.map((f, i) => Math.min(f.minRun, R[i]));
  const ws = farms.map((f) => f.windowStart);
  const we = farms.map((f) => f.windowEnd);
  // A farm is servable if its pump fits for minRun consecutive slots somewhere in its window.
  const servable = farms.map((_, i) => {
    let run = 0;
    for (let t = ws[i]; t < we[i]; t++) {
      run = cap[t] >= pw[i] ? run + 1 : 0;
      if (run >= minRun[i]) return true;
    }
    return false;
  });
  return {
    T,
    F: farms.length,
    ids: farms.map((f) => f.id),
    pw,
    R,
    minRun,
    ws,
    we,
    c: farms.map((f, i) => Math.round((FULFIL_SCALE * f.weight) / R[i])),
    b: p.solar.map((s) => Math.round((SOLAR_BONUS * s) / maxSolar)),
    cap,
    W: Math.max(0, Math.round(p.fairnessWeight)),
    servable,
  };
}

export interface Evaluation {
  feasible: boolean;
  objective: number;
  served: number[];
  z: number;
  peak: number; // 0.1 kW
  load: number[]; // 0.1 kW
  violations: string[];
}

export function emptySolution(m: IntModel): Solution {
  return { start: new Array(m.F).fill(-1), length: new Array(m.F).fill(0) };
}

export function evaluate(m: IntModel, sol: Solution): Evaluation {
  const load = new Array(m.T).fill(0);
  const violations: string[] = [];
  let obj = 0;
  const served: number[] = [];
  for (let i = 0; i < m.F; i++) {
    const s = sol.start[i];
    const L = sol.length[i];
    served.push(L > 0 ? L : 0);
    if (L <= 0) continue;
    if (s < m.ws[i] || s + L > m.we[i]) violations.push(`farm ${m.ids[i]} outside window`);
    if (L > m.R[i]) violations.push(`farm ${m.ids[i]} exceeds request`);
    if (L < m.minRun[i]) violations.push(`farm ${m.ids[i]} below min run`);
    obj -= START_PENALTY;
    for (let t = s; t < s + L; t++) {
      load[t] += m.pw[i];
      obj += m.c[i] + m.b[t];
    }
  }
  for (let t = 0; t < m.T; t++) if (load[t] > m.cap[t]) violations.push(`slot ${t} over capacity`);
  let z = FULFIL_SCALE;
  let anyServable = false;
  for (let i = 0; i < m.F; i++) {
    if (!m.servable[i]) continue;
    anyServable = true;
    z = Math.min(z, Math.floor((FULFIL_SCALE * served[i]) / m.R[i]));
  }
  if (!anyServable) z = 0;
  const peak = Math.max(0, ...load);
  obj += m.W * z - PEAK_WEIGHT * peak;
  return { feasible: violations.length === 0, objective: obj, served, z, peak, load, violations };
}

/** Upper bound of the objective ignoring capacity (used to sanity-check reported gaps). */
export function trivialBound(m: IntModel): number {
  let ub = m.W * FULFIL_SCALE;
  for (let i = 0; i < m.F; i++) {
    const bs = m.b.slice(m.ws[i], m.we[i]).sort((a, b) => b - a);
    ub += m.R[i] * m.c[i] + bs.slice(0, m.R[i]).reduce((a, v) => a + v, 0) - START_PENALTY;
  }
  return ub;
}
