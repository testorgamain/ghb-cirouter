import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  buildRows,
  fetchJobs,
  parseJobName,
  readContext,
  readFingerprintFile,
  sanitizeFingerprint,
  secondsBetween,
  stepSeconds,
  toJsonl,
} from './collect.mjs';

const ctx = (extra = {}) => ({
  suite: '0.1.0',
  repo: 'example/benchmark',
  runId: 123,
  attempt: 1,
  routeIds: new Set(['github-hosted-4vcpu']),
  workloadIds: new Set(['rust-analyzer', 'node-typescript']),
  artifactsDir: '/nonexistent',
  warn: () => {},
  ...extra,
});

const step = (name, start, end, status = 'completed') => ({ name, status, conclusion: 'success', started_at: start, completed_at: end });

const job = (extra = {}) => ({
  name: 'run github-hosted-4vcpu rust-analyzer 1',
  status: 'completed',
  conclusion: 'success',
  created_at: '2026-01-01T10:00:00Z',
  started_at: '2026-01-01T10:00:05Z',
  completed_at: '2026-01-01T10:05:00Z',
  steps: [
    step('fingerprint', '2026-01-01T10:00:06Z', '2026-01-01T10:00:07Z'),
    step('setup', '2026-01-01T10:00:07Z', '2026-01-01T10:01:07Z'),
    step('work', '2026-01-01T10:01:07Z', '2026-01-01T10:04:37Z'),
  ],
  ...extra,
});

test('parseJobName accepts the exact form', () => {
  assert.deepEqual(parseJobName('run github-hosted-4vcpu rust-analyzer 3'), { routeId: 'github-hosted-4vcpu', workload: 'rust-analyzer', rep: 3 });
  assert.deepEqual(parseJobName('run a b 10'), { routeId: 'a', workload: 'b', rep: 10 });
});

test('parseJobName rejects hostile and malformed names', () => {
  const bad = [
    '',
    'plan',
    'run  a b 1',
    'run a b 0',
    'run a b 11',
    'run a b 001',
    'run a b -1',
    'run A b 1',
    'run a b 1 ',
    ' run a b 1',
    'run a b 1\nrun c d 2',
    'run a b 1; rm -rf /',
    'run a/b c 1',
    'run ../etc passwd 1',
    'run a b $(id) 1',
    'run a b 1\u0000',
    `run ${'a'.repeat(64)} b 1`,
    `run a ${'b'.repeat(300)} 1`,
    'run a b 1.5',
    null,
    undefined,
    42,
    {},
    ['run a b 1'],
  ];
  for (const name of bad) assert.equal(parseJobName(name), null, JSON.stringify(name));
});

test('secondsBetween and stepSeconds', () => {
  assert.equal(secondsBetween('2026-01-01T00:00:00Z', '2026-01-01T00:01:30Z'), 90);
  assert.equal(secondsBetween('2026-01-01T00:01:30Z', '2026-01-01T00:00:00Z'), null);
  assert.equal(secondsBetween(null, '2026-01-01T00:00:00Z'), null);
  assert.equal(secondsBetween('yesterday', 'today'), null);
  const steps = [step('setup', '2026-01-01T00:00:00Z', '2026-01-01T00:00:10Z'), step('work', '2026-01-01T00:00:10Z', null, 'in_progress')];
  assert.equal(stepSeconds(steps, 'setup'), 10);
  assert.equal(stepSeconds(steps, 'work'), null); // unfinished
  assert.equal(stepSeconds(steps, 'missing'), null);
  assert.equal(stepSeconds(undefined, 'setup'), null);
  // two steps with the same name are ambiguous, so unknown
  assert.equal(stepSeconds([steps[0], steps[0]], 'setup'), null);
});

test('buildRows makes a row from route, workload and rep in the job name', () => {
  const rows = buildRows([job()], ctx(), () => null);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.suite, '0.1.0');
  assert.equal(r.route, 'github-hosted-4vcpu');
  assert.equal(r.workload, 'rust-analyzer');
  assert.equal(r.rep, 1);
  assert.equal(r.runId, 123);
  assert.equal(r.attempt, 1);
  assert.equal(r.runUrl, 'https://github.com/example/benchmark/actions/runs/123/attempts/1');
  assert.equal(r.conclusion, 'success');
  assert.equal(r.jobCreatedAt, '2026-01-01T10:00:00.000Z');
  assert.equal(r.setupSeconds, 60);
  assert.equal(r.workSeconds, 210);
  assert.equal(r.fingerprint, null);
  assert.equal(r.costUsd, null);
  assert.equal(r.headSha, null);
  assert.equal(r.jobId, null);
});

