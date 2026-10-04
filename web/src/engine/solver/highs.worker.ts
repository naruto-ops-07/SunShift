/// <reference lib="webworker" />
// HiGHS (MILP, compiled to WebAssembly) running off the main thread.
// Warm-started with the heuristic schedule; reports the proven dual bound and gap.

import highsLoader from 'highs';
import wasmUrl from 'highs/runtime?url';
import type { Solution } from '../types';
import { buildMilp, decode, warmStart } from './milp';
import type { IntModel } from './model';

export interface HighsRequest {
  id: number;
  model: IntModel;
  warm: Solution;
  warmZ: number;
  warmPeak: number;
  timeLimit: number;
}

export interface HighsResponse {
  id: number;
  ok: boolean;
  error?: string;
  solution?: Solution;
  status?: 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'ERROR';
  objective?: number;
  bound?: number | null;
  gap?: number | null;
  timeMs?: number;
  variables?: number;
  constraints?: number;
}

let highsPromise: ReturnType<typeof highsLoader> | null = null;

self.onmessage = async (ev: MessageEvent<HighsRequest>) => {
  const req = ev.data;
  const t0 = performance.now();
  try {
    highsPromise ??= highsLoader({ locateFile: () => wasmUrl });
    const highs = await highsPromise;
    const d = buildMilp(req.model);
    const result = highs.withModel((model) => {
      model.passModel({
        numCols: d.numCols,
        numRows: d.numRows,
        sense: highs.constants.objectiveSense.maximize,
        colCost: d.colCost,
        colLower: d.colLower,
        colUpper: d.colUpper,
        rowLower: d.rowLower,
        rowUpper: d.rowUpper,
        matrix: { format: 'csr', numRows: d.numRows, numCols: d.numCols, starts: d.starts, indices: d.indices, values: d.values },
        integrality: d.integrality as unknown as Int32Array,
      });
      model.options.set({ time_limit: req.timeLimit, mip_rel_gap: 0.002, output_flag: false });
      try {
        model.setSolution({ colValue: warmStart(d, req.model, req.warm, req.warmZ, req.warmPeak) });
      } catch {
        /* warm start is optional */
      }
      const run = model.run();
      const status = run.modelStatus;
      let colValue: Float64Array | null = null;
      try {
        colValue = model.getSolution().colValue;
      } catch {
        colValue = null;
      }
      const info = (k: string): number | null => {
        try {
          return Number(model.info.get(k));
        } catch {
          return null;
        }
      };
      return {
        status,
        colValue,
        objective: model.getObjectiveValue(),
        bound: info('mip_dual_bound'),
        gap: info('mip_gap'),
      };
    });
    const hasSol = result.colValue && result.colValue.length === d.numCols;
    const status: HighsResponse['status'] =
      result.status === 7 ? 'OPTIMAL' : result.status === 8 ? 'INFEASIBLE' : hasSol ? 'FEASIBLE' : 'ERROR';
    const res: HighsResponse = {
      id: req.id,
      ok: !!hasSol && status !== 'INFEASIBLE',
      solution: hasSol ? decode(d, req.model, result.colValue!) : undefined,
      status,
      objective: result.objective,
      bound: result.bound !== null && Number.isFinite(result.bound) ? result.bound : null,
      gap: result.gap !== null && Number.isFinite(result.gap) ? result.gap : null,
      timeMs: performance.now() - t0,
      variables: d.numCols,
      constraints: d.numRows,
    };
    (self as unknown as Worker).postMessage(res);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id: req.id, ok: false, error: String(e), timeMs: performance.now() - t0 } satisfies HighsResponse);
  }
};
