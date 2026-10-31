// AngelTime v0.4.18 — shared, non-blocking digit transitions.
// Do not interpolate elapsed time: Rust remains the source of truth.
// v0.4.19: presentation-only 10 Hz stopwatch, independent of native timekeeping.
export const STOPWATCH_PRESENTATION_STEP_MS = 100;

/** Show stable tenths while running; never alter the Rust elapsed time. */
export function calmRunningStopwatchMs(elapsedMs) {
  if (!Number.isFinite(elapsedMs)) return 0;
  return Math.floor(Math.max(0, elapsedMs) / STOPWATCH_PRESENTATION_STEP_MS) * STOPWATCH_PRESENTATION_STEP_MS;
}

/** Throttle UI paints, not the underlying clock or pause/reset snapshots. */
export function shouldPaintStopwatch(now, lastPaintAt) {
  return Number.isFinite(now) &&
    (!Number.isFinite(lastPaintAt) || now - lastPaintAt >= STOPWATCH_PRESENTATION_STEP_MS);
}

const rendered = new WeakMap();

export function splitNumericDisplay(value, fractionDigits = 0) {
  const source = String(value);
  if (fractionDigits <= 0) return {main:source, fraction:''};
  const dot = source.lastIndexOf('.');
  if (dot < 0 || source.length - dot - 1 !== fractionDigits) return {main:source, fraction:''};
  return {main:source.slice(0,dot), fraction:source.slice(dot)};
}

function motionAllowed(node) {
  return !document.body.classList.contains('reduced-motion') &&
    !(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

function makeMain(text) {
  const main = document.createElement('span');
  main.className = 'at-number-main';
  for (const char of text) {
    const cell = document.createElement('span');
    cell.className = /[0-9]/.test(char) ? 'at-number-digit' : char === ':' ? 'at-number-separator' : 'at-number-text';
    cell.textContent = char;
    main.appendChild(cell);
  }
  return main;
}

/** Visually ease changed digits, while exposing the exact current time immediately.
 * Fractional digits update directly (no 100Hz animation overload).
 */
export function renderSmoothNumber(node, value, {fractionDigits = 0} = {}) {
  if (!node) return;
  const text = String(value);
  const parts = splitNumericDisplay(text, fractionDigits);
  const previous = rendered.get(node);
  if (previous?.text === text) return;
  if (!previous || previous.mainText.length !== parts.main.length || previous.fractionText.length !== parts.fraction.length) {
    const main = makeMain(parts.main);
    const fraction = document.createElement('span');
    fraction.className = 'at-number-fraction';
    fraction.textContent = parts.fraction;
    const container = document.createElement('span');
    container.className = 'at-number-inner';
    container.setAttribute('aria-hidden', 'true');
    container.append(main, fraction);
    node.replaceChildren(container);
    node.setAttribute('aria-label', text);
    rendered.set(node, {text, mainText:parts.main, fractionText:parts.fraction, main, fraction});
    return;
  }
  const cells = previous.main.children;
  const animate = motionAllowed(node);
  for (let i=0; i<parts.main.length; i++) {
    const char = parts.main[i];
    if (previous.mainText[i] === char) continue;
    const cell = cells[i];
    cell.textContent = char;
    if (animate && /[0-9]/.test(char) && cell.animate) {
      cell.getAnimations?.().forEach((animation) => animation.cancel());
      cell.animate(
        [{opacity:.66, transform:'translateY(.12em)'}, {opacity:1, transform:'translateY(0)'}],
        {duration:165, easing:'cubic-bezier(.2,.8,.2,1)'}
      );
    }
  }
  // Centiseconds are intentionally updated without visual delay.
  if (previous.fractionText !== parts.fraction) previous.fraction.textContent = parts.fraction;
  node.setAttribute('aria-label', text);
  rendered.set(node, {...previous, text, mainText:parts.main, fractionText:parts.fraction});
}
