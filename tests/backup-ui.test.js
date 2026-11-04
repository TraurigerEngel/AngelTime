import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html = readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const app = readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const rust = readFileSync(new URL('../src-tauri/src/lib.rs',import.meta.url),'utf8');

test('backup actions and hidden JSON picker are present exactly once',() => {
  for (const id of ['backupExport','backupImport','backupFile','backupUndo','backupStatus']) {
    assert.equal((html.match(new RegExp(`id="${id}"`,'g')) ?? []).length,1);
  }
  assert.match(html,/id="backupFile"[^>]*accept="\.json,application\/json"/);
});

test('backup import uses native validation and user confirmation',() => {
  assert.match(app,/api\('backup_preview', \{contents\}\)/);
  assert.match(app,/requestDeleteConfirmation\('Восстановить из JSON\?'/);
  assert.match(app,/api\('backup_import', \{contents\}\)/);
  assert.match(rust,/fn validated_backup\(content: &str\)/);
  assert.match(rust,/fn backup_import\(app: tauri::AppHandle, contents: String\)/);
});

test('backup leaves runtime timers untouched and creates rollback first',() => {
  const start=rust.indexOf('fn backup_import(');
  const end=rust.indexOf('fn backup_undo(',start);
  const body=rust.slice(start,end);
  assert.match(body,/let mut next = data\.clone\(\)/);
  assert.match(body,/save\(&undo_file\(&store\.file\), &undo\)\?;/);
  assert.match(body,/save\(&store\.file, &next\)\?;/);
  assert.doesNotMatch(body,/next\.timer\s*=/);
  assert.doesNotMatch(body,/next\.stopwatch\s*=/);
  assert.doesNotMatch(body,/next\.extra_timers\s*=/);
});

test('restore checkpoint persists and is available after restart',() => {
  assert.match(rust,/state\.before-last-import\.json/);
  assert.match(rust,/fn backup_status\(app: tauri::AppHandle\)/);
  assert.match(rust,/fn backup_undo\(app: tauri::AppHandle\)/);
});

test('backup path uses the approved gold selection highlight',() => {
  const css = readFileSync(new URL('../web/visual-0423.css',import.meta.url),'utf8');
  assert.match(css, /\.backup-path::selection/);
});

test('settings scrolls when the extra backup card does not fit vertically',() => {
  const css = readFileSync(new URL('../web/visual-0423.css',import.meta.url),'utf8');
  assert.match(css, /#panel-settings\.tab-panel\s*\{[^}]*overflow-y:auto/);
});
