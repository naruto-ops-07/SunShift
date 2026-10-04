"""The SunShift scheduling model in integer form — a line-by-line mirror of
web/src/engine/solver/model.ts so CP-SAT and the browser solvers optimise the same thing."""

from __future__ import annotations

import math
from dataclasses import dataclass

from .roster import js_round

FULFIL_SCALE = 1000
START_PENALTY = 30
POWER_SCALE = 10
PEAK_WEIGHT = 3
SOLAR_BONUS = 5


@dataclass
class IntModel:
    T: int
    ids: list[int]
    pw: list[int]
    R: list[int]
    min_run: list[int]
    ws: list[int]
    we: list[int]
    c: list[int]
    b: list[int]
    cap: list[int]
    W: int
    servable: list[bool]

    @property
    def F(self) -> int:
        return len(self.ids)


def to_int_model(problem: dict) -> IntModel:
    T = int(problem["T"])
    solar = [float(v) for v in problem["solar"]]
    max_solar = max([1e-6, *solar])
    cap = [max(0, math.floor(float(c) * POWER_SCALE + 1e-6)) for c in problem["cap"]]
    farms = [f for f in problem["farms"] if f["requested"] > 0 and f["windowEnd"] - f["windowStart"] >= f["minRun"]]
    pw = [js_round(f["powerKw"] * POWER_SCALE) for f in farms]
    R = [min(int(f["requested"]), int(f["windowEnd"]) - int(f["windowStart"])) for f in farms]
    min_run = [min(int(f["minRun"]), R[i]) for i, f in enumerate(farms)]
    ws = [int(f["windowStart"]) for f in farms]
    we = [int(f["windowEnd"]) for f in farms]

    def servable(i: int) -> bool:
        run = 0
        for t in range(ws[i], we[i]):
            run = run + 1 if cap[t] >= pw[i] else 0
            if run >= min_run[i]:
                return True
        return False

    return IntModel(
        T=T,
        ids=[int(f["id"]) for f in farms],
        pw=pw,
        R=R,
        min_run=min_run,
        ws=ws,
        we=we,
        c=[js_round(FULFIL_SCALE * float(f["weight"]) / R[i]) for i, f in enumerate(farms)],
        b=[js_round(SOLAR_BONUS * s / max_solar) for s in solar],
        cap=cap,
        W=max(0, js_round(float(problem.get("fairnessWeight", 40)))),
        servable=[servable(i) for i in range(len(farms))],
    )


@dataclass
class Evaluation:
    feasible: bool
    objective: int
    served: list[int]
    z: int
    peak: int
    load: list[int]
    violations: list[str]


def evaluate(m: IntModel, start: list[int], length: list[int]) -> Evaluation:
    load = [0] * m.T
    violations: list[str] = []
    obj = 0
    served = []
    for i in range(m.F):
        s, L = start[i], length[i]
        served.append(max(L, 0))
        if L <= 0:
            continue
        if s < m.ws[i] or s + L > m.we[i]:
            violations.append(f"farm {m.ids[i]} outside window")
        if L > m.R[i]:
            violations.append(f"farm {m.ids[i]} exceeds request")
        if L < m.min_run[i]:
            violations.append(f"farm {m.ids[i]} below min run")
        obj -= START_PENALTY
        for t in range(s, s + L):
            load[t] += m.pw[i]
            obj += m.c[i] + m.b[t]
    for t in range(m.T):
        if load[t] > m.cap[t]:
            violations.append(f"slot {t} over capacity")
    srv = [i for i in range(m.F) if m.servable[i]]
    z = min((FULFIL_SCALE * served[i]) // m.R[i] for i in srv) if srv else 0
    z = min(z, FULFIL_SCALE)
    peak = max([0, *load])
    obj += m.W * z - PEAK_WEIGHT * peak
    return Evaluation(not violations, obj, served, z, peak, load, violations)
