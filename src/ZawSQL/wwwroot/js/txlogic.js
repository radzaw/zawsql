// Manual-commit query tabs: pure helpers (no DOM), unit-tested in tests/js.
import { fmtSeconds } from './insightlogic.js';

/** Transactions open longer than this are highlighted: their locks may be blocking others. */
export const LONG_OPEN_MS = 5 * 60 * 1000;

/** Preference "New query tabs": auto-commit, manual commit, or manual commit on production sessions only. */
export const TX_DEFAULTS = [['auto', 'Auto-commit'], ['production', 'Manual commit on production servers'], ['manual', 'Manual commit']];

/** Whether a tab that hasn't chosen yet should start in manual-commit mode on this session. */
export function wantsManual(pref, session) {
  if (pref === 'manual') return true;
  if (pref === 'production') return !!session?.production;
  return false;
}

/** The toolbar status of a manual-commit tab: { text, severity: 'idle' | 'open' | 'long' }. */
export function txStatus(tx, now = Date.now()) {
  if (!tx?.open) return { text: 'No open transaction', severity: 'idle' };
  const age = tx.since ? Math.max(0, now - Date.parse(tx.since)) : 0;
  const changes = `${tx.changes} change${tx.changes === 1 ? '' : 's'}`;
  return {
    text: `Transaction open · ${changes} · ${age < 60_000 ? 'just now' : fmtSeconds(age / 1000)}`,
    severity: age >= LONG_OPEN_MS ? 'long' : 'open',
  };
}

/** The question when an open transaction has to end (closing the tab, switching to auto-commit, disconnecting). */
export function endQuestion(tx, reason) {
  return `This tab has an open transaction with ${tx.changes} uncommitted change${tx.changes === 1 ? '' : 's'}. ${reason}`;
}
