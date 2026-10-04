from __future__ import annotations

from datetime import date as _date, datetime, timedelta, timezone


def today_local(utc_offset_hours: float = 5.5) -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=utc_offset_hours)).date().isoformat()


def add_days(d: str, n: int) -> str:
    return (_date.fromisoformat(d) + timedelta(days=n)).isoformat()


def diff_days(a: str, b: str) -> int:
    return (_date.fromisoformat(a) - _date.fromisoformat(b)).days


def day_of_year(d: str) -> int:
    return _date.fromisoformat(d).timetuple().tm_yday


def month_index(d: str) -> int:
    return int(d[5:7]) - 1
