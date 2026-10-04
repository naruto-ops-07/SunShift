// SunShift engine — shared data model.
// Every number the UI shows is produced from these structures by the engine;
// nothing downstream hard-codes results.

export type CropId = 'cotton' | 'maize' | 'groundnut' | 'chilli';
export type SoilId = 'sandy_loam' | 'red_loam' | 'clay_loam' | 'black_cotton';
export type MethodId = 'drip' | 'sprinkler' | 'furrow';
export type Lang = 'te' | 'hi' | 'en';

export interface CropSpec {
  label: string;
  kcIni: number;
  kcMid: number;
  kcEnd: number;
  stageDays: [number, number, number, number];
  stageLabels: [string, string, string, string];
  rootMin: number;
  rootMax: number;
  p: number;
  heightM: number;
  stageSensitivity: [number, number, number, number];
}

export interface SoilSpec {
  label: string;
  thetaFC: number;
  thetaWP: number;
}

export interface FarmSpec {
  id: number;
  crop: CropId;
  areaHa: number;
  soil: SoilId;
  method: MethodId;
  pumpHp: number;
  headM: number;
  sowingDaysAgo: number;
  initDepletion: number; // fraction of TAW at start of simulation
  window: [number, number]; // farmer availability, local hours
  maxHours: number; // max pumping hours the farmer can attend per day
  lang: Lang;
  habit: { start: number; hours: number; everyDays: number; phase: number };
}

export interface LocationSpec {
  id: string;
  label: string;
  lat: number;
  lon: number;
  elevation: number;
  timezone: string;
  utcOffsetHours: number;
  linkeTurbidity: number[];
  climate: {
    tmax: number[];
    tmin: number[];
    rhMean: number[];
    wind10: number[];
    rainDays: number[];
    rainMm: number[];
    cloud: number[];
  };
}

export interface SolarPlantSpec {
  dcKwp: number;
  acKw: number;
  tiltDeg: number;
  azimuthDeg: number;
  gammaPdc: number;
  systemLosses: number;
  albedo: number;
}

/** Everything a user can change. The pipeline is a pure function of this + weather. */
export interface Scenario {
  date: string; // YYYY-MM-DD, local (IST)
  locationId: string;
  solarKwp: number;
  inverterKw: number;
  feederLimitKw: number;
  gridAllowanceKw: number;
  forecastReserve: number; // fraction of PV forecast held back for uncertainty
  demandScale: number; // multiplies every farm's irrigation requirement
  fairnessWeight: number; // weight of the max-min fairness term
  rainOverrideMm: number | null; // inject a rain forecast for today (what-if)
  cloudEvent: { fromHour: number; toHour: number; factor: number } | null; // what-if solar dip
  farmOverrides: Record<number, Partial<Pick<FarmSpec, 'crop' | 'window' | 'maxHours' | 'pumpHp' | 'areaHa'>> & { demandScale?: number }>;
  carryOver: Record<number, number>; // yesterday's unmet fraction per farm (0..1) — fairness memory
  baselineHabitScale: number; // baseline assumption: multiplies farmers' habitual pumping hours
}

export type WeatherSource = 'open-meteo' | 'synthetic' | 'open-meteo-archive' | 'mixed';

export interface HourlyWeather {
  time: string[]; // local ISO hour (YYYY-MM-DDTHH:00), value = mean over the preceding hour
  temp: number[];
  rh: number[];
  wind10: number[];
  ghi: number[];
  dni: number[] | null;
  dhi: number[] | null;
  cloud: number[];
  precip: number[];
  precipProb: number[] | null;
  et0Ref: number[] | null; // provider's ET0 (for cross-checking only)
}

export interface DailyWeather {
  date: string;
  tmax: number;
  tmin: number;
  rhMax: number;
  rhMin: number;
  rhMean: number;
  wind2: number;
  rsMJ: number;
  precip: number;
  precipProb: number; // 0..100
  cloudMean: number; // 0..1
  et0Ref: number | null;
}

export interface WeatherBundle {
  source: WeatherSource;
  label: string; // human description shown in the UI
  fetchedAt: string;
  locationId: string;
  hourly: HourlyWeather;
  daily: DailyWeather[];
}

export interface SolarSlot {
  t: number;
  label: string; // "09:15"
  hourCenter: number; // local decimal hour at slot centre
  zenith: number;
  ghi: number;
  dni: number;
  dhi: number;
  poa: number;
  cellTemp: number;
  dcKw: number;
  acKw: number;
  clearSkyAcKw: number;
}

export interface SolarDay {
  slots: SolarSlot[];
  energyKwh: number;
  peakKw: number;
  clearSkyEnergyKwh: number;
}

