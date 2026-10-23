'use strict';

/**
 * Hard request budget.
 *
 * Gateway proxies in front of an app (preview hosts, load balancers) give up on
 * a request long before an upstream API does. If YouTube hangs on a connect,
 * the browser sees the proxy's own 502 page — not our JSON — which is exactly
 * the failure that produces an unexplainable "HTTP 502" in the UI.
 *
 * So every request runs under a deadline shorter than a typical proxy timeout,
 * and we answer with JSON ourselves.
 */

class BudgetExceeded extends Error {
  constructor(message, ms) {
    super(message || `Request exceeded its ${ms}ms budget.`);
    this.name = 'BudgetExceeded';
    this.code = 'TIMEOUT';
    this.budgetMs = ms;
  }
}

/**
 * Resolve with the task's value, or reject with BudgetExceeded once `ms` passes.
 * The task keeps running in the background; we simply stop waiting for it.
 */
function withBudget(task, ms) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new BudgetExceeded(undefined, ms));
    }, Math.max(1, ms));
    if (typeof timer.unref === 'function') timer.unref();

    Promise.resolve()
      .then(task)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      );
  });
}

module.exports = { withBudget, BudgetExceeded };
