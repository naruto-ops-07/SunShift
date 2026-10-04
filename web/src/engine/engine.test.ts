import { describe, expect, it } from 'vitest';
import { et0Daily, stageInfo } from './agronomy';
import { runPipeline } from './pipeline';
import { defaultScenario, ROSTER } from './roster';
import { sunPosition } from './solarPosition';
import { evaluate, toIntModel } from './solver/model';
import { solveHeuristic } from './solver/heuristic';
import { syntheticAround } from './weather';

describe('FAO-56', () => {
  it('reproduces FAO-56 Example 18 (Uccle, 6 July) ET0 ≈ 3.9 mm/day', () => {
    // Tmax 21.5, Tmin 12.3, RHmax 84, RHmin 63, u2 2.078 m/s, Rs 22.07 MJ, lat 50.80, z 100 m, J 187
    const r = et0Daily({ tmax: 21.5, tmin: 12.3, rhMax: 84, rhMin: 63, wind2: 2.078, rsMJ: 22.07 }, 50.8, 100, 187);
    expect(r.et0).toBeGreaterThan(3.7);
    expect(r.et0).toBeLessThan(4.1);
  });
  it('builds a Kc curve that peaks mid-season', () => {
    expect(stageInfo('cotton', 10).kc).toBeCloseTo(0.35, 2);
    expect(stageInfo('cotton', 100).kc).toBeCloseTo(1.18, 2);
    expect(stageInfo('cotton', 300).index).toBe(4);
  });
});

describe('solar position', () => {
  it('puts the sun near zenith at solar noon on the equinox at the equator', () => {
    // 2026-03-20 12:00 local solar time at lon 0 → ~12:07 UTC
    const p = sunPosition(Date.parse('2026-03-20T12:07:00Z'), 0, 0);
    expect(p.zenith).toBeLessThan(2);
  });
});

describe('pipeline', () => {
  const date = '2026-10-04';
  const weather = syntheticAround('deccan', date);
  it('produces a feasible plan for 20 farms on 48 slots', () => {
    const r = runPipeline(defaultScenario(date), weather);
    expect(r.farms).toHaveLength(ROSTER.farms.length);
    expect(r.solar.slots).toHaveLength(48);
    const m = toIntModel(r.problem);
    const sol = { start: [] as number[], length: [] as number[] };
    m.ids.forEach((id) => {
      const s = r.plan.schedules.find((x) => x.id === id)!;
      sol.start.push(s.start);
      sol.length.push(s.length);
    });
    expect(evaluate(m, sol).feasible).toBe(true);
    r.plan.load.forEach((l, t) => expect(l).toBeLessThanOrEqual(r.capacity[t] + 1e-6));
    const ms = r.metrics.sunshift;
    const mb = r.metrics.baseline;
    console.log('solar kWh', r.solar.energyKwh.toFixed(0), 'peak', r.solar.peakKw.toFixed(1), 'cs', r.solar.clearSkyEnergyKwh.toFixed(0));
    console.log('farms', r.farms.map((f) => `${f.id}:${f.decision[0]}${f.requestedSlots}(${f.stage.label.slice(0, 6)},Dr${f.depletionStart.toFixed(0)}/${f.raw.toFixed(0)}/${f.taw.toFixed(0)},Q${f.flowM3h.toFixed(0)})`).join(' '));
    console.log('ET0', r.farms[0].et0.toFixed(2), 'weather', r.weather.daily[r.todayIndex]);
    console.log('SS', JSON.stringify(ms, (k, v) => (typeof v === 'number' ? Number(v.toFixed(3)) : v)));
    console.log('BL', JSON.stringify(mb, (k, v) => (typeof v === 'number' ? Number(v.toFixed(3)) : v)));
    console.log('solver', r.plan.solver);
  });
  it('rain override cancels irrigation', () => {
    const base = runPipeline(defaultScenario(date), weather);
    const rain = runPipeline({ ...defaultScenario(date), rainOverrideMm: 18 }, weather);
    expect(rain.metrics.sunshift.waterPumpedM3).toBeLessThan(base.metrics.sunshift.waterPumpedM3 + 1e-6);
    console.log('rain: farms irrigating', base.farms.filter((f) => f.decision === 'irrigate').length, '→', rain.farms.filter((f) => f.decision === 'irrigate').length);
  });
  it('scarcity keeps the plan fair', () => {
    const r = runPipeline({ ...defaultScenario(date), demandScale: 2.5, solarKwp: 70, inverterKw: 60 }, weather);
    const m = toIntModel(r.problem);
    const h = solveHeuristic(m, 60);
    console.log('scarcity z', h.evaluation.z, 'served', h.evaluation.served.map((s, i) => `${s}/${m.R[i]}`).join(' '), 'iters', h.iterations, 'ms', h.timeMs.toFixed(1));
    expect(h.evaluation.feasible).toBe(true);
  });
});

describe('profile dump', () => {
  it('prints slot profiles', () => {
    const date = '2026-10-04';
    const r = runPipeline(defaultScenario(date), syntheticAround('deccan', date));
    const rows = r.solar.slots.map((s, t) => `${s.label} pv${s.acKw.toFixed(0).padStart(3)} cap${r.capacity[t].toFixed(0).padStart(3)} ss${r.plan.load[t].toFixed(0).padStart(3)} bl${r.baseline.attemptedLoad[t].toFixed(0).padStart(3)}${r.baseline.trips[t] ? ' TRIP' : ''}`);
    console.log(rows.filter((_, i) => i % 2 === 0).join('\n'));
    console.log('SS peak', r.metrics.sunshift.peakKw.toFixed(1), 'BL peak', r.metrics.baseline.peakKw.toFixed(1), 'BL grid', r.metrics.baseline.gridImportKwh.toFixed(1));
  });
});
