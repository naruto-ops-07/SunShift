// Time-indexed MILP for HiGHS — the same model as model.ts, in sparse row form.

import type { Solution } from '../types';
import { FULFIL_SCALE, PEAK_WEIGHT, START_PENALTY, type IntModel } from './model';

export interface MilpData {
  numCols: number;
  numRows: number;
  colCost: Float64Array;
  colLower: Float64Array;
  colUpper: Float64Array;
  rowLower: Float64Array;
  rowUpper: Float64Array;
  starts: Int32Array;
  indices: Int32Array;
  values: Float64Array;
  integrality: Int32Array;
  xIndex: number[][]; // [farm][t] → column or -1
  sIndex: number[][];
  zCol: number;
  peakCol: number;
}

export function buildMilp(m: IntModel): MilpData {
  const xIndex: number[][] = [];
  const sIndex: number[][] = [];
  const cost: number[] = [];
  const lower: number[] = [];
  const upper: number[] = [];
  const integ: number[] = [];
  const addCol = (c: number, lo: number, hi: number, int: boolean) => {
    cost.push(c);
    lower.push(lo);
    upper.push(hi);
    integ.push(int ? 1 : 0);
    return cost.length - 1;
  };
  for (let i = 0; i < m.F; i++) {
    const xi = new Array(m.T).fill(-1);
    const si = new Array(m.T).fill(-1);
    for (let t = m.ws[i]; t < m.we[i]; t++) {
      xi[t] = addCol(m.c[i] + m.b[t], 0, m.servable[i] ? 1 : 0, true);
    }
    for (let t = m.ws[i]; t < m.we[i]; t++) {
      const fitsMinRun = t + m.minRun[i] <= m.we[i];
      si[t] = addCol(-START_PENALTY, 0, fitsMinRun && m.servable[i] ? 1 : 0, true);
    }
    xIndex.push(xi);
    sIndex.push(si);
  }
  const anyServable = m.servable.some(Boolean);
  const zCol = addCol(m.W, 0, anyServable ? FULFIL_SCALE : 0, true);
  const peakCol = addCol(-PEAK_WEIGHT, 0, Number.MAX_SAFE_INTEGER / 1e6, false);

  const rowLo: number[] = [];
  const rowHi: number[] = [];
  const starts: number[] = [0];
  const idx: number[] = [];
  const val: number[] = [];
  const INF = Infinity;
  const addRow = (cols: number[], coefs: number[], lo: number, hi: number) => {
    for (let k = 0; k < cols.length; k++) {
      idx.push(cols[k]);
      val.push(coefs[k]);
    }
    starts.push(idx.length);
    rowLo.push(lo);
    rowHi.push(hi);
  };

  for (let i = 0; i < m.F; i++) {
    const xs: number[] = [];
    const ss: number[] = [];
    for (let t = m.ws[i]; t < m.we[i]; t++) {
      const x = xIndex[i][t];
      const s = sIndex[i][t];
      xs.push(x);
      ss.push(s);
      // s ≥ x − x_prev
      if (t > m.ws[i]) addRow([s, x, xIndex[i][t - 1]], [1, -1, 1], 0, INF);
      else addRow([s, x], [1, -1], 0, INF);
      // minimum run: s ⇒ x[t+k]
      for (let k = 1; k < m.minRun[i]; k++) if (t + k < m.we[i]) addRow([xIndex[i][t + k], s], [1, -1], 0, INF);
    }
    addRow(xs, xs.map(() => 1), -INF, m.R[i]);
    addRow(ss, ss.map(() => 1), -INF, 1);
    if (m.servable[i]) addRow([zCol, ...xs], [m.R[i], ...xs.map(() => -FULFIL_SCALE)], -INF, 0);
  }
  for (let t = 0; t < m.T; t++) {
    const cols: number[] = [];
    const coefs: number[] = [];
    for (let i = 0; i < m.F; i++) {
      const x = xIndex[i][t];
      if (x >= 0) {
        cols.push(x);
        coefs.push(m.pw[i]);
      }
    }
    if (!cols.length) continue;
    addRow(cols, coefs, -INF, m.cap[t]);
    addRow([...cols, peakCol], [...coefs, -1], -INF, 0);
  }
  return {
    numCols: cost.length,
    numRows: rowLo.length,
    colCost: Float64Array.from(cost),
    colLower: Float64Array.from(lower),
    colUpper: Float64Array.from(upper),
    rowLower: Float64Array.from(rowLo),
    rowUpper: Float64Array.from(rowHi),
    starts: Int32Array.from(starts),
    indices: Int32Array.from(idx),
    values: Float64Array.from(val),
    integrality: Int32Array.from(integ),
    xIndex,
    sIndex,
    zCol,
    peakCol,
  };
}

export function warmStart(d: MilpData, m: IntModel, sol: Solution, z: number, peak: number): Float64Array {
  const v = new Float64Array(d.numCols);
  for (let i = 0; i < m.F; i++) {
    const L = sol.length[i];
    if (L <= 0) continue;
    v[d.sIndex[i][sol.start[i]]] = 1;
    for (let t = sol.start[i]; t < sol.start[i] + L; t++) v[d.xIndex[i][t]] = 1;
  }
  v[d.zCol] = z;
  v[d.peakCol] = peak;
  return v;
}

export function decode(d: MilpData, m: IntModel, colValue: ArrayLike<number>): Solution {
  const start: number[] = [];
  const length: number[] = [];
  for (let i = 0; i < m.F; i++) {
    let s = -1;
    let L = 0;
    for (let t = m.ws[i]; t < m.we[i]; t++) {
      if (colValue[d.xIndex[i][t]] > 0.5) {
        if (s < 0) s = t;
        L++;
      }
    }
    start.push(L > 0 ? s : -1);
    length.push(L);
  }
  return { start, length };
}
