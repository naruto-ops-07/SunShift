"""Constructive warm start for CP-SAT: fairness floor by bisection, priority growth and
load levelling (the first phases of web/src/engine/solver/heuristic.ts)."""

from __future__ import annotations

import math

from .model import PEAK_WEIGHT, START_PENALTY, IntModel


class _State:
    def __init__(self, m: IntModel):
        self.m = m
        self.res = list(m.cap)
        self.start = [-1] * m.F
        self.len = [0] * m.F

    def remove(self, i: int) -> None:
        if self.len[i] > 0:
            for t in range(self.start[i], self.start[i] + self.len[i]):
                self.res[t] += self.m.pw[i]
        self.start[i], self.len[i] = -1, 0

    def set(self, i: int, s: int, L: int) -> None:
        self.remove(i)
        for t in range(s, s + L):
            self.res[t] -= self.m.pw[i]
        self.start[i] = s if L > 0 else -1
        self.len[i] = L

    def best_start(self, i: int, L: int) -> int:
        m = self.m
        best, best_score = -1, -math.inf
        for s in range(m.ws[i], m.we[i] - L + 1):
            block = self.res[s : s + L]
            if min(block) < m.pw[i]:
                continue
            score = (min(block) - m.pw[i]) * 100 + sum(m.b[s : s + L])
            if score > best_score:
                best, best_score = s, score
        return best


def _floor_len(m: IntModel, i: int, theta: float) -> int:
    if not m.servable[i] or theta <= 0:
        return 0
    return min(m.R[i], max(m.min_run[i], math.ceil(theta * m.R[i] - 1e-9)))


def _place_floor(m: IntModel, theta: float) -> _State | None:
    st = _State(m)
    order = sorted(range(m.F), key=lambda i: (-m.pw[i] * _floor_len(m, i, theta), m.we[i] - m.ws[i]))
    for i in order:
        L = _floor_len(m, i, theta)
        if L == 0:
            continue
        s = st.best_start(i, L)
        if s < 0:
            return None
        st.set(i, s, L)
    return st


def _grow(m: IntModel, st: _State) -> None:
    for _ in range(5000):
        load = [c - r for c, r in zip(m.cap, st.res)]
        peak = max([0, *load])
        best = (0.0, -1, 0, 0)
        for i in range(m.F):
            if not m.servable[i] or st.len[i] >= m.R[i]:
                continue
            if st.len[i] == 0:
                L = m.min_run[i]
                s = st.best_start(i, L)
                if s < 0:
                    continue
                new_peak = max([peak] + [load[t] + m.pw[i] for t in range(s, s + L)])
                g = -START_PENALTY + sum(m.c[i] + m.b[t] for t in range(s, s + L)) - PEAK_WEIGHT * (new_peak - peak)
                if g > best[0]:
                    best = (g, i, s, L)
            else:
                s0, e0 = st.start[i], st.start[i] + st.len[i]
                for side in (-1, 1):
                    t = s0 - 1 if side < 0 else e0
                    if t < m.ws[i] or t >= m.we[i] or st.res[t] < m.pw[i]:
                        continue
                    g = m.c[i] + m.b[t] - PEAK_WEIGHT * max(0, load[t] + m.pw[i] - peak) + st.res[t] / 1e6
                    if g > best[0]:
                        best = (g, i, s0 - 1 if side < 0 else s0, st.len[i] + 1)
        if best[1] < 0:
            return
        _, i, s, L = best
        st.set(i, s, L)


def _level(m: IntModel, st: _State, max_iter: int = 200) -> None:
    for _ in range(max_iter):
        load = [c - r for c, r in zip(m.cap, st.res)]
        peak = max([0, *load])
        if peak == 0:
            return
        on_peak = [i for i in range(m.F) if st.len[i] and any(load[t] == peak for t in range(st.start[i], st.start[i] + st.len[i]))]
        on_peak.sort(key=lambda i: -m.pw[i])
        improved = False
        for i in on_peak:
            L, s0 = st.len[i], st.start[i]
            st.remove(i)
            base = [c - r for c, r in zip(m.cap, st.res)]
            best_s, best_max, best_bonus = -1, math.inf, -1
            for s in range(m.ws[i], m.we[i] - L + 1):
                if min(st.res[s : s + L]) < m.pw[i]:
                    continue
                mx = max(base[t] + m.pw[i] for t in range(s, s + L))
                bonus = sum(m.b[s : s + L])
                if mx < best_max or (mx == best_max and bonus > best_bonus):
                    best_s, best_max, best_bonus = s, mx, bonus
            if best_s >= 0 and max(max([0, *base]), best_max) < peak:
                st.set(i, best_s, L)
                improved = True
                break
            st.set(i, s0, L)
        if not improved:
            return


def warm_start(m: IntModel) -> tuple[list[int], list[int]]:
    if m.F == 0:
        return [], []
    st = _place_floor(m, 1.0)
    if st is None:
        lo, hi, best = 0.0, 1.0, None
        for _ in range(16):
            mid = (lo + hi) / 2
            cand = _place_floor(m, mid)
            if cand is not None:
                lo, best = mid, cand
            else:
                hi = mid
        st = best or _State(m)
    _grow(m, st)
    _level(m, st)
    _grow(m, st)
    return list(st.start), list(st.len)
