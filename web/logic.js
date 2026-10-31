export const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export const pad2 = (n) => String(n).padStart(2, '0');

export function formatCountdown(milliseconds) {
  const s = Math.ceil(Math.max(0, Number(milliseconds) || 0) / 1000);
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
}

export function formatStopwatch(milliseconds) {
  const cs = Math.floor(Math.max(0, Number(milliseconds) || 0) / 10);
  const h = Math.floor(cs / 360000);
  const m = Math.floor(cs / 6000) % 60;
  const s = Math.floor(cs / 100) % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad2(cs % 100)}`;
}

export function formatDays(days) {
  if (!Array.isArray(days) || days.length === 0) return 'Один раз';
  const unique = [...new Set(days)].sort();
  if (unique.length === 7) return 'Каждый день';
  if (unique.join(',') === '0,1,2,3,4') return 'По будням';
  if (unique.join(',') === '5,6') return 'По выходным';
  return unique.map((d) => WEEKDAYS[d]).filter(Boolean).join(' · ');
}

export function timerValuesToSeconds(hours, minutes, seconds) {
  const parts = [hours, minutes, seconds].map(Number);
  if (parts.some((n) => !Number.isInteger(n)) || parts[0] < 0 || parts[0] > 99 || parts[1] < 0 || parts[1] > 59 || parts[2] < 0 || parts[2] > 59) {
    return null;
  }
  const total = parts[0] * 3600 + parts[1] * 60 + parts[2];
  return total > 0 ? total : null;
}

export function closestAlarm(alarms, now = new Date()) {
  let best = null;
  for (const alarm of alarms) {
    if (!alarm.enabled) continue;
    for (let offset = 0; offset < 8; offset++) {
      const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, alarm.hour, alarm.minute);
      if (target.getTime() <= now.getTime()) continue;
      const weekday = (target.getDay() + 6) % 7;
      if (alarm.days.length > 0 && !alarm.days.includes(weekday)) continue;
      if (!best || target < best.when) best = {alarm, when: target};
      break;
    }
  }
  return best;
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}

// Context-aware shortcuts must never hijack text entry or modal dialogs.
export function shortcutAction({key, code, ctrlKey = false, metaKey = false, altKey = false, shiftKey = false, editable = false, interactive = false, modalOpen = false, tab = 'alarm'}) {
  if (editable || modalOpen || altKey || metaKey || shiftKey) return null;
  if (ctrlKey) return ['Digit1', 'Digit2', 'Digit3', 'Digit4'].includes(code) ? `tab:${Number(code.at(-1)) - 1}` : null;
  if (interactive) return null; // Space should activate the focused native button only once.
  if (key.toLowerCase() === 'n' && tab === 'alarm') return 'new-alarm';
  if (code === 'Space' && ['timer', 'stopwatch'].includes(tab)) return 'toggle';
  return null;
}

// Shared action selector for independent timers. A finished timer always starts fresh.
export function nextExtraTimerAction(timer) {
  if (timer.running) return 'pause';
  if (timer.remaining_ms > 0 && timer.remaining_ms < timer.duration_seconds * 1000) return 'resume';
  return 'start';
}

export function parseTimerClock(text) {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(text).trim());
  if (!match) return null;
  return timerValuesToSeconds(match[1],match[2],match[3]);
}

// Display pagination only when there is a second page; keep empty and one-page lists clean.
export function paginationRequired(itemCount, perPage) {
  return Number.isFinite(itemCount) && Number.isInteger(perPage) && perPage > 0 && itemCount > perPage;
}

// Preserve the compact v0.4.5 list limits in restored windows, but use
// available vertical room when AngelTime is maximized or fullscreen.
export function visibleRowsForHeight(height, kind = 'alarm') {
  const h = Number.isFinite(Number(height)) ? Number(height) : 0;
  if (kind === 'extra') return h >= 830 ? 5 : 2;
  return h >= 990 ? 10 : h >= 820 ? 7 : 4;
}

// Number of complete alarm rows that fit into the actual remaining viewport height.
// No arbitrary maximum: only the available pixels limit the number of visible alarms.
export function alarmRowsForSpace(availableHeight, rowHeight = 43, gap = 6) {
  if (![availableHeight, rowHeight, gap].every(Number.isFinite) || rowHeight <= 0 || gap < 0) return 1;
  return Math.max(1, Math.floor((Math.max(0, availableHeight) + gap) / (rowHeight + gap)));
}


// Calculate exactly how many normal alarm rows fit when one schedule is open.
// Opening a schedule REPLACES a row with a taller row; it does not add two rows.
// A new alarm form, on the other hand, is an additional row. Keep the bottom gap.
export function alarmRowsForLayout(availableHeight, rowHeight, gap, expandedHeight = 0, editorHeight = 0, editorMode = 'none') {
  if (![availableHeight,rowHeight,gap,expandedHeight,editorHeight].every(Number.isFinite) ||
      rowHeight <= 0 || gap < 0 || availableHeight < 0 || expandedHeight < 0 || editorHeight < 0 ||
      !['none','new','replace'].includes(editorMode)) return 1;
  const expandedExtra = expandedHeight > 0 ? Math.max(0, expandedHeight - rowHeight) : 0;
  const editorExtra = editorMode === 'new' ? editorHeight + gap :
    editorMode === 'replace' ? Math.max(0, editorHeight - rowHeight) : 0;
  return alarmRowsForSpace(availableHeight - expandedExtra - editorExtra, rowHeight, gap);
}

// Condensed, user-facing schedule summary; full controls open only on demand.
export function alarmScheduleLabel(days, mode = 'custom') {
  if (mode === 'workdays') return 'Мои будни';
  if (mode === 'weekends') return 'Мои выходные';
  if (!Array.isArray(days) || days.length === 0) return 'Разово';
  const unique = [...new Set(days)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a,b)=>a-b);
  if (unique.length === 7) return 'Каждый день';
  return unique.map((day)=>WEEKDAYS[day]).join(' · ') || 'Разово';
}

// Native time controls can truncate minutes in narrow Windows WebView2 fields.
// A direct text input removes its platform-specific clock icon; validate before saving.
export function validAlarmTime(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour,minute] = value.split(':').map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}