export interface StageInfo {
  index: 0 | 1 | 2 | 3 | -1 | 4; // -1 = not sown yet, 4 = harvested
  label: string;
  cropDay: number;
  kc: number;
  rootDepth: number;
  sensitivity: number;
}

export type DecisionCode = 'irrigate' | 'rain' | 'sufficient' | 'fallow';

export interface PriorityFactor {
  key: 'soil' | 'stage' | 'rain' | 'carry' | 'solar' | 'feeder';
  label: string;
  value: string;
  level: 'HIGH' | 'MEDIUM' | 'LOW' | 'AVAILABLE' | 'LIMITED';
  contribution: number;
}

export interface FarmDay {
  id: number;
  code: string; // "Farm 07"
  spec: FarmSpec; // after overrides
  cropLabel: string;
  soilLabel: string;
  methodLabel: string;
  stage: StageInfo;
  pumpKw: number;
  flowM3h: number;
  efficiency: number;
  taw: number; // mm
  raw: number; // mm
  depletionStart: number; // mm at start of day
  et0: number; // mm/day (today, forecast)
  etc: number; // mm/day
  rainForecast24: number; // mm (expected)
  rainForecast48: number;
  projectedDepletion: number; // mm by end of day without irrigation
  netNeedMm: number;
  grossNeedM3: number; // full agronomic need (may exceed what one day of pumping can deliver)
  requestM3: number; // what is requested today, capped by the farmer's hours
  requestedSlots: number;
  decision: DecisionCode;
  reason: string;
  priority: number; // w_f
  priorityLevel: 'HIGH' | 'MEDIUM' | 'LOW';
  factors: PriorityFactor[];
  soilStatusPct: number; // available water remaining in root zone, % of TAW
}

export interface SolverInfo {
  name: 'heuristic' | 'highs' | 'cp-sat';
  label: string;
  status: 'OPTIMAL' | 'FEASIBLE' | 'HEURISTIC' | 'INFEASIBLE' | 'ERROR';
  objective: number;
  bound: number | null;
  gap: number | null;
  timeMs: number;
  variables: number;
  constraints: number;
  where: 'browser' | 'server';
  note?: string;
}

export interface FarmSchedule {
  id: number;
  start: number; // slot index, -1 if none
  length: number; // slots
  requested: number;
  fulfilment: number; // 0..1 of requested
  waterM3: number;
  energyKwh: number;
}

export interface PlanResult {
  kind: 'sunshift' | 'baseline';
  schedules: FarmSchedule[];
  on: boolean[][]; // [farm index][slot] pump actually running (after trips for baseline)
  load: number[]; // kW per slot actually drawn
  attemptedLoad: number[]; // kW per slot pumps tried to draw (differs from load when the feeder trips)
  trips: boolean[]; // feeder protection trips (baseline only)
  solver: SolverInfo | null;
}

export interface DayMetrics {
  waterPumpedM3: number;
  waterBeneficialM3: number;
  waterLostM3: number;
  energyKwh: number;
  solarUsedKwh: number;
  gridImportKwh: number;
  solarSpillKwh: number;
  solarEnergyKwh: number;
  peakKw: number;
  overloadSlots: number;
  trips: number;
  needM3: number; // volume requested today across farms (gross, capped by farmer hours)
  fulfilment: number; // delivered beneficial / need (0..1)
  solarShare: number; // pumping energy supplied by sun (0..1)
  solarAbsorbed: number; // share of PV generation used by pumps
  jain: number; // Jain fairness index over farm fulfilment
  minFulfilment: number;
  farmsNeeding: number;
  farmsServed: number; // farms with need that got >= 90 %
  farmFulfilment: Record<number, number>;
}

export interface Problem {
  T: number;
  slotHours: number;
  cap: number[]; // kW per slot (scaled later)
  solar: number[]; // kW per slot (for alignment bonus)
  farms: {
    id: number;
    powerKw: number;
    requested: number;
    minRun: number;
    windowStart: number; // inclusive slot
    windowEnd: number; // exclusive slot
    weight: number;
  }[];
  fairnessWeight: number;
}

export interface Solution {
  start: number[];
  length: number[];
}

export interface ConstraintSnapshot {
  slot: number;
  label: string;
  solarKw: number;
  feederLimitKw: number;
  capacityKw: number;
  loadKw: number;
  remainingKw: number;
  waterDeliveredM3: number;
  waterScheduledM3: number;
  binding: 'SOLAR' | 'FEEDER' | 'DEMAND' | 'NONE';
}

export interface PipelineResult {
  scenario: Scenario;
  weather: WeatherBundle;
  todayIndex: number;
  solar: SolarDay;
  capacity: number[];
  farms: FarmDay[];
  problem: Problem;
  plan: PlanResult;
  baseline: PlanResult;
  metrics: { sunshift: DayMetrics; baseline: DayMetrics };
  computedAt: string;
}
