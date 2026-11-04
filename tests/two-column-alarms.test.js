import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {alarmRowsForSpace} from '../web/logic.js';
const app = readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const css = readFileSync(new URL('../web/visual-0428.css',import.meta.url),'utf8');
const html = readFileSync(new URL('../web/index.html',import.meta.url),'utf8');

test('two-column stylesheet loads last, after v0.4.27',()=>{
  assert.ok(html.indexOf('visual-0427.css') < html.indexOf('visual-0428.css'));
  assert.match(css,/grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css,/grid-auto-flow:column/);
});
test('column order is vertical, split over at most 10 rows per side',()=>{
  assert.match(app,/Math\.ceil\(page\.length \/ columns\)/);
  assert.match(app,/--at-column-rows/);
  assert.match(app,/Math\.min\(10, alarmRowsForSpace/);
  assert.equal(Math.min(20,Math.min(10,alarmRowsForSpace(792,72,7))*2),20);
});
test('row height, two-line information and modal editor preserved',()=>{
  assert.match(app,/const rowHeight = Math\.max\(56, Math\.min\(82, idealHeight\)\)/);
  assert.match(app,/class="compact-name"/);
  assert.match(app,/class="compact-schedule"/);
  assert.match(app,/class="compact-meta"/);
  assert.match(app,/function openAlarmEditor\(/);
  assert.match(app,/sortAlarmsByNextTrigger/);
});
test('readable sizes are not reduced',()=>{
  assert.doesNotMatch(css,/height:42px|font-size:10px|font-size:11px/);
  assert.match(css,/grid-template-columns:90px minmax\(0,1fr\) 166px/);
});
