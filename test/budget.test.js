'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withBudget, BudgetExceeded } = require('../src/budget');

test('returns the task value when it finishes in time', async () => {
  const value = await withBudget(() => Promise.resolve(42), 500);
  assert.equal(value, 42);
});

test('supports a synchronous task', async () => {
  assert.equal(await withBudget(() => 'sync', 500), 'sync');
});

test('rejects with BudgetExceeded when the task takes too long', async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 800));
  const startedAt = Date.now();

  await assert.rejects(
    () => withBudget(() => slow, 60),
    (err) => {
      assert.ok(err instanceof BudgetExceeded);
      assert.equal(err.code, 'TIMEOUT');
      assert.equal(err.budgetMs, 60);
      return true;
    }
  );

  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 50 && elapsed < 600, `gave up after ${elapsed}ms`);
});

test('propagates the task error and stops the timer', async () => {
  await assert.rejects(
    () => withBudget(() => Promise.reject(new Error('boom')), 500),
    /boom/
  );
});

test('a late success after the deadline cannot resolve the promise', async () => {
  let resolveTask;
  const task = new Promise((resolve) => {
    resolveTask = resolve;
  });

  const pending = withBudget(() => task, 40);
  await assert.rejects(pending, (err) => err instanceof BudgetExceeded);

  // Resolving afterwards must be a no-op, not an unhandled rejection or crash.
  resolveTask('too late');
  await new Promise((r) => setTimeout(r, 20));
});
