import { alarmRowsForSpace, alarmRowsForLayout, closestAlarm, escapeHtml, formatCountdown, formatDays, formatStopwatch, nextAlarmOccurrence, nextExtraTimerAction, paginationRequired, sortAlarmsByNextTrigger, visibleRowsForHeight, parseTimerClock, alarmScheduleLabel, validAlarmTime, pad2, shortcutAction, timerValuesToSeconds } from './logic.js';
import {renderSmoothNumber, calmRunningStopwatchMs, shouldPaintStopwatch} from './numeric-motion.js';
import {progressRatio, remainingAt, syncProgressClock} from './timer-progress.js';

const el = (id) => document.getElementById(id);
const api = window.__TAURI__?.core?.invoke;
const listen = window.__TAURI__?.event?.listen;
const appWindow = window.__TAURI__?.window?.getCurrentWindow?.();
let state = null;
let activeTab = 'alarm';
let alarmPage = 0;
let extraPage = 0;
let renderedExtraStructure = '';
let alarmModalDraft = null; // All alarm edits are explicit and modal; list rows are read-only.
let alarmModalReturnFocus = null;
let alarmModalSaving = false;
const alarmEdits = new Map(); // Existing alarms: automatically saved, always editable.
const alarmSaveTimers = new Map();
let workDaysDraft = null;
let workDaysSaveTimer = null;
let workDaysSaving = false;
let renderedAlarms = '';
let renderedAlert = '';
let initializedTimer = false;
let timerProgressFrame = 0;
let timerProgressClock = null;
let stopwatchFrame = 0;
let stopwatchClock = null;
let stopwatchLastPaintAt = -Infinity;
let stopwatchVisualRunning = false;
let toastTimeout;
let busy = false;
let pendingDelete = null;
let deletingAlarmId = null; // Prevent repeated right-click from initiating duplicate deletion.

// Own confirmation dialog: no browser-origin message and no implicit destructive default.
function requestDeleteConfirmation(title, message, actionLabel = 'Удалить') {
  if (pendingDelete || !!alarmModalDraft || !el('alertOverlay').classList.contains('hidden')) {
    return Promise.resolve(false);
  }
  const previousFocus = document.activeElement;
  el('deleteTitle').textContent = title;
  el('deleteBody').textContent = message; // Text, never interpreted as HTML.
  el('approveDelete').textContent = actionLabel;
  el('deleteOverlay').classList.remove('hidden');
  el('cancelDelete').focus(); // Enter defaults to Cancel.
  return new Promise((resolve) => { pendingDelete = {resolve, previousFocus}; });
}

function finishDeleteConfirmation(approved) {
  if (!pendingDelete) return;
  const {resolve, previousFocus} = pendingDelete;
  pendingDelete = null; // Close first to reject double clicks.
  el('deleteOverlay').classList.add('hidden');
  if (previousFocus?.isConnected && !previousFocus.disabled) previousFocus.focus();
  else el('addAlarm').focus();
  resolve(approved);
}


function toast(message) {
  const node = el('toast');
  node.textContent = message;
  node.classList.remove('hidden');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => node.classList.add('hidden'), 4500);
}

async function command(name, args = {}) {
  if (!api) { toast('Для работы откройте приложение через Tauri.'); return null; }
  if (busy) return null;
  busy = true;
  try {
    const result = await api(name, args);
    if (result) update(result);
    return result;
  } catch (error) {
    toast(`Не удалось выполнить действие: ${String(error)}`);
    return null;
  } finally {
    busy = false;
  }
}

function changeTab(tab) {
  if (alarmModalDraft) return;
  setMelodyPickerOpen(false);
  activeTab = tab;
  document.querySelectorAll('[data-tab]').forEach((button) => {
    const selected = button.dataset.tab === tab;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `panel-${tab}`));
  if (tab === 'alarm' && state) renderAlarms(); // Re-measure after the previously hidden panel becomes visible.
  if (state) {
    renderTimer(); // Start/stop timer progress animation on tab changes.
    renderStopwatch(); // Start/stop the smooth visual ticker on tab changes.
  }
}

function update(snapshot) {
  state = snapshot;
  if (!initializedTimer) {
    fillTimerInputs(snapshot.timer.duration_seconds);
    initializedTimer = true;
  }
  const fingerprint = JSON.stringify(snapshot.alarms);
  if (renderedAlarms !== fingerprint) {
    renderedAlarms = fingerprint;
    renderAlarms();
  }
  renderTimer();
  renderExtraTimers();
  renderStopwatch();
  renderPreferences();
  const alertKey = JSON.stringify(snapshot.alert);
  if (renderedAlert !== alertKey) {
    renderedAlert = alertKey;
    renderAlert();
  }
}

const inlineWeekdays = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];

