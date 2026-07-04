import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FairScheduler } from '../src/scheduler/scheduler.js';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

test('enforces the global concurrency cap', async () => {
  const scheduler = new FairScheduler(2);
  let running = 0;
  let peak = 0;
  const job = () =>
    scheduler.schedule('u1', async () => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      running--;
    });
  await Promise.all([job(), job(), job(), job(), job()]);
  assert.equal(peak, 2);
});

test('round-robins across lanes so one user cannot starve others', async () => {
  const scheduler = new FairScheduler(1);
  const finished: string[] = [];
  const job = (lane: string, label: string) =>
    scheduler.schedule(lane, async () => {
      await tick();
      finished.push(label);
    });
  const all = [job('a', 'a1'), job('a', 'a2'), job('a', 'a3'), job('b', 'b1')];
  await Promise.all(all);
  // b의 유일한 job이 a의 대기열 전체 뒤로 밀리면 안 된다
  assert.ok(finished.indexOf('b1') < finished.indexOf('a3'));
});

test('propagates task failures to the caller only', async () => {
  const scheduler = new FairScheduler(1);
  const failing = scheduler.schedule('u1', async () => {
    throw new Error('boom');
  });
  const ok = scheduler.schedule('u1', async () => 'fine');
  await assert.rejects(failing, /boom/);
  assert.equal(await ok, 'fine');
});
