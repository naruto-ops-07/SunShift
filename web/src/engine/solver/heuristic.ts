// Fast constructive solver: fairness floor by bisection → priority-greedy growth →
// ruin-and-recreate local search. Runs in a few milliseconds, so it powers instant
// previews, the season simulator and the no-backend fallback. It is NOT proven optimal;
// HiGHS (browser) and CP-SAT (server) refine it and report a bound.

import { mulberry32 } from '../prng';
import type { Solution } from '../types';
import { FULFIL_SCALE, PEAK_WEIGHT, START_PENALTY, emptySolution, evaluate, type Evaluation, type IntModel } from './model';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

class State {
  res: number[];
  start: number[];
  len: number[];
  constructor(private m: IntModel) {
    this.res = m.cap.slice();
    this.start = new Array(m.F).fill(-1);
    this.len = new Array(m.F).fill(0);
  }
  clone(): State {
    const s = new State(this.m);
    s.res = this.res.slice();
    s.start = this.start.slice();
    s.len = this.len.slice();
    return s;
  }
  fits(i: number, s: number, L: number): boolean {
    const m = this.m;
    if (s < m.ws[i] || s + L > m.we[i]) return false;
    for (let t = s; t < s + L; t++) if (this.res[t] < m.pw[i]) return false;
    return true;
  }
  set(i: number, s: number, L: number) {
    this.remove(i);
    for (let t = s; t < s + L; t++) this.res[t] -= this.m.pw[i];
    this.start[i] = L > 0 ? s : -1;
    this.len[i] = L;
  }
  remove(i: number) {
    if (this.len[i] > 0) for (let t = this.start[i]; t < this.start[i] + this.len[i]; t++) this.res[t] += this.m.pw[i];
    this.start[i] = -1;
    this.len[i] = 0;
  }
  /** Best start for a block of length L: maximise the minimum leftover headroom, then solar bonus. */
  bestStart(i: number, L: number): number {
    const m = this.m;
    let best = -1;
    let bestScore = -Infinity;
    for (let s = m.ws[i]; s + L <= m.we[i]; s++) {
      let minRes = Infinity;
      let bonus = 0;
      let ok = true;
      for (let t = s; t < s + L; t++) {
        const r = this.res[t] - m.pw[i];
        if (r < 0) {
          ok = false;
          break;
        }
        if (r < minRes) minRes = r;
        bonus += m.b[t];
      }
      if (!ok) continue;
      const score = minRes * 100 + bonus;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }
  toSolution(): Solution {
    return { start: this.start.slice(), length: this.len.slice() };
  }
}

function floorLen(m: IntModel, i: number, theta: number): number {
  if (!m.servable[i] || theta <= 0) return 0;
  return Math.min(m.R[i], Math.max(m.minRun[i], Math.ceil(theta * m.R[i] - 1e-9)));
}

function placeFloor(m: IntModel, theta: number): State | null {
  const st = new State(m);
  const order = [...Array(m.F).keys()].sort((a, b) => m.pw[b] * floorLen(m, b, theta) - m.pw[a] * floorLen(m, a, theta) || (m.we[a] - m.ws[a]) - (m.we[b] - m.ws[b]));
  for (const i of order) {
    const L = floorLen(m, i, theta);
    if (L === 0) continue;
    const s = st.bestStart(i, L);
    if (s < 0) return null;
    st.set(i, s, L);
  }
  return st;
}

/** Greedy growth by marginal objective gain (priority + solar bonus − peak increase). */
function grow(m: IntModel, st: State) {
  const load = () => m.cap.map((c, t) => c - st.res[t]);
  let l = load();
  let peak = Math.max(0, ...l);
  for (let guard = 0; guard < 5000; guard++) {
    let bestGain = 0;
    let bi = -1;
    let bs = 0;
    let bL = 0;
    for (let i = 0; i < m.F; i++) {
      if (!m.servable[i] || st.len[i] >= m.R[i]) continue;
      if (st.len[i] === 0) {
        const L = m.minRun[i];
        const s = st.bestStart(i, L);
        if (s < 0) continue;
        let g = -START_PENALTY;
        let newPeak = peak;
        for (let t = s; t < s + L; t++) {
          g += m.c[i] + m.b[t];
          newPeak = Math.max(newPeak, l[t] + m.pw[i]);
        }
        g -= PEAK_WEIGHT * (newPeak - peak);
        if (g > bestGain) [bestGain, bi, bs, bL] = [g, i, s, L];
      } else {
        const s0 = st.start[i];
        const e0 = s0 + st.len[i];
        for (const side of [-1, 1]) {
          const t = side < 0 ? s0 - 1 : e0;
          if (t < m.ws[i] || t >= m.we[i] || st.res[t] < m.pw[i]) continue;
          const g = m.c[i] + m.b[t] - PEAK_WEIGHT * Math.max(0, l[t] + m.pw[i] - peak) + st.res[t] / 1e6;
          if (g > bestGain) [bestGain, bi, bs, bL] = [g, i, side < 0 ? s0 - 1 : s0, st.len[i] + 1];
        }
      }
    }
    if (bi < 0) break;
    st.set(bi, bs, bL);
    l = load();
    peak = Math.max(0, ...l);
  }
}

/** Resource levelling: move blocks that sit on the peak to wherever they lower it. */
function level(m: IntModel, st: State, maxIter = 60) {
  for (let it = 0; it < maxIter; it++) {
    const load = m.cap.map((c, t) => c - st.res[t]);
    const peak = Math.max(0, ...load);
    if (peak === 0) return;
    const onPeak: number[] = [];
    for (let i = 0; i < m.F; i++) {
      if (st.len[i] === 0) continue;
      for (let t = st.start[i]; t < st.start[i] + st.len[i]; t++)
        if (load[t] === peak) {
          onPeak.push(i);
          break;
        }
    }
    onPeak.sort((a, b) => m.pw[b] - m.pw[a]);
    let improved = false;
    for (const i of onPeak) {
      const L = st.len[i];
      const s0 = st.start[i];
      st.remove(i);
      const base = m.cap.map((c, t) => c - st.res[t]);
      // Peak outside the moved block stays; find the start minimising the block's max load.
      let bestS = -1;
      let bestMax = Infinity;
      let bestBonus = -1;
      for (let s = m.ws[i]; s + L <= m.we[i]; s++) {
        let mx = 0;
        let bonus = 0;
        let ok = true;
        for (let t = s; t < s + L; t++) {
          if (st.res[t] < m.pw[i]) {
            ok = false;
            break;
          }
          mx = Math.max(mx, base[t] + m.pw[i]);
          bonus += m.b[t];
        }
        if (!ok) continue;
        if (mx < bestMax || (mx === bestMax && bonus > bestBonus)) {
          bestMax = mx;
          bestS = s;
          bestBonus = bonus;
        }
      }
      const restMax = Math.max(0, ...base);
      if (bestS >= 0 && Math.max(restMax, bestMax) < peak) {
        st.set(i, bestS, L);
        improved = true;
        break;
      }
      st.set(i, s0, L);
    }
    if (!improved) return;
  }
}

export interface HeuristicResult {
  solution: Solution;
  evaluation: Evaluation;
  timeMs: number;
  iterations: number;
  floorTheta: number;
}

export function solveHeuristic(m: IntModel, budgetMs = 120, seed = 1, maxIterations = 700): HeuristicResult {
  const t0 = now();
  if (m.F === 0) {
    const sol = emptySolution(m);
    return { solution: sol, evaluation: evaluate(m, sol), timeMs: 0, iterations: 0, floorTheta: 1 };
  }
  // 1) Fairness floor: the largest θ such that every servable farm gets ≥ θ of its request.
  let best = placeFloor(m, 1);
  let theta = 1;
  if (!best) {
    let lo = 0;
    let hi = 1;
    best = null;
    for (let k = 0; k < 16; k++) {
      const mid = (lo + hi) / 2;
      const st = placeFloor(m, mid);
      if (st) {
        lo = mid;
        best = st;
      } else hi = mid;
    }
    theta = lo;
    if (!best) best = new State(m);
  }
  // 2) Grow by priority, then level the load profile.
  grow(m, best);
  level(m, best);
  grow(m, best);
  let bestEval = evaluate(m, best.toSolution());

  // 3) Ruin & recreate.
  const rand = mulberry32(seed * 7919 + m.F * 31 + m.T);
  let iterations = 0;
  // Iteration-capped (deterministic); the time budget is only a safety net on slow devices.
  while (iterations < maxIterations && now() - t0 < budgetMs) {
    iterations++;
    const cand = best.clone();
    const k = 1 + Math.floor(rand() * Math.min(4, m.F));
    const removed: number[] = [];
    for (let j = 0; j < k; j++) {
      const i = Math.floor(rand() * m.F);
      if (!removed.includes(i)) removed.push(i);
    }
    const floor = bestEval.z / FULFIL_SCALE;
    const keepLen = removed.map((i) => cand.len[i]);
    removed.forEach((i) => cand.remove(i));
    // Shift a random neighbour too, to open gaps.
    if (rand() < 0.5) {
      const j = Math.floor(rand() * m.F);
      if (!removed.includes(j) && cand.len[j] > 0) {
        const L = cand.len[j];
        cand.remove(j);
        const s = cand.bestStart(j, L);
        if (s >= 0) cand.set(j, s, L);
        else removed.push(j), keepLen.push(L);
      }
    }
    // Re-insert: random order, try the longest feasible block not below the fairness floor.
    const order = removed.map((i, idx) => ({ i, L: keepLen[idx], r: rand() })).sort((a, b) => a.r - b.r);
    let failed = false;
    for (const { i, L } of order) {
      const minL = Math.max(L > 0 ? m.minRun[i] : 0, floorLen(m, i, floor));
      let placed = minL === 0;
      for (let len = m.R[i]; len >= Math.max(minL, m.minRun[i]); len--) {
        const s = cand.bestStart(i, len);
        if (s >= 0) {
          cand.set(i, s, len);
          placed = true;
          break;
        }
      }
      if (!placed) {
        failed = true;
        break;
      }
    }
    if (failed) continue;
    grow(m, cand);
    level(m, cand, 6);
    const ev = evaluate(m, cand.toSolution());
    if (ev.feasible && (ev.objective > bestEval.objective || (ev.objective === bestEval.objective && ev.peak < bestEval.peak))) {
      best = cand;
      bestEval = ev;
    }
  }
  const polished = best.clone();
  level(m, polished, 200);
  grow(m, polished);
  const pe = evaluate(m, polished.toSolution());
  if (pe.feasible && pe.objective > bestEval.objective) {
    best = polished;
    bestEval = pe;
  }
  return { solution: best.toSolution(), evaluation: bestEval, timeMs: now() - t0, iterations, floorTheta: theta };
}