// Icon choices are based on a label only for presentation. SVG paths are static,
// so a user-defined alarm name cannot inject HTML into the alarm list.
const ALARM_ICON_PATHS = Object.freeze({
  work: '<rect x="3.5" y="7" width="17" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3.5 12h17M10 11.8v2.5h4v-2.5"/>',
  study: '<path d="M12 6c-2.5-1.6-5.2-1.9-9-1.2V19c3.8-.7 6.5-.4 9 1.2 2.5-1.6 5.2-1.9 9-1.2V4.8c-3.8-.7-6.5-.4-9 1.2ZM12 6v14.2"/>',
  graduation: '<path d="m2 9 10-5 10 5-10 5L2 9ZM6 11.2v5c3.4 2.5 8.6 2.5 12 0v-5M22 9v6"/>',
  break: '<path d="M5 8h12v7a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5V8ZM17 9h2a2 2 0 0 1 0 4h-2M4 21h15M8 3v2M13 3v2"/>',
  resume: '<path d="M7 4.5c0-.8.9-1.2 1.6-.8l11 7.5a1 1 0 0 1 0 1.6l-11 7.5c-.7.4-1.6 0-1.6-.8v-15Z"/>',
  meal: '<path d="M4 3v7a3 3 0 0 0 6 0V3M7 3v18M14 3v8c0 2 1.5 3 4 3h2V3c-4.5 0-6 3.1-6 8ZM20 14v7"/>',
  done: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.7 2.7L16 9.5"/>',
  flag: '<path d="M5 22V4M5 5c4-3 8 2 12-1v12c-4 3-8-2-12 1"/>',
  heart: '<path d="M20.8 8.1c0 5.1-8.8 11-8.8 11s-8.8-5.9-8.8-11a4.8 4.8 0 0 1 8.8-2.5 4.8 4.8 0 0 1 8.8 2.5Z"/>',
  sport: '<path d="M4 19 9 6l3 6 3-6 5 13M2 19h20"/>',
  generic: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 9h18c0-1-3-2-3-9ZM10 21h4"/>',
});
function alarmVisualProfile(label = '') {
  const text = String(label).toLowerCase().trim();
  let tone = 'generic';
  if (/(любим|семь|жена|муж|дет|родн)/.test(text)) tone = 'heart';
  else if (/(конец|окончан|заверш).*смен/.test(text)) tone = 'flag';
  else if (/(конец|окончан|заверш).*обуч/.test(text)) tone = 'graduation';
  else if (/(конец|окончан|заверш).*перерыв/.test(text)) tone = 'resume';
  else if (/(конец|окончан|заверш).*обед/.test(text)) tone = 'done';
  else if (/(смен|работ)/.test(text)) tone = 'work';
  else if (/(обуч|учеб|курс|лекц|урок)/.test(text)) tone = 'study';
  else if (/(перерыв|кофе|чай|break)/.test(text)) tone = 'break';
  else if (/(обед|ужин|завтрак|ланч)/.test(text)) tone = 'meal';
  else if (/(спорт|трен|бег|зал)/.test(text)) tone = 'sport';
  else if (/(конец|окончан|заверш|готов)/.test(text)) tone = 'done';
  const icon = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ALARM_ICON_PATHS[tone]}</svg>`;
  return {icon, tone};
}

// Changes to existing alarms are saved automatically. Debounced writes prevent
// one disk write per keystroke; latest edit always wins over in-flight saves.
function stagedAlarm(id) {
  const stored = alarmEdits.get(id);
  const alarm = stored?.value ?? state?.alarms.find((item) => item.id === id);
  return alarm ? {...alarm, days:[...(alarm.days ?? [])]} : null;
}
function scheduleAlarmChange(id, patch, immediate = false) {
  if (!state || !api) return;
  const current = stagedAlarm(id);
  if (!current) return;
  const prev = alarmEdits.get(id);
  const value = {...current, ...patch};
  const row = document.querySelector(`.alarm-live-row[data-id="${CSS.escape(id)}"]`);
  if (row) row.classList.add('saving');
  alarmEdits.set(id, {value, version:(prev?.version ?? 0)+1, saving:prev?.saving ?? false});
  clearTimeout(alarmSaveTimers.get(id));
  alarmSaveTimers.set(id, setTimeout(() => void flushAlarmChange(id), immediate ? 90 : 650));
}
async function flushAlarmChange(id) {
  const staged = alarmEdits.get(id);
  if (!staged || staged.saving || !api) return;
  staged.saving = true;
  const version = staged.version;
  const value = {...staged.value, label:staged.value.label.trim().slice(0,60)};
  try {
    const snapshot = await api('upsert_alarm', {alarm:{id:value.id, hour:value.hour, minute:value.minute,
      label:value.label, days:value.days, schedule_mode:value.schedule_mode ?? 'custom', enabled:value.enabled}});
    const latest = alarmEdits.get(id);
    if (latest === staged && latest.version === version) { alarmEdits.delete(id); alarmSaveTimers.delete(id); }
    else if (latest) {latest.saving = false; clearTimeout(alarmSaveTimers.get(id)); alarmSaveTimers.set(id, setTimeout(() => void flushAlarmChange(id), 40));}
    if (snapshot) update(snapshot);
    // Do not display an intrusive toast on every successful auto-save.
    const row = document.querySelector(`.alarm-live-row[data-id="${CSS.escape(id)}"]`);
    if (row && !alarmEdits.has(id)) row.classList.remove('saving');
  } catch (error) {
    staged.saving = false;
    toast(`Не удалось сохранить будильник: ${String(error)}`);
    const row = document.querySelector(`.alarm-live-row[data-id="${CSS.escape(id)}"]`);
    row?.classList.add('save-error');
  }
}

const ALL_WEEKDAYS = [0,1,2,3,4,5,6];
function modeDays(mode, baseDays) {
  const working = state?.preferences?.work_days ?? [0,1,2,3,4];
  if (mode === 'workdays') return [...working];
  if (mode === 'weekends') return ALL_WEEKDAYS.filter((day) => !working.includes(day));
  if (mode === 'daily') return ALL_WEEKDAYS;
  if (mode === 'once') return [];
  return [...baseDays];
}
function displayAlarms(now = new Date()) {
  if (!state?.alarms) return [];
  const alarms = state.alarms.map((alarm) => stagedAlarm(alarm.id) ?? alarm);
  return sortAlarmsByNextTrigger(alarms, now);
}

function formatAlarmEta(when, now = new Date()) {
  const minutes = Math.max(1, Math.ceil((when.getTime() - now.getTime()) / 60000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const parts = [];
  if (days > 0) parts.push(`${days} д`);
  if (hours > 0) parts.push(`${hours} ч`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins} мин`);
  return `через ${parts.join(' ')}`;
}

// Modal values never touch the saved alarm until the user clicks Save.
function openAlarmEditor(alarm = null) {
  if (!state || busy || pendingDelete || alarmModalDraft || !el('alertOverlay').classList.contains('hidden')) return;
  if (alarm && alarmEdits.has(alarm.id)) {
    toast('Дождись сохранения изменения будильника.');
    return;
  }
  const time = new Date();
  alarmModalDraft = {
    id: alarm?.id ?? null,
    hour: alarm?.hour ?? ((time.getHours() + 1) % 24),
    minute: alarm?.minute ?? 0,
    label: alarm?.label ?? '',
    enabled: alarm?.enabled ?? true,
    days: new Set(alarm?.days ?? []),
    schedule_mode: alarm?.schedule_mode ?? 'custom',
  };
  alarmModalReturnFocus = document.activeElement;
  el('alarmEditTitle').textContent = alarm ? 'Изменить будильник' : 'Новый будильник';
  el('alarmEditTime').value = `${pad2(alarmModalDraft.hour)}:${pad2(alarmModalDraft.minute)}`;
  el('alarmEditLabel').value = alarmModalDraft.label;
  el('alarmEditDelete').classList.toggle('hidden', !alarm);
  el('alarmEditError').textContent = '';
  el('alarmEditSave').disabled = false;
  renderAlarmModalChoices();
  el('alarmEditOverlay').classList.remove('hidden');
  el('alarmEditTime').focus();
}

function closeAlarmEditor(force = false) {
  if (!alarmModalDraft || (alarmModalSaving && !force)) return;
  alarmModalDraft = null;
  el('alarmEditOverlay').classList.add('hidden');
  el('alarmEditError').textContent = '';
  const previousFocus = alarmModalReturnFocus;
  alarmModalReturnFocus = null;
  if (previousFocus?.isConnected && !previousFocus.disabled) previousFocus.focus({preventScroll:true});
  else el('addAlarm').focus({preventScroll:true});
}

function renderAlarmModalChoices() {
  if (!alarmModalDraft) return;
  const draft = alarmModalDraft;
  const days = [...draft.days];
  for (const button of el('alarmEditDays').querySelectorAll('[data-edit-day]')) {
    button.setAttribute('aria-pressed', String(draft.days.has(Number(button.dataset.editDay))));
  }
  for (const button of el('alarmEditPresets').querySelectorAll('[data-edit-preset]')) {
    const value = button.dataset.editPreset;
    const selected = value === 'once' ? draft.schedule_mode === 'custom' && days.length === 0 :
      value === 'daily' ? draft.schedule_mode === 'custom' && days.length === 7 :
      draft.schedule_mode === value;
    button.setAttribute('aria-pressed', String(selected));
  }
  el('alarmEditEnabled').classList.toggle('on', draft.enabled);
  el('alarmEditEnabled').setAttribute('aria-checked', String(draft.enabled));
  el('alarmEditEnabledLabel').textContent = draft.enabled ? 'Включён' : 'Выключен';
}

