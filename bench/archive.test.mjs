import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { LOG_RETRIES, MAX_LOG_BYTES, archiveRun, checkRun, fetchLog, looksSecret, readArchiveRoutes } from './archive.mjs';

const API = 'https://api.github.com';
const ctx = { apiUrl: API, token: 'tok-SECRET', repo: 'o/r', runId: 7, attempt: 2 };
const noSleep = async () => {};

const goodRun = (extra = {}) => ({
  id: 7,
  path: '.github/workflows/benchmark.yml',
  head_repository: { full_name: 'o/r' },
  head_branch: 'main',
  head_sha: 'a'.repeat(40),
  event: 'workflow_dispatch',
  ...extra,
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const job = (id, name, extra = {}) => ({
  id,
  name,
  status: 'completed',
  conclusion: 'success',
  head_sha: 'a'.repeat(40),
  runner_name: 'GitHub Actions 7',
  labels: ['ubuntu-24.04'],
  steps: [{ name: 'work', number: 3, status: 'completed' }],
  ...extra,
});

/** A fake GitHub: run, jobs and logs. `logs` maps job id to a function returning a Response. */
function fakeGithub({ run = goodRun(), jobs = [], logs = {} }) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, init });
    const u = new URL(url);
    if (u.pathname === '/repos/o/r/actions/runs/7') return json(run);
    if (u.pathname === '/repos/o/r/actions/runs/7/attempts/2/jobs') return json({ total_count: jobs.length, jobs });
    const m = /^\/repos\/o\/r\/actions\/jobs\/(\d+)\/logs$/.exec(u.pathname);
    if (m && logs[m[1]]) return logs[m[1]](calls.filter((c) => c.url === url).length);
    return new Response('nope', { status: 404 });
  };
  return { fetchFn, calls };
}

const text = (s) => () => new Response(s, { status: 200 });
const tmp = () => mkdtempSync(join(tmpdir(), 'archive-'));
const rawDir = (out) => join(out, 'raw', '7-2');
const manifestOf = (out) => JSON.parse(readFileSync(join(rawDir(out), 'manifest.json'), 'utf8'));
const run = (gh, out, routes = ['github-hosted-4vcpu']) =>
  archiveRun({ ctx, archiveRoutes: new Set(routes), outDir: out, fetchFn: gh.fetchFn, sleep: noSleep });

test('jobs.json keeps the complete response, every job and every field', async () => {
  const jobs = [job(11, 'plan'), job(12, 'run github-hosted-4vcpu rust-analyzer 1', { extra_field: { nested: [1, 2] } }), job(13, 'collect', { status: 'in_progress' })];
  const out = tmp();
  await run(fakeGithub({ jobs, logs: { 12: text('log') } }), out);
  const saved = JSON.parse(readFileSync(join(rawDir(out), 'jobs.json'), 'utf8'));
  assert.deepEqual(saved, { total_count: 3, jobs });
});

test('a log of an enabled route is archived as deterministic gzip', async () => {
  const jobs = [job(12, 'run github-hosted-4vcpu rust-analyzer 1')];
  const out1 = tmp();
  const out2 = tmp();
  await run(fakeGithub({ jobs, logs: { 12: text('hello log\n') } }), out1);
  await run(fakeGithub({ jobs, logs: { 12: text('hello log\n') } }), out2);
  const gz1 = readFileSync(join(rawDir(out1), 'logs', '12.log.gz'));
  assert.equal(gunzipSync(gz1).toString(), 'hello log\n');
  assert.deepEqual(gz1, readFileSync(join(rawDir(out2), 'logs', '12.log.gz')));
  const m = manifestOf(out1);
  assert.equal(m.headSha, 'a'.repeat(40));
  assert.deepEqual(m.jobs.map(({ jobId, archived, bytes }) => ({ jobId, archived, bytes })), [{ jobId: 12, archived: true, bytes: 10 }]);
  assert.match(m.jobs[0].sha256, /^[0-9a-f]{64}$/);
});

test('manifest reason: route-not-enabled, and no log is fetched', async () => {
  const jobs = [job(12, 'run github-hosted-4vcpu rust-analyzer 1'), job(13, 'run other-route rust-analyzer 1'), job(14, 'run bad name')];
  const out = tmp();
  const gh = fakeGithub({ jobs, logs: { 12: text('x'), 13: text('x'), 14: text('x') } });
  await run(gh, out, []); // nothing opted in
  assert.deepEqual(manifestOf(out).jobs.map((j) => [j.jobId, j.archived, j.reason]), [
    [14, false, 'route-not-enabled'],
    [12, false, 'route-not-enabled'],
    [13, false, 'route-not-enabled'],
  ]);
  assert.equal(gh.calls.filter((c) => c.url.includes('/logs')).length, 0);
  assert.deepEqual(readdirSync(join(rawDir(out), 'logs')), []);
});

