import assert from 'node:assert/strict';
import { test } from 'node:test';
import { geomean, percentile, score, summarize } from './score.mjs';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('geomean', () => {
  close(geomean([2, 8]), 4);
  close(geomean([1, 1, 1]), 1);
  close(geomean([5]), 5);
  assert.equal(geomean([]), null);
  assert.equal(geomean([2, null]), null);
  assert.equal(geomean([2, undefined]), null);
  assert.equal(geomean([2, 0]), null); // a zero is unknown here, not a perfect score
  assert.equal(geomean([2, -1]), null);
  assert.equal(geomean([2, Number.NaN]), null);
  assert.equal(geomean([2, Number.POSITIVE_INFINITY]), null);
  assert.equal(geomean(null), null);
});

test('percentile interpolates', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.9), 7);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  close(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9.1);
});

test('summarize: p95 only from 40 samples, cv and unstable flag', () => {
  const s39 = summarize(Array.from({ length: 39 }, (_, i) => i + 1));
  assert.equal(s39.n, 39);
  assert.equal(s39.p95, null);
  const s40 = summarize(Array.from({ length: 40 }, (_, i) => i + 1));
  assert.notEqual(s40.p95, null);
  close(s40.p95, 38.05);
  assert.equal(summarize([]).p50, null);
  assert.equal(summarize([5]).cv, null);
  assert.equal(summarize([10, 10, 10]).unstable, false);
  assert.equal(summarize([10, 10, 10]).cv, 0);
  assert.equal(summarize([10, 14]).unstable, true); // cv ~ 0.28
  assert.equal(summarize([100, 101, 99, 100]).unstable, false);
  // non-numbers are ignored, not counted as 0
  assert.equal(summarize([10, null, undefined, 'x', Number.NaN]).n, 1);
});

// ---- scoring fixtures

const W = ['w1', 'w2'];
function rows(route, workload, { n = 20, work = 100, cost = null, fail = 0, days = 3 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = 1 + (i % days);
    const hour = [1, 7, 13, 19][i % 4];
    out.push({
      suite: 's1',
      route,
      workload,
      rep: 1 + (i % 10),
      conclusion: i < fail ? 'failure' : 'success',
      jobCreatedAt: `2026-02-0${d}T${String(hour).padStart(2, '0')}:00:00.000Z`,
      jobStartedAt: `2026-02-0${d}T${String(hour).padStart(2, '0')}:00:05.000Z`,
      setupSeconds: 30,
      workSeconds: i < fail ? null : work,
      costUsd: i < fail ? null : cost,
    });
  }
  return out;
}
const opts = (extra = {}) => ({
  suite: 's1',
  workloads: W,
  routes: [
    { id: 'base4', vcpu: 4 },
    { id: 'fast4', vcpu: 4 },
    { id: 'base2', vcpu: 2 },
  ],
  timeBaselines: { 4: 'base4' },
  costBaseline: 'base2',
  ...extra,
});
const find = (res, id) => res.routes.find((r) => r.route === id);

test('speed, value and score follow the formulas', () => {
  const data = [
    ...rows('base4', 'w1', { work: 100, cost: 0.1 }),
    ...rows('base4', 'w2', { work: 400, cost: 0.4 }),
    ...rows('base2', 'w1', { work: 200, cost: 0.1 }),
    ...rows('base2', 'w2', { work: 800, cost: 0.4 }),
    // twice as fast as base4 on both, half the cost of base2 on both
    ...rows('fast4', 'w1', { work: 50, cost: 0.05 }),
    ...rows('fast4', 'w2', { work: 200, cost: 0.2 }),
  ];
  const res = score(data, opts());
  const fast = find(res, 'fast4');
  close(fast.speed, 200);
  close(fast.value, 200);
  close(fast.score, 200);
  const base = find(res, 'base4');
  close(base.speed, 100); // the time baseline is 100 by definition
  // the stated example: twice as fast at the same rate scores 200; half the rate at the same speed scores 141
  const same = score(
    [
      ...rows('base4', 'w1', { work: 100, cost: 0.1 }),
      ...rows('base4', 'w2', { work: 100, cost: 0.1 }),
      ...rows('base2', 'w1', { work: 100, cost: 0.1 }),
      ...rows('base2', 'w2', { work: 100, cost: 0.1 }),
      ...rows('fast4', 'w1', { work: 100, cost: 0.05 }),
      ...rows('fast4', 'w2', { work: 100, cost: 0.05 }),
    ],
    opts(),
  );
  close(find(same, 'fast4').speed, 100);
  close(find(same, 'fast4').value, 200);
  close(find(same, 'fast4').score, Math.sqrt(100 * 200)); // 141.42
});