async function saveAlarmEditor(event) {
  event.preventDefault();
  if (!alarmModalDraft || busy || alarmModalSaving) return;
  const timeText = el('alarmEditTime').value.trim();
  if (!validAlarmTime(timeText)) {
    el('alarmEditError').textContent = 'Введи время в формате 07:30 (от 00:00 до 23:59).';
    el('alarmEditTime').focus();
    return;
  }
  const [hour,minute] = timeText.split(':').map(Number);
  const draft = alarmModalDraft;
  const payload = {
    id:draft.id, hour, minute,
    label:el('alarmEditLabel').value.trim().slice(0,60),
    days:[...draft.days].sort((a,b)=>a-b),
    schedule_mode:draft.schedule_mode, enabled:draft.enabled,
  };
  alarmModalSaving = true;
  el('alarmEditSave').disabled = true;
  try {
    const saved = await command('upsert_alarm', {alarm:payload});
    if (saved) {
      closeAlarmEditor(true);
      renderedAlarms = '';
      renderAlarms();
    } else if (alarmModalDraft === draft) {
      el('alarmEditError').textContent = 'Не удалось сохранить. Проверь данные и повтори попытку.';
    }
  } finally {
    alarmModalSaving = false;
    el('alarmEditSave').disabled = false;
  }
}

// Right-click is a request to delete, never a destructive action on its own.
// Existing confirmation remains mandatory, including for disabled alarms.
async function requestAlarmRemoval(id) {
  if (!state || busy || pendingDelete || deletingAlarmId) return;
  const alarm = state.alarms.find((item) => item.id === id);
  if (!alarm) return;
  deletingAlarmId = id;
  try {
    clearTimeout(alarmSaveTimers.get(id));
    if (alarmEdits.get(id)?.saving) {
      toast('Будильник сохраняется. Повтори удаление после сохранения.');
      return;
    }
    if (alarmEdits.has(id)) await flushAlarmChange(id);
    if (alarmEdits.has(id)) {
      toast('Сначала заверши сохранение будильника.');
      return;
    }
    const approved = await requestDeleteConfirmation('Удалить будильник?', `«${alarm.label}» будет удалён.`);
    if (approved && state?.alarms.some((item) => item.id === id)) {
      alarmEdits.delete(id);
      await command('delete_alarm', {id});
    }
  } finally {
    deletingAlarmId = null;
  }
}

function alarmLiveMarkup(alarm, options = {}) {
  const {isNext = false, nextWhen = null} = options;
  const id = escapeHtml(alarm.id);
  const summary = escapeHtml(alarmScheduleLabel(alarm.days ?? [], alarm.schedule_mode ?? 'custom'));
  const title = escapeHtml(alarm.label);
  const eta = isNext && nextWhen ? escapeHtml(formatAlarmEta(nextWhen)) : '';
  return `<div class="alarm-live-row alarm-compact-row ${alarm.enabled ? '' : 'disabled'} ${isNext ? 'is-next' : ''}" data-id="${id}">
    <span class="compact-time mono">${pad2(alarm.hour)}:${pad2(alarm.minute)}</span>
    <div class="compact-info">
      <span class="compact-name" title="${title}">${title}</span>
      <div class="compact-meta">
        <span class="compact-schedule" title="${summary}">${summary}</span>
        ${isNext ? `<span class="compact-next" title="Следующий: ${eta}">Следующий · ${eta}</span>` : ''}
      </div>
    </div>
    <div class="compact-actions">
      <button type="button" role="switch" aria-checked="${alarm.enabled}" class="toggle ${alarm.enabled ? 'on' : ''}" data-action="toggle" data-id="${id}" aria-label="${alarm.enabled ? 'Выключить' : 'Включить'} будильник «${title}»"></button>
      <button type="button" class="compact-edit" data-edit-alarm="${id}" title="Изменить будильник" aria-label="Изменить будильник «${title}»">Изменить</button>
    </div>
  </div>`;
}

// Keep next-alarm indicator current without disrupting any text editing.
let alarmVisualFingerprint = '';
function refreshAlarmClock() {
  if (!state || activeTab !== 'alarm' || document.hidden || alarmModalDraft || alarmEdits.size) return;
  const active = document.activeElement;
  if (active?.closest?.('#deleteOverlay')) return;
  const now = new Date();
  const alarms = displayAlarms(now);
  const next = closestAlarm(alarms, now);
  const clockKey = [alarms.map((alarm) => alarm.id).join('|'),next?.alarm?.id ?? '',
    next?.when ? Math.ceil((next.when.getTime()-now.getTime())/60000) : 0].join('~');
  if (clockKey !== alarmVisualFingerprint) renderAlarms();
}

function renderAlarms() {
  if (!state) return;
  const now = new Date();
  const alarms = displayAlarms(now);
  const nearest = closestAlarm(alarms, now);
  alarmVisualFingerprint = [alarms.map((alarm) => alarm.id).join('|'), nearest?.alarm?.id ?? '',
    nearest?.when ? Math.ceil((nearest.when.getTime() - now.getTime()) / 60000) : 0].join('~');
  const list = el('alarmList');
  const pageSize = currentAlarmPageSize();
  const pages = Math.max(1, Math.ceil(alarms.length / pageSize));
  alarmPage = Math.max(0, Math.min(alarmPage, pages - 1));
  renderSmoothNumber(el('alarmsTotal'), String(alarms.length));
  el('alarmsTotal').classList.toggle('hidden', alarms.length === 0);
  list.classList.toggle('is-empty', alarms.length === 0);
  el('alarmPage').closest('.page-nav').classList.toggle('hidden', !paginationRequired(alarms.length, pageSize));
  renderSmoothNumber(el('alarmPage'), `${alarmPage + 1} / ${pages}`);
  el('alarmPrev').disabled = alarmPage === 0;
  el('alarmNext').disabled = alarmPage >= pages - 1;

  // Keep focus on the same action if a native update changes sorting.
  const active = document.activeElement;
  const rowId = active?.closest?.('.alarm-compact-row')?.dataset.id;
  const action = active?.matches?.('[data-action="toggle"]') ? 'toggle' :
    active?.matches?.('[data-edit-alarm]') ? 'edit' : null;
  const first = alarmPage * pageSize;
  const page = alarms.slice(first, first + pageSize);
  // CSS Grid fills down the left column, then down the right column.
  // Balance only the current page; never change the sorted order in storage.
  const columns = list.classList.contains('two-columns') && page.length > 1 ? 2 : 1;
  list.style.setProperty('--at-column-rows', String(Math.max(1, Math.ceil(page.length / columns))));
  list.innerHTML = page.length ? page.map((alarm) => {
    const isNext = nearest?.alarm?.id === alarm.id;
    return alarmLiveMarkup(alarm, {isNext, nextWhen:isNext ? nearest.when : null});
  }).join('') : '<div class="empty">Будильников нет</div>';
  if (rowId && action) {
    const selector = action === 'toggle' ? `[data-action="toggle"][data-id="${CSS.escape(rowId)}"]` :
      `[data-edit-alarm="${CSS.escape(rowId)}"]`;
    list.querySelector(selector)?.focus({preventScroll:true});
  }
}