test('manifest reason: missing for an unfinished job and for a log that never appears', async () => {
  const jobs = [
    job(12, 'run github-hosted-4vcpu rust-analyzer 1'),
    job(13, 'run github-hosted-4vcpu rust-analyzer 2', { status: 'in_progress' }),
    job(14, 'run github-hosted-4vcpu rust-analyzer 3'),
  ];
  const out = tmp();
  const gh = fakeGithub({ jobs, logs: { 12: () => new Response('', { status: 404 }), 14: () => new Response('', { status: 410 }) } });
  await run(gh, out);
  assert.deepEqual(manifestOf(out).jobs.map((j) => [j.jobId, j.reason]), [[12, 'missing'], [13, 'missing'], [14, 'missing']]);
  assert.equal(gh.calls.filter((c) => c.url.endsWith('/jobs/12/logs')).length, 1 + LOG_RETRIES, '404 is retried a bounded number of times');
  assert.equal(gh.calls.filter((c) => c.url.endsWith('/jobs/14/logs')).length, 1, '410 is not retried');
});

test('manifest reason: too-large over 50 MB', async () => {
  const jobs = [job(12, 'run github-hosted-4vcpu rust-analyzer 1'), job(13, 'run github-hosted-4vcpu rust-analyzer 2')];
  const out = tmp();
  const big = Buffer.alloc(MAX_LOG_BYTES + 1, 0x61);
  const limit = Buffer.alloc(MAX_LOG_BYTES, 0x61);
  const gh = fakeGithub({ jobs, logs: { 12: () => new Response(big), 13: () => new Response(limit) } });
  await run(gh, out);
  const m = manifestOf(out).jobs;
  assert.deepEqual([m[0].archived, m[0].reason], [false, 'too-large']);
  assert.equal(m[1].archived, true);
  assert.ok(!existsSync(join(rawDir(out), 'logs', '12.log.gz')));
});

test('manifest reason: secret-shaped, stored nowhere and never printed', async () => {
  const bodies = [
    `fine\ntoken ghp_${'A1b2'.repeat(6)} oops\n`,
    'x github_pat_11ABC\n',
    'Authorization: Basic eDp0b2tlbg==\n',
    `a ghs_${'z'.repeat(20)}`,
  ];
  const jobs = bodies.map((_, i) => job(20 + i, `run github-hosted-4vcpu rust-analyzer ${i + 1}`));
  const logs = Object.fromEntries(bodies.map((b, i) => [20 + i, text(b)]));
  const out = tmp();
  const warnings = [];
  await archiveRun({ ctx, archiveRoutes: new Set(['github-hosted-4vcpu']), outDir: out, fetchFn: fakeGithub({ jobs, logs }).fetchFn, sleep: noSleep, warn: (m) => warnings.push(m) });
  const m = manifestOf(out).jobs;
  assert.deepEqual(m.map((j) => j.reason), ['secret-shaped', 'secret-shaped', 'secret-shaped', 'secret-shaped']);
  assert.deepEqual(readdirSync(join(rawDir(out), 'logs')), []);
  const printed = warnings.join('\n') + JSON.stringify(m);
  assert.ok(!/ghp_|github_pat_|eDp0|ghs_/i.test(printed));
});

test('looksSecret does not flag ordinary text', () => {
  assert.equal(looksSecret('Compiling rust-analyzer v0.0.0\nghp_short\n'), false);
  assert.equal(looksSecret('ghp_ABCDEFGHIJKLMNOPQRSTUVWX'), true);
});

test('a 404 then success is archived', async () => {
  const jobs = [job(12, 'run github-hosted-4vcpu rust-analyzer 1')];
  const out = tmp();
  const sleeps = [];
  const gh = fakeGithub({ jobs, logs: { 12: (n) => (n < 3 ? new Response('', { status: 404 }) : new Response('late log')) } });
  await archiveRun({ ctx, archiveRoutes: new Set(['github-hosted-4vcpu']), outDir: out, fetchFn: gh.fetchFn, sleep: async (ms) => sleeps.push(ms) });
  assert.equal(manifestOf(out).jobs[0].archived, true);
  assert.equal(gunzipSync(readFileSync(join(rawDir(out), 'logs', '12.log.gz'))).toString(), 'late log');
  assert.equal(sleeps.length, 2);
});

test('the token is not forwarded across the log redirect', async () => {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, init });
    if (url.startsWith(API)) return new Response(null, { status: 302, headers: { location: 'https://blob.example.net/logs/abc?sig=1' } });
    return new Response('from storage');
  };
  const res = await fetchLog({ ...ctx, jobId: 12 }, fetchFn, noSleep);
  assert.equal(res.buf.toString(), 'from storage');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].init.headers.Authorization, 'Bearer tok-SECRET');
  assert.equal(seen[0].init.redirect, 'manual');
  assert.equal(seen[1].url, 'https://blob.example.net/logs/abc?sig=1');
  assert.equal(JSON.stringify(seen[1].init).includes('tok-SECRET'), false);
  assert.equal(Object.keys(seen[1].init.headers).some((h) => h.toLowerCase() === 'authorization'), false);
});