test('geomean across workloads: one long build does not dominate', () => {
  const data = [
    ...rows('base4', 'w1', { work: 100, cost: 1 }),
    ...rows('base4', 'w2', { work: 1000, cost: 1 }),
    ...rows('base2', 'w1', { work: 100, cost: 1 }),
    ...rows('base2', 'w2', { work: 1000, cost: 1 }),
    ...rows('fast4', 'w1', { work: 50, cost: 1 }), // ratio 0.5
    ...rows('fast4', 'w2', { work: 2000, cost: 1 }), // ratio 2
  ];
  close(find(score(data, opts()), 'fast4').speed, 100); // geomean(0.5, 2) = 1
});

test('a null cost makes Value and Score null but keeps Speed', () => {
  const data = [
    ...rows('base4', 'w1', { work: 100 }),
    ...rows('base4', 'w2', { work: 100 }),
    ...rows('fast4', 'w1', { work: 50 }),
    ...rows('fast4', 'w2', { work: 50 }),
    ...rows('base2', 'w1', { work: 100 }),
    ...rows('base2', 'w2', { work: 100 }),
  ];
  const fast = find(score(data, opts()), 'fast4');
  close(fast.speed, 200);
  assert.equal(fast.value, null);
  assert.equal(fast.score, null);
  assert.equal(fast.ranked, false);
  assert.ok(fast.reasons.some((r) => r.includes('cost missing')));
});

test('a cost missing for one workload makes Value null (never counted as free)', () => {
  const data = [
    ...rows('base4', 'w1', { work: 100, cost: 1 }),
    ...rows('base4', 'w2', { work: 100, cost: 1 }),
    ...rows('base2', 'w1', { work: 100, cost: 1 }),
    ...rows('base2', 'w2', { work: 100, cost: 1 }),
    ...rows('fast4', 'w1', { work: 100, cost: 0.5 }),
    ...rows('fast4', 'w2', { work: 100 }),
  ];
  assert.equal(find(score(data, opts()), 'fast4').value, null);
});

test('a zero price gives no Value rather than infinity', () => {
  const data = [
    ...rows('base4', 'w1', { work: 100, cost: 0 }),
    ...rows('base4', 'w2', { work: 100, cost: 0 }),
    ...rows('base2', 'w1', { work: 100, cost: 1 }),
    ...rows('base2', 'w2', { work: 100, cost: 1 }),
  ];
  const base = find(score(data, opts()), 'base4');
  assert.equal(base.value, null);
  assert.equal(base.score, null);
});

test('a missing workload gives no Speed and no rank', () => {
  const data = [...rows('base4', 'w1', { work: 100, cost: 1 }), ...rows('base4', 'w2', { work: 100, cost: 1 }), ...rows('fast4', 'w1', { work: 50, cost: 1 })];
  const fast = find(score(data, opts()), 'fast4');
  assert.equal(fast.speed, null);
  assert.equal(fast.ranked, false);
  assert.ok(fast.reasons.some((r) => r.startsWith('w2: no successful result')));
});

test('no baseline for the size means no Speed', () => {
  const data = [...rows('base2', 'w1', { work: 100, cost: 1 }), ...rows('base2', 'w2', { work: 100, cost: 1 })];
  assert.equal(find(score(data, opts()), 'base2').speed, null);
});

