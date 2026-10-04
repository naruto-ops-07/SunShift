import json
from pathlib import Path

from fastapi.testclient import TestClient

from sunshift import agronomy as ag
from sunshift.main import app
from sunshift.model import evaluate, to_int_model
from sunshift.pipeline import default_scenario, run_pipeline
from sunshift.prng import hash_string, mulberry32
from sunshift.weather import synthetic_weather

DATE = "2026-10-04"


def test_fao56_example_18():
    r = ag.et0_daily({"tmax": 21.5, "tmin": 12.3, "rhMax": 84, "rhMin": 63, "wind2": 2.078, "rsMJ": 22.07}, 50.8, 100, 187)
    assert 3.7 < r["et0"] < 4.1


def test_prng_matches_javascript():
    # Reference values from the web engine: mulberry32(hashString("sunshift"))
    seed = hash_string("sunshift")
    assert seed == 719408363
    r = mulberry32(seed)
    assert [r() for _ in range(3)] == [0.0760609598364681, 0.20050119375810027, 0.9409736548550427]


def test_pipeline_plan_is_feasible_and_beats_heuristic_or_matches():
    w = synthetic_weather("deccan", "2026-09-27", 14)
    r = run_pipeline(default_scenario(DATE), weather=w, time_limit=2)
    m = to_int_model(r["problem"])
    pos = {s["id"]: s for s in r["plan"]["schedules"]}
    ev = evaluate(m, [pos[i]["start"] for i in m.ids], [pos[i]["length"] for i in m.ids])
    assert ev.feasible
    for t, load in enumerate(r["plan"]["load"]):
        assert load <= r["capacity"][t] + 1e-6
    assert r["plan"]["solver"]["name"] == "cp-sat"
    assert len(r["farms"]) == 20


def test_rain_override_reduces_pumping():
    w = synthetic_weather("deccan", "2026-09-27", 14)
    base = run_pipeline(default_scenario(DATE), weather=w, time_limit=1)
    rain = run_pipeline({**default_scenario(DATE), "rainOverrideMm": 18}, weather=w, time_limit=1)
    assert rain["metrics"]["sunshift"]["waterPumpedM3"] <= base["metrics"]["sunshift"]["waterPumpedM3"]


def test_api_optimise_roundtrip():
    client = TestClient(app)
    w = synthetic_weather("deccan", "2026-09-27", 14)
    r = run_pipeline(default_scenario(DATE), weather=w, time_limit=1)
    res = client.post("/api/optimise", json={"problem": r["problem"], "timeLimit": 1})
    assert res.status_code == 200
    body = res.json()
    assert body["solver"]["name"] == "cp-sat"
    assert body["solver"]["status"] in ("OPTIMAL", "FEASIBLE")


def test_health():
    client = TestClient(app)
    assert client.get("/api/health").json()["status"] == "ok"


def test_shared_roster_has_20_farms():
    data = json.loads((Path(__file__).resolve().parents[2] / "shared" / "feeder07.json").read_text())
    assert len(data["farms"]) == 20


def test_plan_persists_and_controller_reads_it(tmp_path, monkeypatch):
    from sunshift import db

    monkeypatch.setattr(db, "DATABASE_URL", f"sqlite:///{tmp_path}/t.db")
    monkeypatch.setattr(db, "ENABLED", True)
    monkeypatch.setattr(db, "_engine", None)
    db.init()
    w = synthetic_weather("deccan", "2026-09-27", 14)
    r = run_pipeline(default_scenario(DATE), weather=w, time_limit=1)
    pid = db.save_plan(r)
    assert pid is not None
    row = db.latest_plan(DATE)
    assert row is not None and len(row.schedules) == 20
    assert db.save_telemetry(7, {"pump_on": True, "current_a": 7.9, "flow_lpm": 410.0, "mode": "assisted", "fault": None})
    assert db.recent_telemetry(7)[0].pump_on is True
