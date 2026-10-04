import { describe, it } from 'vitest';
import highsLoader from 'highs';
import { runPipeline } from './pipeline';
import { defaultScenario } from './roster';
import { buildMilp, decode, warmStart } from './solver/milp';
import { evaluate, toIntModel } from './solver/model';
import { solveHeuristic } from './solver/heuristic';
import { syntheticAround } from './weather';

describe('highs', () => {
  it('refines the heuristic', async () => {
    const highs = await highsLoader();
    const date = '2026-10-04';
    for (const sc of [defaultScenario(date), { ...defaultScenario(date), demandScale: 1.6, solarKwp: 70, inverterKw: 60 }]) {
      const r = runPipeline(sc, syntheticAround('deccan', date));
      const m = toIntModel(r.problem);
      const h = solveHeuristic(m, 40);
      const d = buildMilp(m);
      const t0 = Date.now();
      const out = highs.withModel((model) => {
        model.passModel({ numCols: d.numCols, numRows: d.numRows, sense: highs.constants.objectiveSense.maximize, colCost: d.colCost, colLower: d.colLower, colUpper: d.colUpper, rowLower: d.rowLower, rowUpper: d.rowUpper, matrix: { format: 'csr', numRows: d.numRows, numCols: d.numCols, starts: d.starts, indices: d.indices, values: d.values }, integrality: d.integrality as any });
        model.options.set({ time_limit: 6, mip_rel_gap: 0.002, output_flag: false });
        model.setSolution({ colValue: warmStart(d, m, h.solution, h.evaluation.z, h.evaluation.peak) });
        const run = model.run();
        return { status: run.modelStatus, col: model.getSolution().colValue, obj: model.getObjectiveValue(), bound: Number(model.info.get('mip_dual_bound')), gap: Number(model.info.get('mip_gap')) };
      });
      const sol = decode(d, m, out.col);
      const ev = evaluate(m, sol);
      console.log(`heur obj ${h.evaluation.objective} z ${h.evaluation.z} peak ${h.evaluation.peak / 10} | highs status ${out.status} obj ${out.obj} bound ${out.bound.toFixed(0)} gap ${(out.gap * 100).toFixed(2)}% feasible ${ev.feasible} z ${ev.z} peak ${ev.peak / 10} t ${Date.now() - t0}ms vars ${d.numCols} rows ${d.numRows}`);
    }
  }, 30000);
});
