// Day metrics — computed identically for SunShift and the baseline.

import { SLOT_HOURS } from './roster';
import type { ConstraintSnapshot, DayMetrics, FarmDay, PlanResult, SolarDay } from './types';

export function jainIndex(xs: number[]): number {
  if (!xs.length) return 1;
  const s = xs.reduce((a, b) => a + b, 0);
  const s2 = xs.reduce((a, b) => a + b * b, 0);
  return s2 > 0 ? (s * s) / (xs.length * s2) : 1;
}

export function farmWater(f: FarmDay, slots: number) {
  const pumped = slots * f.flowM3h * SLOT_HOURS;
  const netMm = (pumped * f.efficiency) / (f.spec.areaHa * 10);
  const room = Math.max(0, f.projectedDepletion);
  const beneficialMm = Math.min(netMm, room);
  const beneficialGross = (beneficialMm * f.spec.areaHa * 10) / f.efficiency;
  return { pumped, netMm, beneficialMm, beneficialGross, lost: Math.max(0, pumped - beneficialGross) };
}

export function dayMetrics(plan: PlanResult, farms: FarmDay[], solar: SolarDay, feederLimitKw: number): DayMetrics {
  let pumped = 0;
  let beneficial = 0;
  let lost = 0;
  let need = 0;
  let delivered = 0;
  const fulfil: number[] = [];
  const farmFulfilment: Record<number, number> = {};
  let farmsServed = 0;
  farms.forEach((f, i) => {
    const slots = plan.on[i].filter(Boolean).length;
    const w = farmWater(f, slots);
    pumped += w.pumped;
    beneficial += w.beneficialGross;
    lost += w.lost;
    if (f.requestM3 > 0) {
      need += f.requestM3;
      const ff = Math.min(1, w.beneficialGross / f.requestM3);
      delivered += Math.min(f.requestM3, w.beneficialGross);
      fulfil.push(ff);
      farmFulfilment[f.id] = ff;
      if (ff >= 0.9) farmsServed++;
    }
  });
  let energy = 0;
  let solarUsed = 0;
  let grid = 0;
  let spill = 0;
  let solarE = 0;
  let overload = 0;
  plan.load.forEach((l, t) => {
    const pv = solar.slots[t].acKw;
    energy += l * SLOT_HOURS;
    solarUsed += Math.min(l, pv) * SLOT_HOURS;
    grid += Math.max(0, l - pv) * SLOT_HOURS;
    spill += Math.max(0, pv - l) * SLOT_HOURS;
    solarE += pv * SLOT_HOURS;
    if (plan.attemptedLoad[t] > feederLimitKw + 1e-6) overload++;
  });
  return {
    waterPumpedM3: pumped,
    waterBeneficialM3: beneficial,
    waterLostM3: lost,
    energyKwh: energy,
    solarUsedKwh: solarUsed,
    gridImportKwh: grid,
    solarSpillKwh: spill,
    solarEnergyKwh: solarE,
    peakKw: Math.max(0, ...plan.attemptedLoad),
    overloadSlots: overload,
    trips: plan.trips.filter(Boolean).length,
    needM3: need,
    fulfilment: need > 0 ? delivered / need : 1,
    solarShare: energy > 0 ? solarUsed / energy : 1,
    solarAbsorbed: solarE > 0 ? solarUsed / solarE : 0,
    jain: jainIndex(fulfil),
    minFulfilment: fulfil.length ? Math.min(...fulfil) : 1,
    farmsNeeding: fulfil.length,
    farmsServed,
    farmFulfilment,
  };
}

/** Which constraint is binding at a slot: the one with the least headroom. */
export function constraintAt(slot: number, plan: PlanResult, farms: FarmDay[], solar: SolarDay, cap: number[], feederLimitKw: number): ConstraintSnapshot {
  const t = Math.max(0, Math.min(plan.load.length - 1, slot));
  const load = plan.load[t];
  const pv = solar.slots[t].acKw;
  let deliveredM3 = 0;
  let scheduledM3 = 0;
  farms.forEach((f, i) => {
    const n = plan.on[i].filter(Boolean).length;
    const upto = plan.on[i].slice(0, t + 1).filter(Boolean).length;
    scheduledM3 += n * f.flowM3h * SLOT_HOURS;
    deliveredM3 += upto * f.flowM3h * SLOT_HOURS;
  });
  const smallestPump = Math.min(...farms.map((f) => f.pumpKw));
  const solarHead = pv - load;
  const feederHead = feederLimitKw - load;
  let binding: ConstraintSnapshot['binding'] = 'NONE';
  const anyWaiting = farms.some((f, i) => f.requestedSlots > 0 && plan.on[i].filter(Boolean).length < f.requestedSlots);
  if (load > 0 || anyWaiting) {
    if (Math.min(solarHead, feederHead) < smallestPump && anyWaiting) binding = solarHead <= feederHead ? 'SOLAR' : 'FEEDER';
    else binding = anyWaiting ? (solarHead <= feederHead ? 'SOLAR' : 'FEEDER') : 'DEMAND';
  }
  return {
    slot: t,
    label: solar.slots[t].label,
    solarKw: pv,
    feederLimitKw,
    capacityKw: cap[t],
    loadKw: load,
    remainingKw: Math.max(0, cap[t] - load),
    waterDeliveredM3: deliveredM3,
    waterScheduledM3: scheduledM3,
    binding,
  };
}
