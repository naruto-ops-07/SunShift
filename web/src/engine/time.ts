// Date helpers. All engine dates are local calendar dates (IST) as YYYY-MM-DD strings.

export function todayLocal(utcOffsetHours = 5.5, now = new Date()): string {
  const local = new Date(now.getTime() + utcOffsetHours * 3600_000);
  return local.toISOString().slice(0, 10);
}

export function nowLocalHour(utcOffsetHours = 5.5, now = new Date()): number {
  const local = new Date(now.getTime() + utcOffsetHours * 3600_000);
  return local.getUTCHours() + local.getUTCMinutes() / 60;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400_000);
}

export function dayOfYear(date: string): number {
  const d = Date.parse(`${date}T00:00:00Z`);
  const start = Date.parse(`${date.slice(0, 4)}-01-01T00:00:00Z`);
  return Math.round((d - start) / 86400_000) + 1;
}

export function monthIndex(date: string): number {
  return Number(date.slice(5, 7)) - 1;
}

export function formatDateLong(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
