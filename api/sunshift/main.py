"""SunShift API.

    uvicorn sunshift.main:app --reload --port 8000

Endpoints
  GET  /api/health                         engine + solver + database status
  GET  /api/roster                         the demonstration feeder (shared with the web engine)
  GET  /api/weather?location=&date=        Open-Meteo forecast or labelled climatology fallback
  GET  /api/solar?location=&date=&kwp=&ac= pvlib PV profile on the 15-minute grid
  POST /api/optimise                       CP-SAT on a Problem built by the web engine
  POST /api/plan                           full server pipeline (pvlib + FAO-56 + CP-SAT + baseline)
  GET  /api/plans/latest                   most recent stored plan
  GET  /api/controller/{farm}/schedule     what an ESP32 controller should execute today
  POST /api/controller/{farm}/telemetry    pump feedback (planned-vs-actual)
  GET  /api/telemetry                      recent telemetry
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import ortools
import pvlib
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from . import __version__, db
from .pipeline import default_scenario, optimise_problem, run_pipeline
from .roster import farm_code, roster, slot_label
from .schemas import OptimiseRequest, ScenarioIn, TelemetryIn
from .solar import compute_solar_day, plant
from .timeutil import today_local
from .weather import weather_for


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init()
    yield


app = FastAPI(title="SunShift API", version=__version__, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",")],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "version": __version__,
        "solver": f"OR-Tools CP-SAT {ortools.__version__}",
        "pv": f"pvlib {pvlib.__version__}",
        "database": db.backend(),
        "time": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/roster")
def get_roster() -> dict:
    return roster()


@app.get("/api/weather")
def get_weather(location: str = "deccan", date: str | None = None) -> dict:
    return weather_for(location, date or today_local())


@app.get("/api/solar")
def get_solar(location: str = "deccan", date: str | None = None, kwp: float = Query(110, gt=0, le=2000), ac: float = Query(90, gt=0, le=2000)) -> dict:
    d = date or today_local()
    scn = {**default_scenario(d), "locationId": location, "solarKwp": kwp, "inverterKw": ac}
    w = weather_for(location, d)
    return {"weather": {"source": w["source"], "label": w["label"]}, **compute_solar_day(w, d, plant(scn))}


@app.post("/api/optimise")
def optimise(req: OptimiseRequest) -> dict:
    problem = req.problem.model_dump()
    for f in problem["farms"]:
        if f["windowEnd"] > problem["T"] or f["windowStart"] > f["windowEnd"]:
            raise HTTPException(422, f"farm {f['id']}: window outside horizon")
    if len(problem["cap"]) != problem["T"] or len(problem["solar"]) != problem["T"]:
        raise HTTPException(422, "cap and solar must have T entries")
    solution, info = optimise_problem(problem, req.hint.model_dump() if req.hint else None, req.timeLimit)
    return {"solution": solution, "solver": info}


@app.post("/api/plan")
def plan(req: ScenarioIn) -> dict:
    scn = default_scenario(req.date)
    for k, v in req.model_dump(exclude={"timeLimit"}).items():
        if v is not None:
            scn[k] = v
    try:
        result = run_pipeline(scn, time_limit=req.timeLimit)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    result["planId"] = db.save_plan(result)
    return result


@app.get("/api/plans/latest")
def plans_latest(date: str | None = None) -> dict:
    row = db.latest_plan(date)
    if row is None:
        raise HTTPException(404, "no stored plan")
    return {"id": row.id, "createdAt": row.created_at.isoformat(), "date": row.plan_date, "weatherSource": row.weather_source, "solver": row.solver, "metrics": row.metrics, "schedules": row.schedules}


@app.get("/api/controller/{farm_id}/schedule")
def controller_schedule(farm_id: int) -> dict:
    """Compact schedule for the field controller. The controller caches it and keeps
    executing it if connectivity drops; it never overrides the manual switch."""
    if farm_id not in {f["id"] for f in roster()["farms"]}:
        raise HTTPException(404, "unknown farm")
    d = today_local()
    row = db.latest_plan(d)
    source = "stored"
    if row is None:
        result = run_pipeline(default_scenario(d), time_limit=3)
        result["planId"] = db.save_plan(result)
        sch = next(s for s in result["plan"]["schedules"] if s["id"] == farm_id)
        plan_id = result["planId"]
        source = "fresh"
    else:
        sch = next((s for s in row.schedules if s["id"] == farm_id), {"start": -1, "length": 0})
        plan_id = row.id
    windows = []
    if sch.get("length", 0) > 0:
        windows.append({"start": slot_label(sch["start"]), "end": slot_label(sch["start"] + sch["length"]), "slots": sch["length"]})
    issued = datetime.now(timezone.utc)
    return {
        "farmId": farm_id,
        "farm": farm_code(farm_id),
        "date": d,
        "planId": plan_id,
        "source": source,
        "windows": windows,
        "issuedAt": issued.isoformat(),
        "validUntil": (issued + timedelta(hours=18)).isoformat(),
        "requiresConfirmation": True,
    }


@app.post("/api/controller/{farm_id}/telemetry")
def controller_telemetry(farm_id: int, t: TelemetryIn) -> dict:
    tid = db.save_telemetry(farm_id, t.model_dump())
    return {"stored": tid is not None, "id": tid}


@app.get("/api/telemetry")
def telemetry(farm_id: int | None = None, limit: int = Query(50, le=500)) -> list[dict]:
    rows = db.recent_telemetry(farm_id, limit)
    return [
        {"id": r.id, "farmId": r.farm_id, "receivedAt": r.received_at.isoformat(), "pumpOn": r.pump_on, "currentA": r.current_a, "flowLpm": r.flow_lpm, "mode": r.mode, "fault": r.fault}
        for r in rows
    ]