function currentAlarmPageSize() {
  const list = el('alarmList');
  const active = el('panel-alarm').classList.contains('active');
  const styles = window.getComputedStyle(list);
  // Two genuinely shorter cards per row at desktop widths. Do not change
  // card height, font sizes or its two-line name/schedule layout.
  // One column remains available at narrow widths.
  const twoColumn = active && list.getBoundingClientRect().width >= 1200;
  list.classList.toggle('two-columns', twoColumn);
  const gap = Number.parseFloat(styles.rowGap) || 7;
  const available = active ? window.innerHeight - list.getBoundingClientRect().top - 12 :
    window.innerHeight - 145;
  // The 10-row reference is identical to the former v0.4.27 layout: 20
  // alarms now fit in two columns without squeezing their vertical size.
  const intended = twoColumn ? 10 : Math.max(1, Math.min(20, state?.alarms?.length ?? 1));
  const idealHeight = Math.floor((Math.max(0, available) - Math.max(0, intended - 1) * gap) / intended);
  const rowHeight = Math.max(56, Math.min(82, idealHeight));
  list.style.setProperty('--alarm-base-row-height', `${rowHeight}px`);
  if (!twoColumn) return Math.min(20, alarmRowsForSpace(available, rowHeight, gap));
  return Math.min(20, Math.min(10, alarmRowsForSpace(available, rowHeight, gap)) * 2);
}

function updateRangeAppearance(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const percent = max > min ? Math.max(0, Math.min(100, ((Number(input.value) - min) / (max - min)) * 100)) : 0;
  input.style.setProperty('--range-fill', `${percent}%`);
}

// Accessible, themed picker. The original #alarmMelody select remains the single
// source of truth for preference commands and migrated settings.
function syncMelodyPicker() {
  const select = el('alarmMelody');
  const selected = select.selectedOptions[0];
  if (selected) el('alarmMelodyValue').textContent = selected.textContent;
  for (const item of el('melodyOptions').querySelectorAll('[data-melody]')) {
    const option = [...select.options].find((candidate) => candidate.value === item.dataset.melody);
    item.textContent = option?.textContent ?? '';
    item.disabled = !!option?.disabled;
    item.setAttribute('aria-selected', String(item.dataset.melody === select.value));
  }
}

function setMelodyPickerOpen(open, focusItem = false) {
  const popup = el('melodyOptions');
  popup.classList.toggle('hidden', !open);
  el('alarmMelodyButton').setAttribute('aria-expanded', String(open));
  el('melodyPicker').classList.toggle('open', open);
  if (open && focusItem) {
    const selected = [...popup.querySelectorAll('[data-melody]')].find((item) => item.dataset.melody === el('alarmMelody').value && !item.disabled);
    (selected ?? popup.querySelector('[data-melody]:not(:disabled)'))?.focus();
  }
}

function bindMelodyPicker() {
  const picker = el('melodyPicker');
  const trigger = el('alarmMelodyButton');
  const popup = el('melodyOptions');
  trigger.addEventListener('click', () => setMelodyPickerOpen(popup.classList.contains('hidden'), true));
  popup.addEventListener('click', (event) => {
    const item = event.target.closest('[data-melody]');
    if (!item || item.disabled) return;
    el('alarmMelody').value = item.dataset.melody;
    el('alarmMelody').dispatchEvent(new Event('change', {bubbles:true}));
    syncMelodyPicker();
    setMelodyPickerOpen(false);
    trigger.focus();
  });
  picker.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!popup.classList.contains('hidden')) {
        event.preventDefault(); event.stopPropagation(); setMelodyPickerOpen(false); trigger.focus();
      }
      return;
    }
    if (event.key === 'Tab') { setMelodyPickerOpen(false); return; }
    if (!['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (popup.classList.contains('hidden')) { setMelodyPickerOpen(true, true); return; }
    const enabled = [...popup.querySelectorAll('[data-melody]')].filter((item) => !item.disabled);
    if (!enabled.length) return;
    const current = enabled.indexOf(document.activeElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length-1 :
      (current < 0 ? 0 : (current + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length);
    enabled[index].focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!picker.contains(event.target)) setMelodyPickerOpen(false);
  });
  syncMelodyPicker();
}

function renderPreferences() {
  if (!state?.preferences) return;
  const p = state.preferences;
  document.body.classList.toggle('reduced-motion', p.reduced_motion);
  [['settingSound',p.sound_enabled], ['settingNotifications',p.notifications_enabled], ['settingMotion',p.reduced_motion]].forEach(([id,enabled]) => {
    const toggle = el(id);
    toggle.setAttribute('aria-checked', String(enabled));
    toggle.classList.toggle('on', enabled);
  });
  // Do not change slider positions while the user is dragging them.
  if (document.activeElement !== el('alarmVolume')) el('alarmVolume').value = p.alarm_volume;
  if (document.activeElement !== el('alarmFade')) el('alarmFade').value = p.fade_in_seconds;
  renderSmoothNumber(el('alarmVolumeValue'), `${el('alarmVolume').value}%`);
  renderSmoothNumber(el('alarmFadeValue'), `${el('alarmFade').value} сек`);
  updateRangeAppearance(el('alarmVolume'));
  updateRangeAppearance(el('alarmFade'));
  if (document.activeElement !== el('alarmMelody')) el('alarmMelody').value = p.alarm_melody;
  const option = el('alarmMelody').querySelector('[value="custom"]');
  option.disabled = !p.custom_melody_name;
  option.textContent = p.custom_melody_name ? `Мой MP3: ${p.custom_melody_name}` : 'Мой MP3 (сначала добавьте файл)';
  syncMelodyPicker();
  el('soundNotice').classList.toggle('hidden', p.sound_enabled && p.alarm_melody !== 'system');
  const work = workDaysDraft ?? new Set(p.work_days ?? [0,1,2,3,4]);
  el('workDays').querySelectorAll('[data-work-day]').forEach((btn) => btn.setAttribute('aria-pressed', String(work.has(Number(btn.dataset.workDay)))));
  el('workDaysInfo').textContent = `Мои выходные: ${inlineWeekdays.filter((_,i)=>!work.has(i)).join(', ')}`;
  el('soundNotice').textContent = !p.sound_enabled
    ? 'Звук выключен: сигналы показываются в окне и, если разрешено, в уведомлениях Windows.'
    : p.alarm_melody === 'system'
      ? 'Будильник и таймер используют системный звук Windows (громкость — в микшере Windows).'
      : 'Музыка будильника играет по кругу до остановки. Таймер использует системный звук Windows.';
}