function fullSet(overrides = {}) {
  return [
    ...rows('base4', 'w1', { work: 100, cost: 0.2, ...overrides.base4 }),
    ...rows('base4', 'w2', { work: 100, cost: 0.2, ...overrides.base4 }),
    ...rows('base2', 'w1', { work: 100, cost: 0.2 }),
    ...rows('base2', 'w2', { work: 100, cost: 0.2 }),
    ...rows('fast4', 'w1', { work: 50, cost: 0.1, ...overrides.fast4 }),
    ...rows('fast4', 'w2', { work: 50, cost: 0.1, ...overrides.fast4 }),
  ];
}

test('ranking: a route that meets every rule is ranked, best Score first', () => {
  const res = score(fullSet(), opts());
  assert.equal(find(res, 'fast4').ranked, true);
  assert.equal(find(res, 'fast4').rank, 1);
  assert.equal(find(res, 'base4').rank, 2);
  assert.deepEqual(find(res, 'fast4').reasons, []);
});

test('ranking: fewer than 20 attempts is unranked with the reason', () => {
  const res = score(fullSet({ fast4: { n: 19 } }), opts());
  const fast = find(res, 'fast4');
  assert.equal(fast.ranked, false);
  assert.equal(fast.rank, null);
  assert.ok(fast.reasons.includes('w1: 19 attempts, need 20'));
});

test('ranking: failed attempts count as attempts, one failure in 20 is allowed, two are not', () => {
  const one = find(score(fullSet({ fast4: { fail: 1 } }), opts()), 'fast4');
  // 1 failure per workload = 2 of 40 = 95.0%
  close(one.reliabilityPercent, 95);
  assert.equal(one.ranked, true);
  const two = find(score(fullSet({ fast4: { fail: 2 } }), opts()), 'fast4');
  assert.equal(two.ranked, false);
  assert.ok(two.reasons.some((r) => r.startsWith('reliability')));
});

test('ranking: attempts need at least 3 days and different times of day', () => {
  const twoDays = find(score(fullSet({ fast4: { days: 2 } }), opts()), 'fast4');
  assert.equal(twoDays.ranked, false);
  assert.ok(twoDays.reasons.includes('w1: 2 days, need 3'));

  const sameHour = fullSet().map((r) =>
    r.route === 'fast4' ? { ...r, jobStartedAt: r.jobStartedAt.replace(/T\d\d/, 'T10'), jobCreatedAt: r.jobCreatedAt.replace(/T\d\d/, 'T10') } : r,
  );
  const fast = find(score(sameHour, opts()), 'fast4');
  assert.equal(fast.ranked, false);
  assert.ok(fast.reasons.includes('w1: 1 times of day, need 2'));
});

test('ranking: a workload that fails on every route is not held against a route', () => {
  const data = [
    ...rows('base4', 'w1', { work: 100, cost: 0.2 }),
    ...rows('base2', 'w1', { work: 100, cost: 0.2 }),
    ...rows('fast4', 'w1', { work: 50, cost: 0.1 }),
    ...rows('base4', 'w2', { fail: 20 }),
    ...rows('base2', 'w2', { fail: 20 }),
    ...rows('fast4', 'w2', { fail: 20 }),
  ];
  const fast = find(score(data, opts()), 'fast4');
  assert.equal(fast.reliabilityPercent, 100);
  // still unranked: it has no result for w2, and the reason says so
  assert.equal(fast.ranked, false);
  assert.ok(fast.reasons.includes('w2: no successful result'));
});

test('ranking: a workload that fails only on this route is held against it', () => {
  const data = fullSet().filter((r) => !(r.route === 'fast4' && r.workload === 'w2'));
  data.push(...rows('fast4', 'w2', { fail: 20 }));
  const fast = find(score(data, opts()), 'fast4');
  close(fast.reliabilityPercent, 50);
  assert.equal(fast.ranked, false);
});

