import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseYtDlpOutput } from '../services/job-runner';

test('reads aria2 progress with speed and ETA', () => {
  assert.deepEqual(parseYtDlpOutput('[#75fcbb 6.7MiB/29MiB(23%) CN:8 DL:5.0MiB ETA:4s]'), {
    status: 'downloading',
    stage: 'downloading',
    percent: 17.3,
    downloadedSize: '6.7 MiB',
    totalSize: '29 MiB',
    speed: '5.0 MiB/s',
    eta: '4s',
  });
});

test('reads aria2 progress without an ETA', () => {
  const progress = parseYtDlpOutput('[#0e9ed4 24MiB/24MiB(99%) CN:1 DL:0B]');
  assert.equal(progress?.percent, 74);
  assert.equal(progress.speed, '');
  assert.equal(progress.eta, '');
});
