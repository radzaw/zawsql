// Host tab › Events: an event's schedule in words and when it runs next. Pure functions, unit-tested in tests/js.
// Times are the server's 'YYYY-MM-DD HH:MM:SS' strings, in the event's time zone. They are calculated as UTC so no
// daylight saving shift of the browser's zone gets in the way.

const UNITS = ['YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND'];
const SECONDS = { WEEK: 604800, DAY: 86400, HOUR: 3600, MINUTE: 60, SECOND: 1 };
const MONTHS = { YEAR: 12, QUARTER: 3, MONTH: 1 };

export function parseDt(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(s ?? '');
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

export function fmtDt(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * An event's interval ("1" DAY, "1 12" DAY_HOUR, "1:30" HOUR_MINUTE …) as { months, seconds, parts: [[n, unit]] },
 * or null for one this can't follow (microseconds).
 */
export function parseInterval(value, field) {
  const f = String(field ?? '').toUpperCase();
  const nums = String(value ?? '').match(/\d+/g)?.map(Number) ?? [];
  if (!nums.length || f.includes('MICROSECOND')) return null;
  let parts;
  if (MONTHS[f] || SECONDS[f]) parts = [[nums[0], f]];
  else {
    const [from, to] = f.split('_');
    const a = UNITS.indexOf(from), b = UNITS.indexOf(to);
    if (a < 0 || b <= a) return null;
    const units = UNITS.slice(a, b + 1);
    // Like MySQL, a value with fewer parts than the unit fills them from the right ("30" HOUR_MINUTE: 30 minutes).
    const vals = nums.slice(-units.length);
    const shift = units.length - vals.length;
    parts = units.map((u, i) => [i < shift ? 0 : vals[i - shift], u]).filter(([n]) => n);
  }
  let months = 0, seconds = 0;
  for (const [n, u] of parts) {
    if (MONTHS[u]) months += n * MONTHS[u];
    else seconds += n * SECONDS[u];
  }
  return months || seconds ? { months, seconds, parts } : null;
}

const plural = (n, u) => `${n} ${u.toLowerCase()}${n === 1 ? '' : 's'}`;

/** "every 2 hours from … until …", "once at …". */
export function scheduleText(ev) {
  const tz = ev.timeZone && ev.timeZone !== 'SYSTEM' ? ` (${ev.timeZone})` : '';
  if (ev.type === 'ONE TIME') return `once at ${ev.executeAt ?? '?'}${tz}`;
  const iv = parseInterval(ev.intervalValue, ev.intervalField);
  let s = 'every ' + (iv ? iv.parts.map(([n, u]) => plural(n, u)).join(' ') : `${ev.intervalValue} ${String(ev.intervalField).toLowerCase()}`);
  if (ev.starts) s += ` from ${ev.starts}`;
  if (ev.ends) s += ` until ${ev.ends}`;
  return s + tz;
}

function addMonths(ms, n) {
  const d = new Date(ms);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // a 31st becomes the month's last day
  return Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

/**
 * When the event runs next: { at (ms, or null), note }. The note says why there is no next run (disabled, ended,
 * already ran) and is empty otherwise. Recurring events run at STARTS plus whole intervals. Estimated: the scheduler
 * may run late on a busy server, and doesn't run at all while it is off.
 */
export function nextRun(ev) {
  if (ev.status === 'SLAVESIDE_DISABLED') return { at: null, note: 'disabled on this replica' };
  if (ev.status !== 'ENABLED') return { at: null, note: 'disabled' };
  const now = parseDt(ev.nowThere);
  if (now == null) return { at: null, note: '' };
  if (ev.type === 'ONE TIME') {
    const at = parseDt(ev.executeAt);
    return at != null && at > now ? { at, note: '' } : { at: null, note: 'already ran' };
  }
  const iv = parseInterval(ev.intervalValue, ev.intervalField);
  if (!iv) return { at: null, note: 'unknown interval' };
  const start = parseDt(ev.starts) ?? now;
  let next;
  if (start > now) next = start;
  else if (!iv.months) {
    const step = iv.seconds * 1000;
    next = start + (Math.floor((now - start) / step) + 1) * step;
  } else {
    // Calendar steps: start from an estimate a little short of now and walk forward.
    const d0 = new Date(start), d1 = new Date(now);
    const elapsed = (d1.getUTCFullYear() - d0.getUTCFullYear()) * 12 + d1.getUTCMonth() - d0.getUTCMonth();
    let k = Math.max(1, Math.floor(elapsed / iv.months) - 1);
    const at = i => addMonths(start, i * iv.months) + i * iv.seconds * 1000;
    while (at(k) <= now) k++;
    next = at(k);
  }
  const end = parseDt(ev.ends);
  return end != null && next > end ? { at: null, note: 'ended' } : { at: next, note: '' };
}

/** "in 5 min", "in 3 h", "in 2 days". */
export function fromNow(at, now) {
  const s = Math.max(0, Math.round((at - now) / 1000));
  if (s < 60) return `in ${s} s`;
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 172800) return `in ${Math.round(s / 3600)} h`;
  return `in ${Math.round(s / 86400)} days`;
}
