function expandField(raw, min, max, { allowSevenAsSunday = false } = {}) {
  const values = new Set();
  for (const chunk of String(raw || '').split(',')) {
    if (!chunk) throw Error(`Invalid cron field: ${raw}`);
    const [base, stepRaw] = chunk.split('/');
    if (chunk.split('/').length > 2) throw Error(`Invalid cron step: ${chunk}`);
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw Error(`Invalid cron step: ${chunk}`);
    let start;
    let end;
    if (base === '*') {
      start = min; end = max;
    } else if (base.includes('-')) {
      const [a, b] = base.split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b) || a > b) throw Error(`Invalid cron range: ${chunk}`);
      start = a; end = b;
    } else {
      const n = Number(base);
      if (!Number.isInteger(n)) throw Error(`Invalid cron value: ${chunk}`);
      start = n; end = n;
    }
    for (let v = start; v <= end; v += step) {
      if (allowSevenAsSunday && v === 7) values.add(0);
      else if (v < min || v > max) throw Error(`Cron value ${v} out of range ${min}-${max}`);
      else values.add(v);
    }
  }
  return values;
}

export function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) throw Error(`Cron schedule must have 5 fields: ${expr}`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  return {
    expr,
    minute: expandField(minute, 0, 59),
    hour: expandField(hour, 0, 23),
    dayOfMonth: expandField(dayOfMonth, 1, 31),
    dayOfMonthAny: dayOfMonth === '*',
    month: expandField(month, 1, 12),
    dayOfWeek: expandField(dayOfWeek, 0, 7, { allowSevenAsSunday: true }),
    dayOfWeekAny: dayOfWeek === '*'
  };
}

export function floorMinute(date) {
  const d = new Date(date);
  d.setUTCSeconds(0, 0);
  return d;
}

/**
 * Match a parsed cron expression against a UTC minute.
 * Day-of-month + day-of-week: when BOTH fields are restricted (neither is
 * `*`), JobOS follows standard Vixie-cron OR semantics — the day matches if
 * EITHER field matches. This is intentional (Unix-cron alignment); the older
 * AND behavior was retired with the AppPacket-ReceiptSpine main sweep and the
 * decision is locked by tests/sprint7-scheduler.test.js.
 */
export function matchesCron(expr, date = new Date()) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const d = floorMinute(date);
  const domMatches = c.dayOfMonth.has(d.getUTCDate());
  const dowMatches = c.dayOfWeek.has(d.getUTCDay());
  const dayMatches = c.dayOfMonthAny && c.dayOfWeekAny
    ? true
    : c.dayOfMonthAny
      ? dowMatches
      : c.dayOfWeekAny
        ? domMatches
        : domMatches || dowMatches; // both DOM and DOW restricted: standard-cron OR
  return c.minute.has(d.getUTCMinutes())
    && c.hour.has(d.getUTCHours())
    && dayMatches
    && c.month.has(d.getUTCMonth() + 1)
}

export function nextRunAfter(expr, after = new Date()) {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  const d = floorMinute(after);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (matchesCron(c, d)) return new Date(d);
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  throw Error(`Could not find next run within one year for ${c.expr}`);
}

export function isDue(expr, lastRunAt, now = new Date()) {
  const current = floorMinute(now);
  const baseline = lastRunAt ? floorMinute(new Date(lastRunAt)) : new Date(current.getTime() - 60_000);
  if (baseline >= current) return false;
  return nextRunAfter(expr, baseline) <= current;
}
