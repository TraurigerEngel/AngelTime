import test from 'node:test';
import assert from 'node:assert/strict';
import {splitNumericDisplay, calmRunningStopwatchMs, shouldPaintStopwatch, STOPWATCH_PRESENTATION_STEP_MS} from '../web/numeric-motion.js';

test('countdown digits retain exact formatting', () => {
  assert.deepEqual(splitNumericDisplay('00:00:10'), {main:'00:00:10',fraction:''});
});
test('stopwatch hundredths are separated without rounding', () => {
  assert.deepEqual(splitNumericDisplay('01:23:45.67', 2), {main:'01:23:45',fraction:'.67'});
});
test('numeric labels keep their suffixes', () => {
  assert.deepEqual(splitNumericDisplay('75%'), {main:'75%',fraction:''});
  assert.deepEqual(splitNumericDisplay('5 сек'), {main:'5 сек',fraction:''});
});
test('unexpected fraction lengths preserve the entire value', () => {
  assert.deepEqual(splitNumericDisplay('10.2', 2), {main:'10.2',fraction:''});
});


test('running stopwatch uses stable tenth-second values without changing elapsed time', () => {
  assert.equal(STOPWATCH_PRESENTATION_STEP_MS, 100);
  assert.equal(calmRunningStopwatchMs(0), 0);
  assert.equal(calmRunningStopwatchMs(99), 0);
  assert.equal(calmRunningStopwatchMs(1599), 1500);
  assert.equal(calmRunningStopwatchMs(1999), 1900);
  assert.equal(calmRunningStopwatchMs(2000), 2000);
  assert.equal(calmRunningStopwatchMs(-8), 0);
  assert.equal(calmRunningStopwatchMs(Infinity), 0);
});

test('running stopwatch paints no faster than 10 Hz', () => {
  assert.equal(shouldPaintStopwatch(0, -Infinity), true);
  assert.equal(shouldPaintStopwatch(99, 0), false);
  assert.equal(shouldPaintStopwatch(100, 0), true);
  assert.equal(shouldPaintStopwatch(180, 100), false);
  assert.equal(shouldPaintStopwatch(202, 100), true);
});

test('pausing displays the exact native hundredths, not the running visual step', () => {
  const precise = 3597;
  assert.equal(calmRunningStopwatchMs(precise), 3500);
  assert.equal(precise, 3597);
});
