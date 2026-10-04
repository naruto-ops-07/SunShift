"""Persistence. PostgreSQL in production (DATABASE_URL=postgresql+psycopg://…), SQLite by
default for local runs, or DATABASE_URL=disabled to run stateless."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, Float, Integer, String, create_engine, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./sunshift.db")
ENABLED = DATABASE_URL.lower() != "disabled"


class Base(DeclarativeBase):
    pass


class PlanRun(Base):
    __tablename__ = "plan_runs"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    feeder_id: Mapped[str] = mapped_column(String(32))
    plan_date: Mapped[str] = mapped_column(String(10), index=True)
    weather_source: Mapped[str] = mapped_column(String(32))
    scenario: Mapped[dict] = mapped_column(JSON)
    solver: Mapped[dict] = mapped_column(JSON)
    metrics: Mapped[dict] = mapped_column(JSON)
    schedules: Mapped[list] = mapped_column(JSON)


class Telemetry(Base):
    __tablename__ = "telemetry"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)
    farm_id: Mapped[int] = mapped_column(Integer, index=True)
    pump_on: Mapped[bool] = mapped_column(Boolean)
    current_a: Mapped[float | None] = mapped_column(Float, nullable=True)
    flow_lpm: Mapped[float | None] = mapped_column(Float, nullable=True)
    mode: Mapped[str] = mapped_column(String(16), default="assisted")
    fault: Mapped[str | None] = mapped_column(String(64), nullable=True)


_engine = None
_Session: sessionmaker[Session] | None = None


def init() -> None:
    global _engine, _Session
    if not ENABLED or _engine is not None:
        return
    kwargs: dict[str, Any] = {"pool_pre_ping": True}
    if DATABASE_URL.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
    _engine = create_engine(DATABASE_URL, **kwargs)
    Base.metadata.create_all(_engine)
    _Session = sessionmaker(_engine, expire_on_commit=False)


def backend() -> str:
    if not ENABLED:
        return "disabled"
    return DATABASE_URL.split(":", 1)[0].split("+", 1)[0]


def save_plan(result: dict) -> int | None:
    if not ENABLED or _Session is None:
        return None
    sch = []
    for f, s in zip(result["farms"], result["plan"]["schedules"]):
        sch.append({**s, "code": f["code"], "decision": f["decision"], "reason": f["reason"]})
    with _Session() as db:
        row = PlanRun(
            feeder_id="FDR-07",
            plan_date=result["scenario"]["date"],
            weather_source=result["weather"]["source"],
            scenario=result["scenario"],
            solver=result["plan"]["solver"] or {},
            metrics=result["metrics"],
            schedules=sch,
        )
        db.add(row)
        db.commit()
        return row.id


def latest_plan(plan_date: str | None = None) -> PlanRun | None:
    if not ENABLED or _Session is None:
        return None
    with _Session() as db:
        q = select(PlanRun).order_by(PlanRun.id.desc())
        if plan_date:
            q = q.where(PlanRun.plan_date == plan_date)
        return db.scalars(q.limit(1)).first()


def save_telemetry(farm_id: int, data: dict) -> int | None:
    if not ENABLED or _Session is None:
        return None
    with _Session() as db:
        row = Telemetry(farm_id=farm_id, **data)
        db.add(row)
        db.commit()
        return row.id


def recent_telemetry(farm_id: int | None, limit: int = 50) -> list[Telemetry]:
    if not ENABLED or _Session is None:
        return []
    with _Session() as db:
        q = select(Telemetry).order_by(Telemetry.id.desc()).limit(limit)
        if farm_id is not None:
            q = q.where(Telemetry.farm_id == farm_id)
        return list(db.scalars(q))