test('buildRows adds headSha and jobId only when well formed', () => {
  const [ok] = buildRows([job({ id: 987, head_sha: 'ab'.repeat(20) })], ctx(), () => null);
  assert.equal(ok.headSha, 'ab'.repeat(20));
  assert.equal(ok.jobId, 987);
  const [bad] = buildRows([job({ id: '987/../x', head_sha: 'not a sha' })], ctx(), () => null);
  assert.equal(bad.headSha, null);
  assert.equal(bad.jobId, null);
});

test('buildRows ignores plan and collect, and skips unknown routes, workloads and bad names', () => {
  const warnings = [];
  const jobs = [
    job({ name: 'plan' }),
    job({ name: 'collect' }),
    job({ name: 'run evil-route rust-analyzer 1' }),
    job({ name: 'run github-hosted-4vcpu ../../etc 1' }),
    job({ name: 'run github-hosted-4vcpu not-a-workload 1' }),
    job({ name: 'run github-hosted-4vcpu rust-analyzer 1\n::set-output name=x::y' }),
    job({ name: 'run github-hosted-4vcpu rust-analyzer 2', status: 'in_progress' }),
    job({ name: 'run github-hosted-4vcpu node-typescript 1' }),
    null,
    'string',
  ];
  const rows = buildRows(jobs, ctx({ warn: (m) => warnings.push(m) }), () => null);
  assert.deepEqual(rows.map((r) => `${r.route} ${r.workload} ${r.rep}`), ['github-hosted-4vcpu node-typescript 1']);
  assert.equal(warnings.length, 5);
  for (const w of warnings) assert.ok(!w.includes('\n'), 'warnings must be single-line');
});

test('buildRows keeps the first of duplicate jobs', () => {
  const rows = buildRows([job(), job({ conclusion: 'failure' })], ctx(), () => null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].conclusion, 'success');
});

test('buildRows turns unknown conclusions and bad timestamps into null', () => {
  const rows = buildRows(
    [job({ conclusion: 'weird', created_at: 'not a date', started_at: 5, completed_at: '2026-13-45T99:99:99Z' })],
    ctx(),
    () => null,
  );
  assert.equal(rows[0].conclusion, null);
  assert.equal(rows[0].jobCreatedAt, null);
  assert.equal(rows[0].jobStartedAt, null);
  assert.equal(rows[0].jobCompletedAt, null);
});

test('buildRows builds the artifact path from validated parts only', () => {
  const paths = [];
  buildRows([job()], ctx({ attempt: 2, artifactsDir: 'art' }), (p) => {
    paths.push(p);
    return null;
  });
  assert.deepEqual(paths, [join('art', 'fingerprint-2-github-hosted-4vcpu-rust-analyzer-1', 'fingerprint.json')]);
});

test('sanitizeFingerprint keeps known fields with the right types', () => {
  const fp = sanitizeFingerprint({ cpuModel: 'AMD EPYC 7763 64-Core Processor', vcpus: 4, memoryMb: 16000, diskTotalGb: 72.5, os: 'Ubuntu 24.04.3 LTS', kernel: '6.11.0-1018-azure' });
  assert.deepEqual(fp, { cpuModel: 'AMD EPYC 7763 64-Core Processor', vcpus: 4, memoryMb: 16000, diskTotalGb: 72.5, os: 'Ubuntu 24.04.3 LTS', kernel: '6.11.0-1018-azure' });
});

test('sanitizeFingerprint drops unknown keys and bad values', () => {
  const fp = sanitizeFingerprint({
    cpuModel: 'x'.repeat(129),
    vcpus: 0,
    memoryMb: '16000',
    diskTotalGb: -5,
    os: 'Ubuntu\u001b[31m',
    kernel: { a: 1 },
    extra: 'rm -rf /',
    costUsd: 0,
    route: 'other-route',
  });
  assert.deepEqual(fp, { cpuModel: null, vcpus: null, memoryMb: null, diskTotalGb: null, os: null, kernel: null });
  assert.equal('extra' in fp, false);
  assert.equal('route' in fp, false);
});

test('sanitizeFingerprint rejects non-objects and non-finite numbers', () => {
  for (const v of [null, undefined, 'x', 5, [], [{ vcpus: 4 }], true]) assert.equal(sanitizeFingerprint(v), null);
  const fp = sanitizeFingerprint({ vcpus: 1e99, memoryMb: Number.NaN, diskTotalGb: Number.POSITIVE_INFINITY });
  assert.equal(fp.vcpus, null);
  assert.equal(fp.memoryMb, null);
  assert.equal(fp.diskTotalGb, null);
});

