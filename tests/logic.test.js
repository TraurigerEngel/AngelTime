import test from 'node:test';
import assert from 'node:assert/strict';
import {closestAlarm, escapeHtml, formatCountdown, formatDays, formatStopwatch, nextExtraTimerAction, parseTimerClock, shortcutAction, timerValuesToSeconds} from '../web/logic.js';
import { alarmScheduleLabel, validAlarmTime, alarmRowsForSpace, alarmRowsForLayout, paginationRequired, visibleRowsForHeight } from '../web/logic.js';

test('timer is rounded up, not prematurely showing zero', () => {
  assert.equal(formatCountdown(1), '00:00:01');
  assert.equal(formatCountdown(1001), '00:00:02');
  assert.equal(formatCountdown(0), '00:00:00');
  assert.equal(formatCountdown(359999000), '99:59:59');
});

test('stopwatch centiseconds formatting', () => {
  assert.equal(formatStopwatch(9876), '00:00:09.87');
  assert.equal(formatStopwatch(3_600_010), '01:00:00.01');
});

test('timer input validation', () => {
  assert.equal(timerValuesToSeconds('0', '5', '10'), 310);
  assert.equal(timerValuesToSeconds('0', '0', '0'), null);
  assert.equal(timerValuesToSeconds('0', '60', '0'), null);
  assert.equal(timerValuesToSeconds('100', '0', '0'), null);
  assert.equal(timerValuesToSeconds('', '', ''), null);
  assert.equal(timerValuesToSeconds('1.5', '0', '0'), null);
});

test('day labels', () => {
  assert.equal(formatDays([]), 'Один раз');
  assert.equal(formatDays([0, 1, 2, 3, 4]), 'По будням');
  assert.equal(formatDays([5, 6]), 'По выходным');
  assert.equal(formatDays([0, 1, 2, 3, 4, 5, 6]), 'Каждый день');
});

test('next alarm weekday and next day handling', () => {
  const monday = new Date(2026, 9, 19, 9, 0);
  const tuesdayOnly = {hour:8,minute:30,enabled:true,days:[1]};
  const next = closestAlarm([tuesdayOnly], monday);
  assert.equal(next.when.getDay(), 2);
  assert.equal(next.when.getDate(), 20);
  assert.equal(closestAlarm([{hour:8,minute:30,enabled:false,days:[]}], monday), null);
});

test('alarm label is encoded before DOM insertion', () => {
  assert.equal(escapeHtml('<script>"&'), '&lt;script&gt;&quot;&amp;');
});

test('shortcuts switch tabs with Ctrl+1 through Ctrl+4', () => {
  for (const n of [1, 2, 3, 4]) {
    assert.equal(shortcutAction({key:String(n), code:`Digit${n}`, ctrlKey:true}), `tab:${n - 1}`);
  }
  assert.equal(shortcutAction({key:'5',code:'Digit5',ctrlKey:true}), null);
});

test('shortcuts do not override editing, modals or system modifiers', () => {
  assert.equal(shortcutAction({key:'n',code:'KeyN',editable:true}), null);
  assert.equal(shortcutAction({key:'n',code:'KeyN',modalOpen:true}), null);
  assert.equal(shortcutAction({key:' ',code:'Space',tab:'timer',editable:true}), null);
  assert.equal(shortcutAction({key:'1',code:'Digit1',ctrlKey:true,altKey:true}), null);
  assert.equal(shortcutAction({key:'n',code:'KeyN',metaKey:true}), null);
});

test('shortcuts depend on current tab', () => {
  assert.equal(shortcutAction({key:'n',code:'KeyN',tab:'alarm'}), 'new-alarm');
  assert.equal(shortcutAction({key:'n',code:'KeyN',tab:'stopwatch'}), null);
  assert.equal(shortcutAction({key:' ',code:'Space',tab:'timer'}), 'toggle');
  assert.equal(shortcutAction({key:' ',code:'Space',tab:'stopwatch'}), 'toggle');
  assert.equal(shortcutAction({key:' ',code:'Space',tab:'settings'}), null);
  assert.equal(shortcutAction({key:'l',code:'KeyL',tab:'stopwatch'}), null);
  assert.equal(shortcutAction({key:'l',code:'KeyL',tab:'alarm'}), null);
});

test('space on a focused button is handled once by native browser behavior', () => {
  assert.equal(shortcutAction({key:' ',code:'Space',tab:'timer',interactive:true}), null);
  assert.equal(shortcutAction({key:'l',code:'KeyL',tab:'stopwatch',interactive:true}), null);
  assert.equal(shortcutAction({key:'1',code:'Digit1',tab:'stopwatch',ctrlKey:true,interactive:true}), 'tab:0');
});

test('independent timer starts, pauses and resumes without changing other timers', () => {
  const base = {duration_seconds:120, remaining_ms:120000, running:false};
  const running = {...base,running:true,remaining_ms:90000};
  const paused = {...running,running:false};
  const completed = {...base,remaining_ms:0};
  assert.equal(nextExtraTimerAction(base),'start');
  assert.equal(nextExtraTimerAction(running),'pause');
  assert.equal(nextExtraTimerAction(paused),'resume');
  assert.equal(nextExtraTimerAction(completed),'start');
});

