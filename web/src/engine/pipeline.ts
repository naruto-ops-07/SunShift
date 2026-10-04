// The SunShift pipeline: weather → PV → agronomy → demand → optimiser → baseline → metrics.
// Pure and synchronous (heuristic solver); `refine.ts` swaps in HiGHS or CP-SAT plans.

import { simulateBaseline } from './baseline';
import { buildProblem, computeFarmDays } from './demand';
import { dayMetrics } from './metrics';
import { SLOT_COUNT, SLOT_HOURS } from './roster';
import { capacityProfile, computeSolarDay, plantFromScenario } from './solar';
import { solveHeuristic } from './solver/heuristic';
import { toIntModel, type IntModel } from './solver/model';
import { dailyIndex } from './weather';
import type { DailyWeather, FarmDay, PipelineResult, PlanResult, Scenario, Solution, SolverInfo, WeatherBundle } from './types';

export function applyWhatIf(day: DailyWeather, s: Scenario): DailyWeather {
  if (s.rainOverrideMm === null || s.rainOverrideMm === undefined) return day;
  return { ...day, precip: s.rainOverrideMm, precipProb: Math.max(day.precipProb, 90) };
}

export function planFromSolution(m: IntModel, sol: Solution, farms: FarmDay[], solver: SolverInfo | null): PlanResult {
  const on = farms.map(() => new Array<boolean>(SLOT_COUNT).fill(false));
  const load = new Array(SLOT_COUNT).fill(0);
  const byId = new Map<number, number>();
  m.ids.forEach((id, i) => byId.set(id, i));
  const schedules = farms.map((f, fi) => {
    const i = byId.get(f.id);
    const start = i === undefined ? -1 : sol.start[i];
    const length = i === undefined ? 0 : sol.length[i];
    for (let t = start; t >= 0 && t < start + length; t++) {
      on[fi][t] = true;
      load[t] += f.pumpKw;
    }
    return {
      id: f.id,
      start: length > 0 ? start : -1,
      length,
      requested: f.requestedSlots,
      fulfilment: f.requestedSlots > 0 ? length / f.requestedSlots : 0,
      waterM3: length * f.flowM3h * SLOT_HOURS,
      energyKwh: length * f.pumpKw * SLOT_HOURS,
    };
  });
  return { kind: 'sunshift', schedules, on, load, attemptedLoad: load.slice(), trips: new Array(SLOT_COUNT).fill(false), solver };
}

/** Add the post-solve explanation: how sunny and how congested was the window each farm got? */
export function explainAssignments(farms: FarmDay[], plan: PlanResult, solarAc: number[], cap: number[]): FarmDay[] {
  const peakPv = Math.max(1e-6, ...solarAc);
  return farms.map((f, i) => {
    const sch = plan.schedules[i];
    const factors = f.factors.filter((x) => x.key !== 'solar' && x.key !== 'feeder');
    if (sch.length > 0) {
      let pv = 0;
      let head = 0;
      for (let t = sch.start; t < sch.start + sch.length; t++) {
        pv += solarAc[t];
        head += cap[t] - plan.load[t];
      }
      pv /= sch.length;
      head /= sch.length;
      const rel = pv / peakPv;
      factors.push({ key: 'solar', label: 'Solar availability', value: `${pv.toFixed(0)} kW avg in window`, level: rel >= 0.7 ? 'HIGH' : rel >= 0.4 ? 'MEDIUM' : 'LOW', contribution: 0 });
      factors.push({ key: 'feeder', label: 'Feeder capacity', value: `${head.toFixed(1)} kW spare in window`, level: head >= f.pumpKw * 0.5 ? 'AVAILABLE' : 'LIMITED', contribution: 0 });
    } else if (f.requestedSlots > 0) {
      factors.push({ key: 'feeder', label: 'Feeder capacity', value: 'No room in window today', level: 'LIMITED', contribution: 0 });
    }
    return { ...f, factors };
  });
}

export interface PipelineOptions {
  heuristicBudgetMs?: number;
  depletion?: Record<number, number>;
}

export function runPipeline(scenario: Scenario, weather: WeatherBundle, opts: PipelineOptions = {}): PipelineResult {
  const todayIndex = dailyIndex(weather, scenario.date);
  if (todayIndex < 0) throw new Error(`Weather does not cover ${scenario.date}`);
  const today = applyWhatIf(weather.daily[todayIndex], scenario);
  const tomorrow = weather.daily[todayIndex + 1] ?? null;
  const y1 = weather.daily[todayIndex - 1]?.precip ?? 0;
  const y2 = weather.daily[todayIndex - 2]?.precip ?? 0;
  const solar = computeSolarDay(weather, scenario.date, plantFromScenario(scenario), { cloudEvent: scenario.cloudEvent });
  const capacity = capacityProfile(solar, scenario);
  const farms0 = computeFarmDays({ scenario, date: scenario.date, today, tomorrow, recentRain: [y1, y2], depletion: opts.depletion });
  const solarAc = solar.slots.map((s) => s.acKw);
  const problem = buildProblem(farms0, capacity, solarAc, scenario);
  const m = toIntModel(problem);
  const h = solveHeuristic(m, opts.heuristicBudgetMs ?? 40);
  const solver: SolverInfo = {
    name: 'heuristic',
    label: 'Greedy + local search',
    status: 'HEURISTIC',
    objective: h.evaluation.objective,
    bound: null,
    gap: null,
    timeMs: h.timeMs,
    variables: m.F * 2,
    constraints: m.F + m.T,
    where: 'browser',
    note: `${h.iterations} local-search moves`,
  };
  const plan = planFromSolution(m, h.solution, farms0, solver);
  const farms = explainAssignments(farms0, plan, solarAc, capacity);
  const baseline = simulateBaseline(farms, { date: scenario.date, feederLimitKw: scenario.feederLimitKw, rainYesterdayMm: y1, seedKey: scenario.locationId, habitScale: scenario.baselineHabitScale });
  return {
    scenario,
    weather,
    todayIndex,
    solar,
    capacity,
    farms,
    problem,
    plan,
    baseline,
    metrics: {
      sunshift: dayMetrics(plan, farms, solar, scenario.feederLimitKw),
      baseline: dayMetrics(baseline, farms, solar, scenario.feederLimitKw),
    },
    computedAt: new Date().toISOString(),
  };
}

/** Replace the plan in a result with a better solution from another solver. */
export function withPlan(r: PipelineResult, sol: Solution, solver: SolverInfo): PipelineResult {
  const m = toIntModel(r.problem);
  const plan = planFromSolution(m, sol, r.farms, solver);
  const solarAc = r.solar.slots.map((s) => s.acKw);
  const farms = explainAssignments(r.farms, plan, solarAc, r.capacity);
  return {
    ...r,
    farms,
    plan,
    metrics: { ...r.metrics, sunshift: dayMetrics(plan, farms, r.solar, r.scenario.feederLimitKw) },
    computedAt: new Date().toISOString(),
  };
}

