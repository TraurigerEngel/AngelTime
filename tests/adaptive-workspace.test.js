import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {alarmRowsForSpace} from '../web/logic.js';
const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../web/visual-0427.css',import.meta.url),'utf8');
const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
test('readable adaptive stylesheet loads after full-width CSS',()=>{
  assert.ok(html.indexOf('visual-0426.css') < html.indexOf('visual-0427.css'));
  assert.match(css,/--at-outer:14px/);
  assert.match(css,/--at-tight:7px/);
});
test('alarm rows adapt within 56-82px and never force 20 tiny rows',()=>{
  assert.match(app,/const rowHeight = Math.max\(56, Math.min\(82, idealHeight\)\)/);
  assert.match(app,/list.style.setProperty\('--alarm-base-row-height'/);
  assert.equal(alarmRowsForSpace(780,71,7),10);
  assert.equal(alarmRowsForSpace(780,56,7),12);
});
test('alarm information is grouped with full-size edit action',()=>{
  assert.match(app,/class="compact-info"/);
  assert.match(app,/class="compact-actions"/);
  assert.match(app,/>Изменить<\/button>/);
  assert.match(app,/sortAlarmsByNextTrigger/);
  assert.match(app,/function openAlarmEditor\(/);
});
