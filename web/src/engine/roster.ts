import raw from '@shared/feeder07.json';
import type { CropId, CropSpec, FarmSpec, LocationSpec, MethodId, Scenario, SoilId, SoilSpec, SolarPlantSpec } from './types';

// The demonstration feeder. Shared with the Python API so both engines solve the same problem.
export const ROSTER = raw as unknown as {
  feeder: {
    id: string;
    name: string;
    dataLabel: string;
    transformerKva: number;
    feederLimitKw: number;
    gridAllowanceKw: number;
    forecastReserve: number;
    solar: SolarPlantSpec;
    slots: { startHour: number; minutes: number; count: number };
    minRunSlots: number;
    tripLockoutSlots: number;
  };
  locations: LocationSpec[];
  soils: Record<SoilId, SoilSpec>;
  crops: Record<CropId, CropSpec>;
  irrigationMethods: Record<MethodId, { label: string; efficiency: number }>;
  pump: { motorEfficiency: Record<string, number>; pumpEfficiency: number };
  farms: FarmSpec[];
};

export const FEEDER = ROSTER.feeder;
export const SLOT_COUNT = FEEDER.slots.count;
export const SLOT_HOURS = FEEDER.slots.minutes / 60;
export const START_HOUR = FEEDER.slots.startHour;
export const CROP_IDS: CropId[] = ['cotton', 'maize', 'groundnut', 'chilli'];

export function farmCode(id: number): string {
  return `Farm ${String(id).padStart(2, '0')}`;
}

export function slotLabel(t: number): string {
  const mins = START_HOUR * 60 + t * FEEDER.slots.minutes;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function slotToHour(t: number): number {
  return START_HOUR + t * SLOT_HOURS;
}

export function hourToSlot(h: number): number {
  return Math.round((h - START_HOUR) / SLOT_HOURS);
}

export function getLocation(id: string): LocationSpec {
  return ROSTER.locations.find((l) => l.id === id) ?? ROSTER.locations[0];
}

/** Electrical input power of the pumpset (kW) from its nameplate HP. */
export function pumpKw(hp: number): number {
  const eta = ROSTER.pump.motorEfficiency[String(hp)] ?? 0.83;
  return (hp * 0.746) / eta;
}

/** Delivered flow (m³/h) at the given total dynamic head: Q = η·P_shaft / (ρ g H). */
export function pumpFlowM3h(hp: number, headM: number): number {
  const shaftW = hp * 746;
  const hydraulicW = ROSTER.pump.pumpEfficiency * shaftW;
  return (hydraulicW / (1000 * 9.81 * headM)) * 3600;
}

export function applyOverrides(spec: FarmSpec, scenario: Scenario): FarmSpec & { demandScale: number } {
  const o = scenario.farmOverrides[spec.id] ?? {};
  const { demandScale, ...rest } = o;
  return { ...spec, ...rest, demandScale: demandScale ?? 1 };
}

export function defaultScenario(date: string): Scenario {
  return {
    date,
    locationId: ROSTER.locations[0].id,
    solarKwp: FEEDER.solar.dcKwp,
    inverterKw: FEEDER.solar.acKw,
    feederLimitKw: FEEDER.feederLimitKw,
    gridAllowanceKw: FEEDER.gridAllowanceKw,
    forecastReserve: FEEDER.forecastReserve,
    demandScale: 1,
    fairnessWeight: 40,
    rainOverrideMm: null,
    cloudEvent: null,
    farmOverrides: {},
    carryOver: {},
    baselineHabitScale: 1,
  };
}