test('a redirect to a non-https URL is refused', async () => {
  const fetchFn = async () => new Response(null, { status: 302, headers: { location: 'http://blob.example.net/x' } });
  assert.deepEqual(await fetchLog({ ...ctx, jobId: 12 }, fetchFn, noSleep), { reason: 'missing' });
});

test('a job id that is not a positive integer never reaches a URL', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return new Response('x');
  };
  for (const jobId of ['12/../../x', '12?a=b', 1.5, -1, 0, null, undefined, Number.NaN, 2 ** 60, '12']) {
    assert.deepEqual(await fetchLog({ ...ctx, jobId }, fetchFn, noSleep), { reason: 'missing' });
  }
  assert.equal(calls.length, 0);

  const out = tmp();
  const jobs = [job('12/../../x', 'run github-hosted-4vcpu rust-analyzer 1'), job(null, 'run github-hosted-4vcpu rust-analyzer 2')];
  const gh = fakeGithub({ jobs });
  await run(gh, out);
  assert.deepEqual(manifestOf(out).jobs.map((j) => [j.jobId, j.reason]), [[null, 'missing'], [null, 'missing']]);
  assert.equal(gh.calls.filter((c) => c.url.includes('/logs')).length, 0);
  assert.deepEqual(readdirSync(join(rawDir(out), 'logs')), []);
});

test('the run check refuses each bad condition and writes nothing', async () => {
  const bad = {
    'another workflow': { path: '.github/workflows/other.yml' },
    'a path with a ref': { path: '.github/workflows/benchmark.yml@refs/heads/x' },
    'a fork': { head_repository: { full_name: 'evil/r' } },
    'no head repository': { head_repository: null },
    'another branch': { head_branch: 'feature' },
    'a pull request': { event: 'pull_request' },
    'pull_request_target': { event: 'pull_request_target' },
    'a push': { event: 'push' },
    'another run id': { id: 8 },
  };
  for (const [what, extra] of Object.entries(bad)) {
    const out = tmp();
    const gh = fakeGithub({ run: goodRun(extra), jobs: [job(12, 'run github-hosted-4vcpu rust-analyzer 1')], logs: { 12: text('x') } });
    await assert.rejects(run(gh, out), /refusing to archive/, what);
    assert.ok(!existsSync(join(out, 'raw')), `${what}: nothing written`);
    assert.equal(gh.calls.length, 1, `${what}: nothing else was fetched`);
  }
});

test('the run check accepts a schedule and refuses when the call fails', async () => {
  const ok = await checkRun(ctx, fakeGithub({ run: goodRun({ event: 'schedule' }) }).fetchFn);
  assert.equal(ok.headSha, 'a'.repeat(40));
  for (const status of [403, 404, 500]) {
    const out = tmp();
    await assert.rejects(archiveRun({ ctx, archiveRoutes: new Set(['github-hosted-4vcpu']), outDir: out, fetchFn: async () => new Response('', { status }), sleep: noSleep }), (err) => /refusing to archive/.test(err.message) && !err.message.includes('tok-SECRET'));
    assert.ok(!existsSync(join(out, 'raw')));
  }
  await assert.rejects(archiveRun({ ctx, archiveRoutes: new Set(), outDir: tmp(), fetchFn: async () => { throw new Error('network'); }, sleep: noSleep }), /network/);
});

test('a route without archiveLogs: true gets no log (fail closed)', async () => {
  const dir = tmp();
  const { writeFileSync } = await import('node:fs');
  const path = join(dir, 'routes.json');
  writeFileSync(
    path,
    JSON.stringify({
      routes: [
        { id: 'a', archiveLogs: true },
        { id: 'b' },
        { id: 'c', archiveLogs: false },
        { id: 'd', archiveLogs: 'true' },
        { id: 'e', archiveLogs: 1 },
      ],
    }),
  );
  assert.deepEqual([...readArchiveRoutes(path)], ['a']);
  // And the shipped file: only the GitHub-hosted baseline opts in.
  assert.deepEqual([...readArchiveRoutes(new URL('../routes.json', import.meta.url).pathname)], ['github-hosted-4vcpu']);
});

test('a masked auth header, as actions/checkout logs in every job, is not a secret', () => {
  assert.equal(looksSecret('git config --local http.https://github.com/.extraheader AUTHORIZATION: basic ***\n'), false);
  assert.equal(looksSecret('http.https://github.com/.extraheader AUTHORIZATION: basic eDp0b2tlbg==\n'), true);
});