test('new timer input uses its own independent duration', () => {
  assert.equal(parseTimerClock('00:05:00'),300);
  assert.equal(parseTimerClock('1:02:03'),3723);
  assert.equal(parseTimerClock('00:00:00'),null);
  assert.equal(parseTimerClock('00:60:00'),null);
  assert.equal(parseTimerClock('not a time'),null);
});

test('pagination stays hidden for empty and single-page lists', () => {
  assert.equal(paginationRequired(0, 4), false);
  assert.equal(paginationRequired(1, 4), false);
  assert.equal(paginationRequired(4, 4), false);
  assert.equal(paginationRequired(5, 4), true);
  assert.equal(paginationRequired(2, 2), false);
  assert.equal(paginationRequired(3, 2), true);
});

test('pagination rejects invalid list metadata', () => {
  assert.equal(paginationRequired(-1, 4), false);
  assert.equal(paginationRequired(10, 0), false);
  assert.equal(paginationRequired(NaN, 2), false);
});

test('full-height layout keeps compact alarm and extra-timer pagination', () => {
  assert.equal(visibleRowsForHeight(690), 4);
  assert.equal(visibleRowsForHeight(900), 7);
  assert.equal(visibleRowsForHeight(1080), 10);
  assert.equal(visibleRowsForHeight(690, 'extra'), 2);
  assert.equal(visibleRowsForHeight(1080, 'extra'), 5);
  assert.equal(visibleRowsForHeight(NaN), 4);
});

test('alarm list uses all available vertical space instead of a ten-row cap', () => {
  assert.equal(alarmRowsForSpace(875,43,6),17);
  assert.equal(alarmRowsForSpace(905,43,6),18);
  assert.equal(alarmRowsForSpace(480,43,6),9);
  assert.equal(alarmRowsForSpace(0,43,6),1);
  assert.equal(alarmRowsForSpace(NaN,43,6),1);
  assert.equal(paginationRequired(11,alarmRowsForSpace(875,43,6)),false);
  assert.equal(paginationRequired(19,alarmRowsForSpace(875,43,6)),true);
});

test('compact alarm summaries retain schedule meaning', () => {
  assert.equal(alarmScheduleLabel([0,1,2,3,4], 'workdays'), 'Мои будни');
  assert.equal(alarmScheduleLabel([5,6], 'weekends'), 'Мои выходные');
  assert.equal(alarmScheduleLabel([0,1,2,3,4,5,6]), 'Каждый день');
  assert.equal(alarmScheduleLabel([]), 'Разово');
  assert.equal(alarmScheduleLabel([0,4,6]), 'Пн · Пт · Вс');
});

test('directly edited alarm times are validated strictly before saving', () => {
  for (const x of ['00:00','07:30','23:59']) assert.equal(validAlarmTime(x), true);
  for (const x of ['24:00','12:60','7:30','00:0','01:01:00','','abc']) assert.equal(validAlarmTime(x), false);
});


test('expanded schedule reserves exact pixels instead of removing two alarm rows', () => {
  // 11 × 70 + 10 × 6 + (138 - 70) = 898px; should fit into 910px.
  assert.equal(alarmRowsForLayout(910, 70, 6, 138), 11);
  assert.equal(paginationRequired(11, alarmRowsForLayout(910, 70, 6, 138)), false);
  // 12 normal rows + expansion genuinely cannot fit.
  assert.equal(paginationRequired(12, alarmRowsForLayout(910, 70, 6, 138)), true);
  assert.equal(alarmRowsForLayout(910, 70, 6), 12);
  // A narrow window may need a second page rather than clipping content.
  assert.equal(alarmRowsForLayout(465, 76, 6, 150), 4);
});

test('new inline draft needs extra space but existing editor replaces a row', () => {
  assert.equal(alarmRowsForLayout(910,70,6,0,180,'new'), 9);
  assert.equal(alarmRowsForLayout(910,70,6,0,180,'replace'), 10);
  assert.equal(alarmRowsForLayout(910,70,6,138,180,'new'), 8);
  assert.equal(alarmRowsForLayout(NaN,70,6,138), 1);
  assert.equal(alarmRowsForLayout(400,70,-6,138), 1);
});


test('maximized 1920x1057 work area keeps eleven alarms with one schedule open', () => {
  // 156px measured list offset; leave 12px safety room at the bottom.
  const available = 1057 - 156 - 12;
  const perPage = alarmRowsForLayout(available, 68, 5, 138);
  assert.equal(perPage, 11);
  assert.equal(paginationRequired(11, perPage), false);
  // At a genuinely smaller viewport, use pagination instead of clipping.
  assert.equal(paginationRequired(11, alarmRowsForLayout(980 - 156 - 12, 68, 5, 138)), true);
});

test('schedule close returns the original normal-row spacing', () => {
  const available = 1057 - 156 - 12;
  assert.equal(alarmRowsForLayout(available, 70, 6), 11);
  assert.equal(alarmRowsForLayout(available, 68, 5, 138), 11);
});

// No lap shortcut remains after v0.4.18 (the stopwatch is Start / Pause / Reset only).
test('stopwatch no longer exposes the lap hotkey', () => {
  for (const key of ['l','L']) {
    assert.equal(shortcutAction({key,code:'KeyL',tab:'stopwatch'}), null);
  }
});
