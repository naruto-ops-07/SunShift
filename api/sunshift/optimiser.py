"""Feeder-level irrigation scheduling with Google OR-Tools CP-SAT.

Same model as web/src/engine/solver/model.ts:

    x[f,t] ∈ {0,1}  pump f runs in slot t (inside the farmer's window only)
    s[f,t] ∈ {0,1}  pump f starts in slot t
    Σ_t x[f,t] ≤ R_f                       requested runtime
    s[f,t] ≥ x[f,t] − x[f,t−1], Σ_t s ≤ 1  one contiguous window per farm per day
    s[f,t] ⇒ x[f,t+k] for k < minRun        no short-cycling
    Σ_f P_f x[f,t] ≤ C_t                    feeder limit ∧ derated PV (+ grid allowance)
    peak ≥ Σ_f P_f x[f,t]
    R_f z ≤ 1000 Σ_t x[f,t]                 max-min fairness over servable farms

    maximise Σ (c_f + b_t) x + W z − 30 Σ s − 3 peak
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from ortools.sat.python import cp_model

from .model import FULFIL_SCALE, PEAK_WEIGHT, START_PENALTY, IntModel, evaluate


@dataclass
class SolveResult:
    start: list[int]
    length: list[int]
    status: str
    objective: float
    bound: float | None
    gap: float | None
    time_ms: float
    variables: int
    constraints: int
    hint_objective: int | None = None
    notes: list[str] = field(default_factory=list)


def solve_cpsat(
    m: IntModel,
    hint: tuple[list[int], list[int]] | None = None,
    time_limit: float = 5.0,
    workers: int = 8,
    gap_limit: float = 0.002,
) -> SolveResult:
    t0 = time.perf_counter()
    model = cp_model.CpModel()
    x: dict[tuple[int, int], cp_model.IntVar] = {}
    s: dict[tuple[int, int], cp_model.IntVar] = {}
    objective_terms = []

    for i in range(m.F):
        for t in range(m.ws[i], m.we[i]):
            x[i, t] = model.new_bool_var(f"x_{m.ids[i]}_{t}")
            s[i, t] = model.new_bool_var(f"s_{m.ids[i]}_{t}")
            if not m.servable[i]:
                model.add(x[i, t] == 0)
        for t in range(m.ws[i], m.we[i]):
            prev = x[i, t - 1] if t > m.ws[i] else 0
            model.add(s[i, t] >= x[i, t] - prev)
            if t + m.min_run[i] > m.we[i]:
                model.add(s[i, t] == 0)
            else:
                for k in range(1, m.min_run[i]):
                    model.add_implication(s[i, t], x[i, t + k])
            objective_terms.append((m.c[i] + m.b[t]) * x[i, t])
            objective_terms.append(-START_PENALTY * s[i, t])
        xs = [x[i, t] for t in range(m.ws[i], m.we[i])]
        model.add(sum(xs) <= m.R[i])
        model.add(sum(s[i, t] for t in range(m.ws[i], m.we[i])) <= 1)

    any_servable = any(m.servable)
    z = model.new_int_var(0, FULFIL_SCALE if any_servable else 0, "z")
    for i in range(m.F):
        if m.servable[i]:
            model.add(m.R[i] * z <= FULFIL_SCALE * sum(x[i, t] for t in range(m.ws[i], m.we[i])))

    peak = model.new_int_var(0, max([0, *m.cap]), "peak")
    for t in range(m.T):
        terms = [m.pw[i] * x[i, t] for i in range(m.F) if (i, t) in x]
        if not terms:
            continue
        load = sum(terms)
        model.add(load <= m.cap[t])
        model.add(load <= peak)

    model.maximize(sum(objective_terms) + m.W * z - PEAK_WEIGHT * peak)

    hint_obj = None
    if hint is not None:
        hs, hl = hint
        ev = evaluate(m, hs, hl)
        if ev.feasible:
            hint_obj = ev.objective
            for i in range(m.F):
                for t in range(m.ws[i], m.we[i]):
                    on = hl[i] > 0 and hs[i] <= t < hs[i] + hl[i]
                    model.add_hint(x[i, t], 1 if on else 0)
                    model.add_hint(s[i, t], 1 if (hl[i] > 0 and t == hs[i]) else 0)
            model.add_hint(z, ev.z)
            model.add_hint(peak, ev.peak)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(time_limit)
    solver.parameters.num_workers = int(workers)
    solver.parameters.relative_gap_limit = float(gap_limit)
    solver.parameters.random_seed = 1
    status = solver.solve(model)
    status_name = solver.status_name(status)
    proto = model.proto
    n_vars = len(proto.variables)
    n_cons = len(proto.constraints)

    start = [-1] * m.F
    length = [0] * m.F
    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        for i in range(m.F):
            on = [t for t in range(m.ws[i], m.we[i]) if solver.value(x[i, t])]
            if on:
                start[i] = on[0]
                length[i] = len(on)
        obj = solver.objective_value
        bound = solver.best_objective_bound
        gap = abs(bound - obj) / max(1.0, abs(obj))
    else:
        obj, bound, gap = float("nan"), None, None

    return SolveResult(
        start=start,
        length=length,
        status={"OPTIMAL": "OPTIMAL", "FEASIBLE": "FEASIBLE", "INFEASIBLE": "INFEASIBLE"}.get(status_name, "ERROR"),
        objective=obj,
        bound=bound,
        gap=gap,
        time_ms=(time.perf_counter() - t0) * 1000,
        variables=n_vars,
        constraints=n_cons,
        hint_objective=hint_obj,
    )