test('sanitizeFingerprint is not fooled by prototype keys', () => {
  const raw = JSON.parse('{"__proto__": {"vcpus": 4}, "constructor": {"prototype": {"os": "x"}}}');
  const fp = sanitizeFingerprint(raw);
  assert.equal(fp.vcpus, null);
  assert.equal(fp.os, null);
  assert.equal({}.vcpus, undefined);
});

test('readFingerprintFile handles missing, oversized, invalid and symlinked files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collect-test-'));
  const good = join(dir, 'good.json');
  writeFileSync(good, JSON.stringify({ vcpus: 4, os: 'Ubuntu' }));
  assert.equal(readFingerprintFile(good).vcpus, 4);
  assert.equal(readFingerprintFile(join(dir, 'missing.json')), null);

  const big = join(dir, 'big.json');
  writeFileSync(big, JSON.stringify({ os: 'a'.repeat(10_000) }));
  assert.equal(readFingerprintFile(big), null);

  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{not json');
  assert.equal(readFingerprintFile(bad), null);

  const arr = join(dir, 'arr.json');
  writeFileSync(arr, '[1,2,3]');
  assert.equal(readFingerprintFile(arr), null);

  const link = join(dir, 'link.json');
  symlinkSync(good, link);
  assert.equal(readFingerprintFile(link), null);

  mkdirSync(join(dir, 'adir.json'));
  assert.equal(readFingerprintFile(join(dir, 'adir.json')), null);
});

test('a hostile artifact cannot change route, workload or cost', () => {
  const hostile = { route: 'x', workload: 'y', rep: 9, costUsd: 0, conclusion: 'success', os: 'Ubuntu', vcpus: 4 };
  const rows = buildRows([job({ conclusion: 'failure' })], ctx(), () => sanitizeFingerprint(hostile));
  const r = rows[0];
  assert.equal(r.route, 'github-hosted-4vcpu');
  assert.equal(r.workload, 'rust-analyzer');
  assert.equal(r.rep, 1);
  assert.equal(r.costUsd, null);
  assert.equal(r.conclusion, 'failure');
  assert.deepEqual(Object.keys(r.fingerprint).sort(), ['cpuModel', 'diskTotalGb', 'kernel', 'memoryMb', 'os', 'vcpus']);
});

test('toJsonl writes one JSON object per line', () => {
  const out = toJsonl(buildRows([job(), job({ name: 'run github-hosted-4vcpu rust-analyzer 2' })], ctx(), () => null));
  const lines = out.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).rep, 2);
  assert.ok(out.endsWith('\n'));
});

test('fetchJobs paginates until a short page', async () => {
  const pages = [Array.from({ length: 100 }, (_, i) => ({ id: i })), [{ id: 100 }, { id: 101 }]];
  const urls = [];
  const fakeFetch = async (url, init) => {
    urls.push(url);
    assert.equal(init.headers.Authorization, 'Bearer tok');
    return { ok: true, status: 200, json: async () => ({ jobs: pages[urls.length - 1] }) };
  };
  const jobs = await fetchJobs({ apiUrl: 'https://api.github.com', token: 'tok', repo: 'o/r', runId: 7, attempt: 2 }, fakeFetch);
  assert.equal(jobs.length, 102);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /\/repos\/o\/r\/actions\/runs\/7\/attempts\/2\/jobs\?per_page=100&page=1$/);
  assert.match(urls[1], /page=2$/);
});

test('fetchJobs fails on an API error without echoing the token', async () => {
  const fakeFetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(
    fetchJobs({ apiUrl: 'https://api.github.com', token: 'secret-token', repo: 'o/r', runId: 7, attempt: 1 }, fakeFetch),
    (err) => err.message === 'jobs API answered 403' && !err.message.includes('secret-token'),
  );
});

test('readContext validates the environment', () => {
  const ok = { GITHUB_REPOSITORY: 'o/r', RUN_ID: '42', RUN_ATTEMPT: '1', GITHUB_TOKEN: 't' };
  const c = readContext(ok);
  assert.equal(c.runId, 42);
  assert.equal(c.apiUrl, 'https://api.github.com');
  for (const bad of [
    { ...ok, GITHUB_REPOSITORY: 'o/r/../x' },
    { ...ok, GITHUB_REPOSITORY: 'o r' },
    { ...ok, RUN_ID: '1; echo' },
    { ...ok, RUN_ID: '../1' },
    { ...ok, RUN_ATTEMPT: '0' },
    { ...ok, GITHUB_API_URL: 'http://evil.example' },
    { ...ok, GITHUB_API_URL: 'https://evil.example/\nx' },
    { ...ok, GITHUB_TOKEN: '' },
  ]) {
    assert.throws(() => readContext(bad));
  }
});
