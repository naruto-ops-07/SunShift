"""Request validation. Limits keep a public demo endpoint from being used for arbitrary
large solves."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator


class ProblemFarm(BaseModel):
    id: int
    powerKw: float = Field(gt=0, le=100)
    requested: int = Field(ge=0, le=96)
    minRun: int = Field(ge=1, le=16)
    windowStart: int = Field(ge=0, le=96)
    windowEnd: int = Field(ge=0, le=96)
    weight: float = Field(ge=0, le=100)


class Problem(BaseModel):
    T: int = Field(ge=1, le=96)
    slotHours: float = 0.25
    cap: list[float]
    solar: list[float]
    farms: list[ProblemFarm] = Field(max_length=200)
    fairnessWeight: float = Field(default=40, ge=0, le=1000)

    @field_validator("cap", "solar")
    @classmethod
    def _len(cls, v: list[float], info):  # noqa: ANN001
        if len(v) > 96:
            raise ValueError("at most 96 slots")
        return v


class Hint(BaseModel):
    start: list[int]
    length: list[int]


class OptimiseRequest(BaseModel):
    problem: Problem
    hint: Hint | None = None
    timeLimit: float = Field(default=5.0, gt=0, le=10)


class CloudEvent(BaseModel):
    fromHour: float
    toHour: float
    factor: float = Field(ge=0, le=1.2)


class ScenarioIn(BaseModel):
    date: str | None = None
    locationId: str = "deccan"
    solarKwp: float | None = Field(default=None, gt=0, le=2000)
    inverterKw: float | None = Field(default=None, gt=0, le=2000)
    feederLimitKw: float | None = Field(default=None, gt=0, le=2000)
    gridAllowanceKw: float | None = Field(default=None, ge=0, le=2000)
    forecastReserve: float | None = Field(default=None, ge=0, le=0.5)
    demandScale: float | None = Field(default=None, gt=0, le=5)
    fairnessWeight: float | None = Field(default=None, ge=0, le=1000)
    rainOverrideMm: float | None = Field(default=None, ge=0, le=300)
    cloudEvent: CloudEvent | None = None
    farmOverrides: dict[str, dict] | None = None
    carryOver: dict[str, float] | None = None
    baselineHabitScale: float | None = Field(default=None, gt=0, le=3)
    timeLimit: float = Field(default=5.0, gt=0, le=10)


class TelemetryIn(BaseModel):
    pump_on: bool
    current_a: float | None = None
    flow_lpm: float | None = None
    mode: Literal["advisory", "assisted", "automated"] = "assisted"
    fault: str | None = Field(default=None, max_length=64)
