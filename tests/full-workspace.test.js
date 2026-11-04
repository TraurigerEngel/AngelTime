import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../web/visual-0426.css',import.meta.url),'utf8');
const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');

test('full workspace stylesheet is loaded after compact styling', () => {
  assert.ok(html.indexOf('visual-0425.css') < html.indexOf('visual-0426.css'));
  assert.match(css,/\.top-navigation,\.main>\.tab-panel\s*\{/);
  assert.match(css,/max-width:none!important/);
  assert.match(css,/padding-inline:var\(--at-outer\)!important/);
});

test('shared 12/8/4px layout values are declared', () => {
  assert.match(css,/--at-outer:12px/);
  assert.match(css,/--at-space:8px/);
  assert.match(css,/--at-tight:4px/);
  assert.match(css,/--at-inset:12px/);
});

test('modal and smart alarm functions stay intact', () => {
  assert.match(app,/function openAlarmEditor\(/);
  assert.match(app,/sortAlarmsByNextTrigger/);
  assert.match(app,/function currentAlarmPageSize\(/);
  assert.match(app,/Math\.min\(20, alarmRowsForSpace/);
  assert.match(html,/id="alarmEditOverlay"/);
  assert.match(html,/id="exportBackup"|id="backupExport"/);
});
