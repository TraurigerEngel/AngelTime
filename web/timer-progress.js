// AngelTime v0.4.20 — visual-only, monotonic progress bar interpolation.
// Rust is authoritative for remaining time and completion notifications.
export function progressRatio(remainingMs, durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 1;
  if (!Number.isFinite(remainingMs)) return 0;
  return Math.max(0, Math.min(1, remainingMs / durationMs));
}

/** Pure clock sampling. The interpolation never changes the underlying timer. */
export function remainingAt(clock, now) {
  if (!clock || !Number.isFinite(now)) return 0;
  const elapsed = Math.max(0, now - clock.syncedAt);
  return Math.max(0, Math.min(clock.durationMs, clock.remainingMs - elapsed));
}

/** Keep interpolation from moving backwards due to small snapshot latency jitter.
 * Large native corrections are adopted immediately (but never increase the bar
 * while the same timer is running). A pause/restart clears the old clock.
 */
export function syncProgressClock(previous, nativeRemainingMs, durationMs, now) {
  const duration = Math.max(0, Number(durationMs) || 0);
  const native = Math.max(0, Math.min(duration, Number(nativeRemainingMs) || 0));
  let next = native;
  if (previous && previous.durationMs === duration && Number.isFinite(now) && now >= previous.syncedAt) {
    const predicted = remainingAt(previous, now);
    const error = native - predicted;
    const corrected = Math.abs(error) <= 90 ? predicted + error * .3 : native;
    next = Math.max(0, Math.min(predicted, corrected));
  }
  return {remainingMs:next, durationMs:duration, syncedAt:now};
}
