import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {alarmRowsForSpace, paginationRequired, sortAlarmsByNextTrigger} from '../web/logic.js';

const html = readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const app = readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const css = readFileSync(new URL('../web/visual-0425.css',import.meta.url),'utf8');

test('20 compact alarm rows fit a 1057px desktop work area without pagination', () => {
  const available = 1057 - 140 - 12;
  const rows = Math.min(20, alarmRowsForSpace(available,42,3));
  assert.equal(rows,20);
  assert.equal(paginationRequired(20,rows),false);
  assert.equal(paginationRequired(21,rows),true);
  assert.match(css,/--alarm-base-row-height:42px/);
  assert.match(css,/grid-auto-rows:42px/);
});

test('all modal editor controls exist exactly once and have accessible labels', () => {
  for(const id of ['alarmEditOverlay','alarmEditForm','alarmEditTitle','alarmEditTime','alarmEditLabel',
      'alarmEditDays','alarmEditPresets','alarmEditEnabled','alarmEditDelete','alarmEditCancel','alarmEditSave']) {
    assert.equal((html.match(new RegExp(`id="${id}"`,'g')) ?? []).length,1,id);
  }
  assert.match(html,/id="alarmEditForm"[^>]*role="dialog" aria-modal="true"/);
  assert.match(html,/id="alarmEditTime"[^>]*maxlength="5"/);
  assert.equal((html.match(/data-edit-day="\d"/g)??[]).length,7);
  assert.equal((html.match(/data-edit-preset="/g)??[]).length,4);
});

test('creation and edits use modal with explicit save and strict time validation', () => {
  assert.match(app,/el\('addAlarm'\)\.addEventListener\('click', \(\) => openAlarmEditor\(\)\)/);
  assert.match(app,/el\('alarmEditForm'\)\.addEventListener\('submit',/);
  assert.match(app,/validAlarmTime\(timeText\)/);
  assert.match(app,/command\('upsert_alarm', \{alarm:payload\}\)/);
  assert.doesNotMatch(app,/function inlineEditorMarkup\(/);
  assert.doesNotMatch(app,/data-alarm-field="time"/);
});

test('modal editing retains original scheduling and right-click confirmed deletion', () => {
  assert.match(app,/days: new Set\(alarm\?\.days \?\? \[\]\)/);
  assert.match(app,/schedule_mode: alarm\?\.schedule_mode \?\? 'custom'/);
  assert.match(app,/requestAlarmRemoval\(row\.dataset\.id\)/);
  assert.match(app,/requestDeleteConfirmation\('Удалить будильник\?'/);
  assert.match(app,/alarmEditDelete/);
});

test('sorting is not persisted, and the closest active alarm stays first', () => {
  const now=new Date(2026,9,19,21,0);
  const input=[
    {id:'disabled',enabled:false,hour:21,minute:10,label:'Disabled',days:[]},
    {id:'tomorrow',enabled:true,hour:5,minute:0,label:'Tomorrow',days:[]},
    {id:'soon',enabled:true,hour:21,minute:4,label:'Soon',days:[]}
  ];
  const sorted=sortAlarmsByNextTrigger(input,now);
  assert.deepEqual(sorted.map(a=>a.id),['soon','tomorrow','disabled']);
  assert.deepEqual(input.map(a=>a.id),['disabled','tomorrow','soon']);
});

test('modal blocks backup operations and keeps keyboard focus inside', () => {
  assert.match(app,/if \(alarmModalDraft \|\| alarmEdits\.size \|\| alarmSaveTimers\.size/);
  assert.match(app,/if \(alarmModalDraft\) \{\s*if \(event\.key === 'Escape'\)/);
  assert.match(app,/items\[event\.shiftKey \? items\.length - 1 : 0\]\.focus\(\)/);
});