function renderExtraTimers() {
  if (!state) return;
  const timers = state.extra_timers ?? [];
  const pageSize = visibleRowsForHeight(window.innerHeight, 'extra');
  const pages = Math.max(1, Math.ceil(timers.length / pageSize));
  extraPage = Math.max(0, Math.min(extraPage, pages - 1));
  renderSmoothNumber(el('extraTimerCount'), String(timers.length));
  el('extraTimerCount').classList.toggle('hidden', timers.length === 0);
  el('extraTimersList').classList.toggle('hidden', timers.length === 0);
  el('extraTimersList').classList.toggle('is-empty', timers.length === 0);
  el('extraPageNav').classList.toggle('hidden', !paginationRequired(timers.length, pageSize));
  renderSmoothNumber(el('extraPage'), `${extraPage + 1} / ${pages}`);
  el('extraPrev').disabled = extraPage === 0;
  el('extraNext').disabled = extraPage + 1 >= pages;
  el('addExtraTimer').disabled = timers.length >= 5;
  const page = timers.slice(extraPage * pageSize, extraPage * pageSize + pageSize);
  const identity = JSON.stringify(page.map((item) => [item.id, item.title]));
  if (identity !== renderedExtraStructure) {
    renderedExtraStructure = identity;
    el('extraTimersList').innerHTML = page.length ? page.map((t) => `<div class="extra-timer-row" data-id="${escapeHtml(t.id)}">
      <span class="extra-timer-name" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
      <span class="extra-timer-time mono" data-time="${escapeHtml(t.id)}">00:00:00</span>
      <button type="button" class="extra-timer-control" data-action="toggle" data-id="${escapeHtml(t.id)}">Пауза</button>
      <button type="button" class="extra-timer-control" data-action="reset" data-id="${escapeHtml(t.id)}">Сброс</button>
      <button type="button" class="extra-timer-control delete" data-action="delete" data-id="${escapeHtml(t.id)}" aria-label="Удалить таймер">×</button>
    </div>`).join('') : '';
  }
  for (const timer of page) {
    const row = el('extraTimersList').querySelector(`[data-id="${CSS.escape(timer.id)}"].extra-timer-row`);
    if (!row) continue;
    renderSmoothNumber(row.querySelector('[data-time]'), formatCountdown(timer.remaining_ms));
    const paused = !timer.running && timer.remaining_ms > 0 && timer.remaining_ms < timer.duration_seconds * 1000;
    row.querySelector('[data-action="toggle"]').textContent = timer.running ? 'Ⅱ Пауза' : paused ? '▶ Далее' : '▶ Старт';
  }
}

function fillTimerInputs(totalSeconds) {
  el('timerHours').value = Math.floor(totalSeconds / 3600);
  el('timerMinutes').value = Math.floor(totalSeconds / 60) % 60;
  el('timerSeconds').value = totalSeconds % 60;
  markPreset();
}

function currentTimerSeconds() {
  return timerValuesToSeconds(el('timerHours').value, el('timerMinutes').value, el('timerSeconds').value);
}

function markPreset() {
  const seconds = currentTimerSeconds();
  document.querySelectorAll('.presets button').forEach((button) => button.classList.toggle('selected', Number(button.dataset.seconds) === seconds));
}

