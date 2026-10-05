// Slow statement markers in the SQL log: how long a statement took, and whether that counts as slow.

/** Thresholds offered in the log's context menu (ms); 0 switches the markers off. */
export const SLOW_CHOICES = [0, 100, 250, 500, 1000, 2000, 5000, 10000, 30000];
export const DEFAULT_SLOW_MS = 1000;
/** A statement this many times over the threshold is marked as very slow. */
export const VERY_SLOW_FACTOR = 10;

/** "0.4 ms", "85 ms", "2.35 s", "42.1 s", "3 min 05 s", "1 h 02 min". */
export function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(2)} s`;
  if (s < 60) return `${s.toFixed(1)} s`;
  const total = Math.round(s);
  if (total < 3600) return `${Math.floor(total / 60)} min ${String(total % 60).padStart(2, '0')} s`;
  return `${Math.floor(total / 3600)} h ${String(Math.floor(total % 3600 / 60)).padStart(2, '0')} min`;
}

/** null (not slow, not measured, or markers off), 'slow', or 'very' (VERY_SLOW_FACTOR times the threshold). */
export function slowLevel(ms, threshold) {
  if (ms == null || !threshold || threshold <= 0 || ms < threshold) return null;
  return ms >= threshold * VERY_SLOW_FACTOR ? 'very' : 'slow';
}

/** Menu label of a threshold. */
export function thresholdLabel(ms) {
  return ms ? `Slower than ${fmtDuration(ms)}` : 'Off';
}

/** The threshold to use from a saved preference: a number ≥ 0, else the default. */
export function slowThreshold(pref) {
  const n = Number(pref);
  return pref != null && pref !== '' && Number.isFinite(n) && n >= 0 ? n : DEFAULT_SLOW_MS;
}

/**
 * Index of the next slow line after `from` (wrapping around), or -1. `levels` holds each line's slowLevel.
 * Used by "Next slow statement" to step through them.
 */
export function nextSlow(levels, from) {
  const n = levels.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k + n) % n;
    if (levels[i]) return i;
  }
  return -1;
}
