import test from 'node:test';
import assert from 'node:assert/strict';
import {progressRatio, remainingAt, syncProgressClock} from '../web/timer-progress.js';

test('progress ratio supports sub-percent precision and clamps', () => {
  assert.equal(progressRatio(9950,10000),0.995);
  assert.equal(progressRatio(3000,10000),0.3);
  assert.equal(progressRatio(-100,10000),0);
  assert.equal(progressRatio(11000,10000),1);
  assert.equal(progressRatio(0,0),1);
});

test('visual timer progresses between 200ms Rust snapshots', () => {
  const c=syncProgressClock(null,10000,10000,100);
  assert.equal(remainingAt(c,116),9984);
  assert.equal(remainingAt(c,200),9900);
  assert.equal(remainingAt(c,300),9800);
  assert.equal(progressRatio(remainingAt(c,150),10000),0.995);
});

test('native updates cannot move progress backwards while running', () => {
  const first=syncProgressClock(null,8000,10000,0);
  const second=syncProgressClock(first,7860,10000,200); // newer snapshot a little higher than predicted
  assert.ok(second.remainingMs <= remainingAt(first,200));
  assert.ok(remainingAt(second,216) < second.remainingMs);
});

test('large native correction and timer reset use a new authoritative clock', () => {
  const first=syncProgressClock(null,5000,10000,0);
  const corrected=syncProgressClock(first,4250,10000,200);
  assert.equal(corrected.remainingMs,4250);
  const restarted=syncProgressClock(null,10000,10000,300);
  assert.equal(restarted.remainingMs,10000);
});

test('pause is precise and native state is not modified', () => {
  const c=syncProgressClock(null,5432,10000,500);
  assert.equal(c.remainingMs,5432);
  assert.equal(remainingAt(c,600),5332);
  assert.equal(progressRatio(5432,10000),0.5432);
});

test('stale frames, invalid ratios and midnight-like long timers are bounded', () => {
  const c=syncProgressClock(null,1000,1000,10);
  assert.equal(remainingAt(c,9),1000);
  assert.equal(remainingAt(c,1011),0);
  assert.equal(progressRatio(Number.NaN,10000),0);
  assert.equal(progressRatio(3600000-1,3600000),3599999/3600000);
});
