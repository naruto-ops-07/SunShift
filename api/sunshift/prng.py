"""Bit-exact ports of the web engine's PRNG helpers (mulberry32, FNV-1a, Box–Muller)."""

from __future__ import annotations

import math
from collections.abc import Callable

_M = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    return ((a & _M) * (b & _M)) & _M


def mulberry32(seed: int) -> Callable[[], float]:
    state = [seed & _M]

    def rand() -> float:
        state[0] = (state[0] + 0x6D2B79F5) & _M
        t = state[0]
        t = _imul(t ^ (t >> 15), t | 1)
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & _M
        return ((t ^ (t >> 14)) & _M) / 4294967296

    return rand


def hash_string(s: str) -> int:
    h = 2166136261
    for ch in s:
        h ^= ord(ch)
        h = (h * 16777619) & _M
    return h


def gaussian(rand: Callable[[], float]) -> float:
    u = max(1e-12, rand())
    v = rand()
    return math.sqrt(-2 * math.log(u)) * math.cos(2 * math.pi * v)