test('ranking: equal scores share a rank', () => {
  const same = score(
    [
      ...rows('base4', 'w1', { work: 100, cost: 0.2 }),
      ...rows('base4', 'w2', { work: 100, cost: 0.2 }),
      ...rows('base2', 'w1', { work: 100, cost: 0.2 }),
      ...rows('base2', 'w2', { work: 100, cost: 0.2 }),
      ...rows('fast4', 'w1', { work: 100, cost: 0.2 }),
      ...rows('fast4', 'w2', { work: 100, cost: 0.2 }),
    ],
    opts(),
  );
  assert.equal(find(same, 'base4').rank, 1);
  assert.equal(find(same, 'fast4').rank, 1);
});

test('unstable flag marks cells with a coefficient of variation above 15%', () => {
  const noisy = rows('fast4', 'w1', { work: 100, cost: 0.1 }).map((r, i) => ({ ...r, workSeconds: i % 2 === 0 ? 60 : 140 }));
  const data = [...fullSet().filter((r) => !(r.route === 'fast4' && r.workload === 'w1')), ...noisy];
  const fast = find(score(data, opts()), 'fast4');
  assert.deepEqual(fast.unstableCells, ['w1']);
  assert.equal(fast.cells.w1.work.unstable, true);
  assert.equal(fast.cells.w2.work.unstable, false);
});

test('p95 is reported only from 40 samples', () => {
  const few = find(score(fullSet({ fast4: { n: 39 } }), opts()), 'fast4');
  assert.equal(few.cells.w1.work.p95, null);
  const many = find(score(fullSet({ fast4: { n: 40 } }), opts()), 'fast4');
  assert.notEqual(many.cells.w1.work.p95, null);
});

test('rows from another suite version are ignored', () => {
  const data = [...fullSet(), ...rows('fast4', 'w1', { work: 1, cost: 0.1 }).map((r) => ({ ...r, suite: 's0' }))];
  assert.equal(find(score(data, opts()), 'fast4').cells.w1.work.p50, 50);
});

test('cancelled and skipped jobs are not attempts', () => {
  const data = fullSet().map((r, i) => (r.route === 'fast4' && r.workload === 'w1' && i % 7 === 0 ? { ...r, conclusion: 'cancelled', workSeconds: null } : r));
  const cell = find(score(data, opts()), 'fast4').cells.w1;
  assert.ok(cell.attempts < 20);
  assert.equal(cell.attempts, cell.finished);
});

// ---- byCpu

const withCpu = (rs, models) =>
  rs.map((r, i) => {
    const m = models[i % models.length];
    return m === undefined ? r : { ...r, fingerprint: { cpuModel: m } };
  });
const cellOf = (data, route = 'base4', workload = 'w1') => find(score(data, opts()), route).cells[workload];

test('byCpu: mixed models are grouped, each with its own stats', () => {
  const fast = rows('base4', 'w1', { n: 10, work: 100 });
  const slow = rows('base4', 'w1', { n: 10, work: 200 });
  const data = [
    ...fast.map((r) => ({ ...r, fingerprint: { cpuModel: 'EPYC 9R14' } })),
    ...slow.map((r) => ({ ...r, fingerprint: { cpuModel: 'Xeon 8370C' } })),
  ];
  const cell = cellOf(data);
  assert.deepEqual(
    cell.byCpu.map((g) => [g.cpuModel, g.n, g.p50, g.p90, g.mean, g.cv]),
    [
      ['EPYC 9R14', 10, 100, 100, 100, 0],
      ['Xeon 8370C', 10, 200, 200, 200, 0],
    ],
  );
  // the overall figures still cover both models: the spread there is partly hardware mix
  assert.equal(cell.work.n, 20);
  close(cell.work.mean, 150);
  assert.ok(cell.work.cv > 0.3);
});

