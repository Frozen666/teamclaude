import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

// Drive an account to a "soft" exhausted state: utilization at/above the switch
// threshold with a reset still in the future (so it isn't cleared as stale).
function exhaust(account, utilization) {
  account.quota.unified7d = utilization;
  account.quota.unified7dReset = Date.now() + 3600_000;
}

test('when every account is over threshold, getActiveAccount probes instead of refusing', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  exhaust(am.accounts[0], 0.99);
  exhaust(am.accounts[1], 0.985);

  const picked = am.getActiveAccount();
  assert.ok(picked, 'expected a probe account, not null');
  // Least-utilized is the better probe target (most likely to still have headroom).
  assert.equal(picked.name, 'b');
});

test('probing is throttled to one account per probe interval', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  exhaust(am.accounts[0], 0.99);
  exhaust(am.accounts[1], 0.99);

  assert.ok(am.getActiveAccount(), 'first call probes');
  // A second request inside the interval must refuse (synthetic 429), not probe again.
  assert.equal(am.getActiveAccount(), null);

  // Once the interval elapses, a probe is allowed again.
  am._nextProbeAt = Date.now() - 1;
  assert.ok(am.getActiveAccount(), 'probe allowed after the interval');
});

test('a hard upstream rate-limit is respected — no probe, synthetic 429 stands', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  am.markRateLimited(0, 300);
  am.markRateLimited(1, 300);
  assert.equal(am.getActiveAccount(), null);
});

test('disabled accounts are never used as a probe target', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  exhaust(am.accounts[0], 0.99);
  exhaust(am.accounts[1], 0.99);
  am.accounts[0].disabled = true;
  am.accounts[1].disabled = true;
  assert.equal(am.getActiveAccount(), null);
});

test('a probe refreshing healthy quota restores normal (non-throttled) selection', () => {
  const am = new AccountManager([oauth('a')], 0.98);
  exhaust(am.accounts[0], 0.99);

  const probe = am.getActiveAccount();
  assert.ok(probe, 'probe issued');
  // Simulate the upstream response showing real headroom.
  am.updateQuota(0, { 'anthropic-ratelimit-unified-7d-utilization': '0.10' });

  // Now the account is available the normal way, with no throttle gating.
  assert.equal(am.getActiveAccount().name, 'a');
});

test('rejected unified quota status does not block routing after tracked utilization reset', () => {
  const am = new AccountManager([oauth('rejected'), oauth('healthy')], 0.98);
  am.accounts[0].quota.unifiedStatus = 'rejected';
  am.accounts[0].quota.unified5h = 0;
  am.accounts[0].quota.unified7d = 0;
  am.accounts[1].quota.unifiedStatus = 'allowed';
  am.accounts[1].quota.unified5h = 0.01;
  am.accounts[1].quota.unified7d = 0.01;

  assert.equal(am.getActiveAccount().name, 'rejected');
  assert.equal(am.accounts[0].quota.unifiedStatus, null);
  assert.deepEqual(am.eligibility(0), { eligible: true });
});

test('status snapshots clear stale rejected status after tracked utilization reset', () => {
  const am = new AccountManager([oauth('rejected')], 0.98);
  am.accounts[0].quota.unifiedStatus = 'rejected';
  am.accounts[0].quota.unified5h = 0;
  am.accounts[0].quota.unified7d = 0;

  const status = am.getStatus();
  assert.equal(status.accounts[0].quota.unifiedStatus, null);
});

test('rejected unified quota status blocks normal routing while tracked utilization is spent', () => {
  const am = new AccountManager([oauth('rejected'), oauth('healthy')], 0.98);
  am.accounts[0].quota.unifiedStatus = 'rejected';
  am.accounts[0].quota.unified5h = 0.99;
  am.accounts[0].quota.unified7d = 0;
  am.accounts[1].quota.unifiedStatus = 'allowed';
  am.accounts[1].quota.unified5h = 0.01;
  am.accounts[1].quota.unified7d = 0.01;

  assert.equal(am.getActiveAccount().name, 'healthy');
  assert.deepEqual(am.eligibility(0), { eligible: false, reason: 'quota status rejected' });
});

test('spent rejected unified quota status is still probeable so stale state can recover', () => {
  const am = new AccountManager([oauth('rejected')], 0.98);
  am.accounts[0].quota.unifiedStatus = 'rejected';
  am.accounts[0].quota.unified5h = 0.99;
  am.accounts[0].quota.unified7d = 0;

  const probe = am.getActiveAccount();
  assert.ok(probe, 'expected a revalidation probe, not a permanent local refusal');
  assert.equal(probe.name, 'rejected');
  assert.equal(am.getActiveAccount(), null, 'second request inside probe interval still refuses');

  am.updateQuota(0, {
    'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.02',
    'anthropic-ratelimit-unified-7d-utilization': '0.03',
  });
  assert.equal(am.getActiveAccount().name, 'rejected');
});