function timerProgressMotionAllowed() {
  return activeTab === 'timer' && !document.hidden &&
    !state?.preferences?.reduced_motion &&
    !(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

function stopTimerProgressTicker() {
  if (timerProgressFrame) cancelAnimationFrame(timerProgressFrame);
  timerProgressFrame = 0;
  timerProgressClock = null;
}

function paintTimerProgress(ratio) {
  // transform avoids layout recalculation and pixel-quantized width jumps.
  el('timerProgress').style.transform = `scaleX(${ratio.toFixed(7)})`;
}

function drawTimerProgressFrame(now) {
  timerProgressFrame = 0;
  if (!timerProgressClock || !state?.timer?.running || !timerProgressMotionAllowed()) return;
  const remaining = remainingAt(timerProgressClock, now);
  paintTimerProgress(progressRatio(remaining, timerProgressClock.durationMs));
  if (remaining > 0) timerProgressFrame = requestAnimationFrame(drawTimerProgressFrame);
}

function updateTimerProgress(remainingMs, durationMs, running, paused, complete) {
  const ratio = running || paused ? progressRatio(remainingMs, durationMs) : complete ? 0 : 1;
  el('timerProgressTrack').setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  if (running && !complete && durationMs > 0 && timerProgressMotionAllowed()) {
    const now = performance.now();
    timerProgressClock = syncProgressClock(timerProgressClock, remainingMs, durationMs, now);
    // Native state updates are authoritative; frames interpolate between them.
    paintTimerProgress(progressRatio(timerProgressClock.remainingMs, durationMs));
    if (!timerProgressFrame) timerProgressFrame = requestAnimationFrame(drawTimerProgressFrame);
  } else {
    stopTimerProgressTicker();
    paintTimerProgress(ratio);
  }
}

function renderTimer() {
  if (!state) return;
  const timer = state.timer;
  const paused = !timer.running && timer.remaining_ms > 0 && timer.remaining_ms < timer.duration_seconds * 1000;
  const complete = timer.remaining_ms === 0;
  let display = timer.remaining_ms;
  if (!timer.running && !paused) {
    // While idle, preview changes in the input without modifying the saved timer.
    const selected = currentTimerSeconds();
    if (selected !== null && !complete) display = selected * 1000;
  }
  renderSmoothNumber(el('timerDisplay'), formatCountdown(display));
  el('timerStatus').textContent = timer.running ? 'Идёт обратный отсчёт' : paused ? 'На паузе' : complete ? 'Время вышло' : 'Готов к запуску';
  el('timerStatus').classList.toggle('hidden', !paused && !complete);
  el('timerToggle').textContent = timer.running ? 'Ⅱ Пауза' : paused ? '▶ Продолжить' : '▶ Запустить';
  const inputsDisabled = timer.running || paused;
  document.querySelectorAll('.timer-inputs input, .presets button').forEach((item) => item.disabled = inputsDisabled);
  updateTimerProgress(timer.remaining_ms, timer.duration_seconds * 1000, timer.running, paused, complete);
}

// UI presentation only: display elapsed tenths at up to 10 Hz while running.
// Rust snapshots stay authoritative. Paused/reset values retain exact hundredths.
function drawStopwatchFrame(now) {
  stopwatchFrame = 0;
  if (activeTab !== 'stopwatch' || document.hidden || !state?.stopwatch?.running || !stopwatchClock) return;
  if (shouldPaintStopwatch(now, stopwatchLastPaintAt)) {
    const elapsed = stopwatchClock.elapsed + Math.max(0, now - stopwatchClock.receivedAt);
    const calmElapsed = calmRunningStopwatchMs(elapsed);
    renderSmoothNumber(el('stopwatchDisplay'), formatStopwatch(calmElapsed), {fractionDigits:2});
    stopwatchLastPaintAt = now;
  }
  stopwatchFrame = requestAnimationFrame(drawStopwatchFrame);
}

function renderStopwatch() {
  if (!state) return;
  const sw = state.stopwatch;
  const now = performance.now();
  // Native snapshots continuously correct the local monotonic presentation anchor.
  stopwatchClock = {elapsed:sw.elapsed_ms, receivedAt:now};
  const visualRunning = sw.running && activeTab === 'stopwatch' && !document.hidden;

  if (visualRunning) {
    // First paint after start/tab switch/return from background. Subsequent
    // snapshots only resync the clock; the frame loop owns running paints.
    if (!stopwatchVisualRunning) {
      renderSmoothNumber(el('stopwatchDisplay'), formatStopwatch(calmRunningStopwatchMs(sw.elapsed_ms)), {fractionDigits:2});
      stopwatchLastPaintAt = now;
    }
    if (!stopwatchFrame) stopwatchFrame = requestAnimationFrame(drawStopwatchFrame);
  } else {
    if (stopwatchFrame) {
      cancelAnimationFrame(stopwatchFrame);
      stopwatchFrame = 0;
    }
    stopwatchLastPaintAt = -Infinity;
    // Pause and reset are NEVER rounded or delayed: exact native centiseconds.
    if (!sw.running) renderSmoothNumber(el('stopwatchDisplay'), formatStopwatch(sw.elapsed_ms), {fractionDigits:2});
  }
  stopwatchVisualRunning = visualRunning;
  el('stopwatchToggle').textContent = sw.running ? 'Ⅱ Пауза' : sw.elapsed_ms ? '▶ Продолжить' : '▶ Запустить';
  el('stopwatchReset').disabled = !sw.running && sw.elapsed_ms === 0;
}

function renderAlert() {
  const alert = state?.alert;
  if (alert && alarmModalDraft) closeAlarmEditor(true);
  el('alertOverlay').classList.toggle('hidden', !alert);
  if (!alert) return;
  el('alertTitle').textContent = alert.title;
  el('alertBody').textContent = alert.body;
  el('snoozeAlert').classList.toggle('hidden', alert.kind !== 'alarm');
}


function isEditingTarget(target) {
  return !!target?.closest?.('input, textarea, select, [contenteditable="true"]');
}

// All backup JSON is parsed and validated again in Rust. The UI preview is
// informational and never authorizes an unchecked state replacement.
function backupCanProceed() {
  if (!api || busy) { toast('Операция сейчас недоступна.'); return false; }
  if (alarmModalDraft || alarmEdits.size || alarmSaveTimers.size || workDaysDraft || workDaysSaving || pendingDelete) {
    toast('Сначала заверши редактирование и дождись сохранения настроек.');
    return false;
  }
  if (state?.alert) { toast('Сначала останови текущий сигнал.'); return false; }
  return true;
}

async function refreshBackupUndo() {
  if (!api) return;
  try { el('backupUndo').disabled = !(await api('backup_status')); }
  catch { el('backupUndo').disabled = true; }
}

async function exportBackup() {
  if (!backupCanProceed()) return;
  busy = true;
  el('backupExport').disabled = true;
  try {
    const result = await api('backup_export');
    el('backupStatus').textContent = `Сохранено: ${result.path}`;
    toast(`Создана резервная копия (${result.alarms_count} будильников).`);
  } catch (error) { toast(`Не удалось сохранить копию: ${String(error)}`); }
  finally { busy = false; el('backupExport').disabled = false; }
}

async function importBackupFile(file) {
  if (!file || !backupCanProceed()) return;
  if (!file.name.toLowerCase().endsWith('.json') || file.size === 0 || file.size > 256 * 1024) {
    toast('Выбери JSON-файл резервной копии AngelTime размером до 256 КБ.');
    return;
  }
  let contents, info;
  busy = true;
  try {
    contents = await file.text();
    info = await api('backup_preview', {contents});
  } catch (error) {
    toast(`Не удалось прочитать резервную копию: ${String(error)}`);
    return;
  } finally { busy = false; }
  const message = `Будильников в копии: ${info.alarms_count}.\nДата: ${info.created_at}.\n\nТекущие будильники и настройки будут заменены. Таймеры и секундомер останутся без изменений.` +
    (info.custom_audio_unavailable ? '\n\nСобственный MP3 не входит в JSON. При восстановлении будет выбрана стандартная мелодия.' : '');
  if (!(await requestDeleteConfirmation('Восстановить из JSON?', message, 'Восстановить'))) return;
  if (!backupCanProceed()) return;
  busy = true;
  el('backupImport').disabled = true;
  try {
    const result = await api('backup_import', {contents});
    clearTimeout(workDaysSaveTimer);
    workDaysDraft = null;
    alarmEdits.clear();
    for (const timer of alarmSaveTimers.values()) clearTimeout(timer);
    alarmSaveTimers.clear();
    renderedAlarms = '';
    update(result);
    await refreshBackupUndo();
    el('backupStatus').textContent = `Восстановлено ${info.alarms_count} будильников из «${file.name}».`;
    toast('Резервная копия восстановлена. Доступна отмена импорта.');
  } catch (error) { toast(`Импорт не выполнен: ${String(error)}`); }
  finally { busy = false; el('backupImport').disabled = false; }
}

async function undoBackupImport() {
  if (!backupCanProceed() || el('backupUndo').disabled) return;
  const approved = await requestDeleteConfirmation('Отменить последний импорт?',
    'Будут возвращены будильники и настройки, сохранённые до последнего импорта. Изменения, сделанные после импорта, будут потеряны. Таймеры и секундомер не затронуты.', 'Вернуть');
  if (!approved || !backupCanProceed()) return;
  busy = true;
  el('backupUndo').disabled = true;
  try {
    const restored = await api('backup_undo');
    clearTimeout(workDaysSaveTimer);
    workDaysDraft = null;
    alarmEdits.clear();
    for (const timer of alarmSaveTimers.values()) clearTimeout(timer);
    alarmSaveTimers.clear();
    renderedAlarms = '';
    update(restored);
    el('backupStatus').textContent = 'Импорт отменён. Возвращены предыдущие будильники и настройки.';
    toast('Предыдущие настройки восстановлены.');
  } catch (error) { toast(`Не удалось отменить импорт: ${String(error)}`); }
  finally { busy = false; await refreshBackupUndo(); }
}

async function setPreference(key, value) {
  if (!state?.preferences) return;
  await command('set_preferences', {preferences: {...state.preferences, [key]: value}});
}

async function saveWorkDays() {
  if (!workDaysDraft || workDaysSaving || !api) return;
  workDaysSaving = true;
  const outgoing = [...workDaysDraft].sort((a,b)=>a-b);
  try {
    const snapshot = await api('set_work_days',{days:outgoing});
    if ([...workDaysDraft].sort((a,b)=>a-b).join(',') === outgoing.join(',')) workDaysDraft = null;
    if (snapshot) update(snapshot);
  } catch (error) { workDaysDraft = null; toast(`Не удалось сохранить рабочие дни: ${String(error)}`); renderPreferences(); }
  finally {
    workDaysSaving = false;
    if (workDaysDraft) { clearTimeout(workDaysSaveTimer); workDaysSaveTimer = setTimeout(()=>void saveWorkDays(),80); }
  }
}

async function toggleFullscreen() {
  if (!appWindow) return;
  try {
    await appWindow.setFullscreen(!(await appWindow.isFullscreen()));
  } catch (error) { toast(`Не удалось переключить полноэкранный режим: ${String(error)}`); }
}

function bindEvents() {
  let layoutQueued = false;
  window.addEventListener('resize', () => {
    if (layoutQueued || !state) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      renderAlarms();
      renderedExtraStructure = ''; renderExtraTimers();
    });
  });
  document.addEventListener('visibilitychange', () => { if (state) { renderTimer(); renderStopwatch(); } });
  bindMelodyPicker();
  // Right click a saved alarm to request removal. Everywhere else the WebView2 browser menu stays disabled.
  document.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (activeTab !== 'alarm' || pendingDelete) return;
    const row = event.target.closest?.('#alarmList .alarm-live-row');
    if (row?.dataset?.id) void requestAlarmRemoval(row.dataset.id);
  });
  el('cancelDelete').addEventListener('click', () => finishDeleteConfirmation(false));
  el('approveDelete').addEventListener('click', () => finishDeleteConfirmation(true));
  el('deleteOverlay').addEventListener('click', (event) => {
    if (event.target === el('deleteOverlay')) finishDeleteConfirmation(false);
  });
  document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => changeTab(button.dataset.tab)));
  document.querySelector('.top-navigation').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || event.ctrlKey || event.metaKey || event.altKey) return;
    const buttons = [...document.querySelectorAll('.top-navigation [data-tab]')];
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
      (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[target].focus();
    changeTab(buttons[target].dataset.tab);
  });
  el('addAlarm').addEventListener('click', () => openAlarmEditor());
  window.addEventListener('keydown', (event) => {
    if (pendingDelete) {
      if (event.key === 'Escape') {
        event.preventDefault();
        finishDeleteConfirmation(false);
      } else if (event.key === 'Tab') {
        // Keep keyboard focus inside the modal while it is visible.
        const buttons = [el('cancelDelete'), el('approveDelete')];
        const current = buttons.indexOf(document.activeElement);
        const next = current < 0 ? 0 : (current + (event.shiftKey ? 1 : -1) + buttons.length) % buttons.length;
        // Shift+Tab from Cancel -> Delete; Tab from Delete -> Cancel.
        if (current < 0 || (event.shiftKey && current === 0) || (!event.shiftKey && current === 1)) {
          event.preventDefault();
          buttons[current < 0 ? 0 : next].focus();
        }
      }
      return;
    }
    if (alarmModalDraft) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeAlarmEditor();
      } else if (event.key === 'Tab') {
        const items = [...el('alarmEditOverlay').querySelectorAll('button:not([disabled]):not(.hidden), input:not([disabled])')]
          .filter((item) => item.getClientRects().length > 0);
        const index = items.indexOf(document.activeElement);
        if (items.length && (index < 0 || (event.shiftKey && index === 0) || (!event.shiftKey && index === items.length - 1))) {
          event.preventDefault();
          items[event.shiftKey ? items.length - 1 : 0].focus();
        }
      }
      return;
    }
    if ((event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) && activeTab === 'alarm') {
      const row = event.target.closest?.('#alarmList .alarm-live-row');
      if (row?.dataset?.id) {
        event.preventDefault();
        void requestAlarmRemoval(row.dataset.id);
        return;
      }
    }
    const modalOpen = !!alarmModalDraft || !el('alertOverlay').classList.contains('hidden') || !el('deleteOverlay').classList.contains('hidden');
    if (appWindow && !modalOpen && !event.ctrlKey && !event.altKey && !event.metaKey) {
      if (event.key === 'F11') {
        event.preventDefault();
        void toggleFullscreen();
        return;
      }
      if (event.key === 'Escape' && el('melodyOptions').classList.contains('hidden')) {
        void appWindow.isFullscreen().then((full) => full && appWindow.setFullscreen(false))
          .catch((error) => toast(`Не удалось выйти из полного экрана: ${String(error)}`));
        return;
      }
    }
    const action = shortcutAction({key:event.key, code:event.code, ctrlKey:event.ctrlKey, metaKey:event.metaKey,
      altKey:event.altKey, shiftKey:event.shiftKey, editable:isEditingTarget(event.target), interactive:!!event.target?.closest?.('button, a, [role="switch"]'), modalOpen, tab:activeTab});
    if (!action) return;
    event.preventDefault();
    if (action.startsWith('tab:')) changeTab(['alarm','timer','stopwatch','settings'][Number(action.split(':')[1])]);
    if (action === 'new-alarm') openAlarmEditor();
    if (action === 'toggle') el(activeTab === 'timer' ? 'timerToggle' : 'stopwatchToggle').click();
  });
  el('alarmList').addEventListener('click', (event) => {
    if (!state || busy || alarmModalDraft) return;
    const editButton = event.target.closest('[data-edit-alarm]');
    if (editButton) {
      const alarm = state.alarms.find((entry) => entry.id === editButton.dataset.editAlarm);
      if (alarm) openAlarmEditor(alarm);
      return;
    }
    const button = event.target.closest('[data-action="toggle"]');
    if (!button) return;
    const current = stagedAlarm(button.dataset.id);
    if (!current) return;
    scheduleAlarmChange(current.id, {enabled:!current.enabled}, true);
    button.classList.toggle('on', !current.enabled);
    button.setAttribute('aria-checked', String(!current.enabled));
    button.setAttribute('aria-label', `${current.enabled ? 'Включить' : 'Выключить'} будильник «${current.label}»`);
  });

  // One modal handles creation, editing, scheduling and explicit deletion.
  el('alarmEditForm').addEventListener('submit', (event) => void saveAlarmEditor(event));
  el('alarmEditCancel').addEventListener('click', () => closeAlarmEditor());
  el('alarmEditClose').addEventListener('click', () => closeAlarmEditor());
  el('alarmEditOverlay').addEventListener('click', (event) => {
    if (event.target === el('alarmEditOverlay')) closeAlarmEditor();
  });
  el('alarmEditEnabled').addEventListener('click', () => {
    if (!alarmModalDraft || alarmModalSaving) return;
    alarmModalDraft.enabled = !alarmModalDraft.enabled;
    renderAlarmModalChoices();
  });
  el('alarmEditPresets').addEventListener('click', (event) => {
    const button = event.target.closest('[data-edit-preset]');
    if (!alarmModalDraft || alarmModalSaving || !button) return;
    const preset = button.dataset.editPreset;
    alarmModalDraft.days = new Set(modeDays(preset, []));
    alarmModalDraft.schedule_mode = ['workdays','weekends'].includes(preset) ? preset : 'custom';
    renderAlarmModalChoices();
  });
  el('alarmEditDays').addEventListener('click', (event) => {
    const button = event.target.closest('[data-edit-day]');
    if (!alarmModalDraft || alarmModalSaving || !button) return;
    const day = Number(button.dataset.editDay);
    if (alarmModalDraft.days.has(day)) alarmModalDraft.days.delete(day);
    else alarmModalDraft.days.add(day);
    alarmModalDraft.schedule_mode = 'custom';
    renderAlarmModalChoices();
  });
  el('alarmEditDelete').addEventListener('click', () => {
    if (!alarmModalDraft?.id || alarmModalSaving) return;
    const id = alarmModalDraft.id;
    closeAlarmEditor();
    void requestAlarmRemoval(id);
  });
  el('alarmPrev').addEventListener('click', () => { alarmPage--; renderAlarms(); });
  el('alarmNext').addEventListener('click', () => { alarmPage++; renderAlarms(); });
  document.querySelectorAll('.timer-inputs input').forEach((input) => input.addEventListener('input', () => { markPreset(); renderTimer(); }));
  document.querySelectorAll('.presets button').forEach((button) => button.addEventListener('click', () => { fillTimerInputs(Number(button.dataset.seconds)); renderTimer(); }));
  el('timerToggle').addEventListener('click', async () => {
    if (!state) return;
    if (state.timer.running) return void await command('timer_pause');
    if (state.timer.remaining_ms > 0 && state.timer.remaining_ms < state.timer.duration_seconds * 1000) return void await command('timer_resume');
    const seconds = currentTimerSeconds();
    if (seconds === null) { toast('Укажи время от 1 секунды до 99:59:59.'); return; }
    await command('timer_start', {seconds});
  });
  el('timerReset').addEventListener('click', async () => { const result = await command('timer_reset'); if (result) fillTimerInputs(result.timer.duration_seconds); });
  el('addExtraTimer').addEventListener('click', async () => {
    const seconds = parseTimerClock(el('extraDuration').value);
    if (seconds === null) { toast('Укажи время нового таймера в формате 00:05:00 (до 99:59:59).'); return; }
    const result = await command('extra_timer_add', {seconds});
    if (result) { extraPage = Math.floor((result.extra_timers.length - 1) / visibleRowsForHeight(window.innerHeight, 'extra')); renderedExtraStructure = ''; renderExtraTimers(); }
  });
  el('extraTimersList').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button || !state) return;
    const id = button.dataset.id;
    const timer = state.extra_timers?.find((entry) => entry.id === id);
    if (!timer) return;
    let action = button.dataset.action;
    if (action === 'toggle') action = nextExtraTimerAction(timer);
    if (action === 'delete') {
      const approved = await requestDeleteConfirmation('Удалить таймер?', `«${timer.title}» будет удалён.`);
      if (!approved || !state?.extra_timers?.some((item) => item.id === id)) return;
    }
    const result = await command('extra_timer_action', {id, action});
    if (result) renderExtraTimers();
  });
  el('extraPrev').addEventListener('click', () => { extraPage--; renderedExtraStructure = ''; renderExtraTimers(); });
  el('extraNext').addEventListener('click', () => { extraPage++; renderedExtraStructure = ''; renderExtraTimers(); });
  el('stopwatchToggle').addEventListener('click', () => command('stopwatch_toggle'));
  el('stopwatchReset').addEventListener('click', () => command('stopwatch_reset'));
  [['settingSound','sound_enabled'],['settingNotifications','notifications_enabled'],['settingMotion','reduced_motion']].forEach(([id,key]) => {
    el(id).addEventListener('click', () => {
      if (state?.preferences && !busy) setPreference(key, !state.preferences[key]);
    });
  });
  el('alarmMelody').addEventListener('change', async () => {
    if (!state || busy) return;
    const value = el('alarmMelody').value;
    if (value === 'custom' && !state.preferences.custom_melody_name) {
      el('customAudioFile').click();
      return;
    }
    await setPreference('alarm_melody', value);
  });
  // Save sliders only on release, not continuously while dragging.
  [['alarmVolume','alarm_volume','alarmVolumeValue','%'],['alarmFade','fade_in_seconds','alarmFadeValue',' сек']].forEach(([id,key,output,suffix]) => {
    el(id).addEventListener('input', () => { renderSmoothNumber(el(output), `${el(id).value}${suffix}`); updateRangeAppearance(el(id)); });
    el(id).addEventListener('change', () => { if (state) setPreference(key, Number(el(id).value)); });
  });
  el('workDays').addEventListener('click', (event) => {
    const button = event.target.closest('[data-work-day]');
    if (!button || !state?.preferences) return;
    const work = new Set(workDaysDraft ?? state.preferences.work_days ?? [0,1,2,3,4]);
    const day = Number(button.dataset.workDay);
    if (work.has(day)) work.delete(day); else work.add(day);
    if (work.size === 0 || work.size === 7) {
      toast('Нужен хотя бы один рабочий и один выходной день.');
      return;
    }
    workDaysDraft = work;
    renderPreferences();
    clearTimeout(workDaysSaveTimer);
    workDaysSaveTimer = setTimeout(()=>void saveWorkDays(),270);
  });
  el('backupExport').addEventListener('click', () => void exportBackup());
  el('backupImport').addEventListener('click', () => {
    if (backupCanProceed()) el('backupFile').click();
  });
  el('backupFile').addEventListener('change', async () => {
    const file = el('backupFile').files?.[0];
    try { if (file) await importBackupFile(file); }
    finally { el('backupFile').value = ''; }
  });
  el('backupUndo').addEventListener('click', () => void undoBackupImport());
  el('importMelody').addEventListener('click', () => el('customAudioFile').click());
  el('customAudioFile').addEventListener('change', async () => {
    const file = el('customAudioFile').files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.mp3') || file.size > 12 * 1024 * 1024 || file.size === 0) {
      toast('Выбери MP3 размером до 12 МБ.'); el('customAudioFile').value = ''; return;
    }
    try {
      const encoded = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Ошибка чтения MP3'));
        reader.onload = () => resolve(String(reader.result).split(',', 2)[1]);
        reader.readAsDataURL(file);
      });
      const result = await command('import_alarm_audio', {name:file.name,encoded});
      if (result) toast('Мелодия установлена. Проверь звук кнопкой «Слушать».');
    } catch (error) { toast(String(error)); }
    finally { el('customAudioFile').value = ''; }
  });
  el('previewSound').addEventListener('click', async () => {
    if (!api) { toast('Проверка звука доступна в приложении Tauri.'); return; }
    try { await api('preview_sound'); } catch (error) { toast(`Не удалось воспроизвести звук: ${String(error)}`); }
  });
  el('stopPreviewSound').addEventListener('click', async () => {
    if (!api) return;
    try { await api('stop_preview_sound'); } catch (error) { toast(String(error)); }
  });
  el('dismissAlert').addEventListener('click', () => command('dismiss_alert'));
  el('snoozeAlert').addEventListener('click', () => command('snooze_alert'));
}

async function init() {
  bindEvents();
  window.setInterval(refreshAlarmClock, 15000);
  if (!api || !listen) {
    return;
  }
  try {
    await listen('angel:state', (event) => update(event.payload));
    update(await api('get_state'));
    await refreshBackupUndo();
  } catch (error) {
    toast(`Ошибка запуска: ${String(error)}`);
  }
}

init();