test('byCpu: a missing model is grouped as null, not dropped and not 0', () => {
  const base = rows('base4', 'w1', { n: 6, work: 100 });
  const data = [
    { ...base[0], fingerprint: { cpuModel: 'EPYC 9R14' } },
    { ...base[1], fingerprint: { cpuModel: 'EPYC 9R14' } },
    { ...base[2], fingerprint: null },
    { ...base[3], fingerprint: { cpuModel: null } },
    { ...base[4], fingerprint: { cpuModel: '  ' } },
    base[5], // 0.1.0 style: no fingerprint field at all
  ];
  const cell = cellOf(data);
  assert.equal(cell.byCpu.length, 2);
  assert.deepEqual(cell.byCpu.map((g) => g.cpuModel), ['EPYC 9R14', null]); // unknown sorts last
  assert.equal(cell.byCpu[0].n, 2);
  assert.equal(cell.byCpu[1].n, 4);
  assert.equal(cell.byCpu[1].p50, 100);
  assert.equal(cell.byCpu.reduce((a, g) => a + g.n, 0), cell.work.n);
});

test('byCpu: one model gives one group equal to the overall figures', () => {
  const data = withCpu(rows('base4', 'w1', { n: 8, work: 100 }), ['EPYC 9R14']).map((r, i) => ({ ...r, workSeconds: 100 + i }));
  const cell = cellOf(data);
  assert.equal(cell.byCpu.length, 1);
  const [g] = cell.byCpu;
  assert.equal(g.cpuModel, 'EPYC 9R14');
  assert.equal(g.n, cell.work.n);
  assert.equal(g.p50, cell.work.p50);
  assert.equal(g.p90, cell.work.p90);
  assert.equal(g.mean, cell.work.mean);
  assert.equal(g.cv, cell.work.cv);
});

test('byCpu: only finished attempts count, a cell with none gets an empty list', () => {
  const data = rows('base4', 'w1', { n: 5, fail: 5 }).map((r) => ({ ...r, fingerprint: { cpuModel: 'EPYC 9R14' } }));
  assert.deepEqual(cellOf(data).byCpu, []);
  assert.deepEqual(cellOf([], 'base4', 'w2').byCpu, []);
});

test('byCpu does not change Speed, Value, Score or the ranking', () => {
  const build = (decorate) => [
    ...rows('base4', 'w1', { work: 100, cost: 0.1 }),
    ...rows('base4', 'w2', { work: 400, cost: 0.4 }),
    ...rows('base2', 'w1', { work: 200, cost: 0.1 }),
    ...rows('base2', 'w2', { work: 800, cost: 0.4 }),
    ...rows('fast4', 'w1', { work: 50, cost: 0.05 }),
    ...rows('fast4', 'w2', { work: 200, cost: 0.2 }),
  ].map(decorate);
  const strip = (res) => JSON.parse(JSON.stringify(res, (k, v) => (k === 'byCpu' ? undefined : v)));
  const plain = score(build((r) => r), opts());
  const tagged = score(build((r, i) => ({ ...r, fingerprint: { cpuModel: i % 3 ? 'A' : 'B' } })), opts());
  assert.deepEqual(strip(tagged), strip(plain));
});

test('the CLI scores an earlier suite with that suite\'s own workloads', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'score-'));
  try {
    mkdirSync(join(dir, '0.1.0'));
    const row = { suite: '0.1.0', route: 'github-hosted-4vcpu', workload: 'rust-ripgrep', rep: 1, conclusion: 'success', workSeconds: 20, setupSeconds: 5, jobStartedAt: '2026-02-01T01:00:00.000Z' };
    writeFileSync(join(dir, '0.1.0', 'a.jsonl'), `${JSON.stringify(row)}\n`);
    const script = new URL('./score.mjs', import.meta.url).pathname;
    const out = JSON.parse(execFileSync(process.execPath, [script, '--results', dir, '--suite', '0.1.0'], { encoding: 'utf8' }));
    assert.deepEqual(out.workloads, ['rust-ripgrep', 'node-typescript']);
    const cell = out.routes.find((r) => r.route === 'github-hosted-4vcpu').cells['rust-ripgrep'];
    assert.equal(cell.work.n, 1);
    assert.deepEqual(cell.byCpu, [{ cpuModel: null, n: 1, p50: 20, p90: 20, mean: 20, cv: null }]);
    assert.throws(() => execFileSync(process.execPath, [script, '--results', dir, '--suite', '9.9.9'], { stdio: 'pipe' }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
