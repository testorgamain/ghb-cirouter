// Keeps permanent copies of what GitHub deletes: the complete jobs-API response
// and, for routes that opt in, the job logs. No dependencies.
//
// Trust model: the output goes to a permanent public branch, so it is
// fail-closed. A log is stored only when its route has "archiveLogs": true in
// routes.json, it is under the size limit, and it contains nothing that looks
// like a credential. The matched text is never printed. Before anything is
// written the run itself is checked: it must be this repository's benchmark
// workflow on the default branch, started by a dispatch or a schedule, so a
// run from a fork's pull request cannot get into the archive.
//
// Usage (environment: GITHUB_TOKEN, GITHUB_REPOSITORY, RUN_ID, RUN_ATTEMPT):
//   node bench/archive.mjs --out <dir>
// Writes <out>/raw/<runId>-<attempt>/{jobs.json,manifest.json,logs/<jobId>.log.gz}
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { ID_RE, fetchJobsResponse, parseJobName, readContext } from './collect.mjs';

export const MAX_LOG_BYTES = 50 * 1024 * 1024;
export const LOG_RETRIES = 3;
export const WORKFLOW_PATH = '.github/workflows/benchmark.yml';
export const ALLOWED_EVENTS = new Set(['workflow_dispatch', 'schedule']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// Token shapes and an unmasked HTTP basic header. Checked on every log before it is
// stored. actions/checkout logs the masked form (`AUTHORIZATION: basic ***`) in every
// job, which must not match or no log would ever be kept.
const SECRET_RES = [/gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_/, /AUTHORIZATION: basic [A-Za-z0-9+/=]{8,}/i];

/** True when the text looks like it holds a credential. */
export function looksSecret(text) {
  return SECRET_RES.some((re) => re.test(text));
}

/** The ids of routes that opted in to log archiving. Anything else is closed. */
export function readArchiveRoutes(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || !Array.isArray(parsed.routes)) throw new Error('routes.json: "routes" must be an array');
  const ids = new Set();
  for (const r of parsed.routes) {
    if (r && typeof r.id === 'string' && ID_RE.test(r.id) && r.archiveLogs === true) ids.add(r.id);
  }
  return ids;
}

function apiHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ci-benchmark-archive',
  };
}

/**
 * Refuse unless the run is this repository's benchmark workflow, on the default
 * branch, started by a dispatch or a schedule. Returns { headSha }. Any failure
 * to read the run throws: no answer means no archive.
 */
export async function checkRun({ apiUrl, token, repo, runId }, fetchFn = fetch) {
  const res = await fetchFn(`${apiUrl}/repos/${repo}/actions/runs/${runId}`, { headers: apiHeaders(token) });
  if (!res.ok) throw new Error(`run API answered ${res.status}; refusing to archive`);
  const run = await res.json();
  const refuse = (what) => {
    throw new Error(`refusing to archive: ${what}`);
  };
  if (!run || typeof run !== 'object') refuse('the run could not be read');
  if (run.id !== runId) refuse('the run id does not match');
  if (run.path !== WORKFLOW_PATH) refuse('the run is not the benchmark workflow');
  const head = run.head_repository?.full_name;
  if (typeof head !== 'string' || head.toLowerCase() !== repo.toLowerCase()) refuse('the run is from another repository');
  if (run.head_branch !== 'main') refuse('the run is not on main');
  if (!ALLOWED_EVENTS.has(run.event)) refuse('the run was not started by a dispatch or a schedule');
  return { headSha: typeof run.head_sha === 'string' && /^[0-9a-f]{40}$/.test(run.head_sha) ? run.head_sha : null };
}

/** Read a response body up to `max` bytes. Null when it is larger. */
async function readCapped(res, max) {
  const declared = Number.parseInt(res.headers?.get?.('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > max) return null;
  if (!res.body?.getReader) {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > max ? null : buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch one job log. The API answers with a redirect to a storage URL; that
 * second request carries no Authorization header. A 404 is retried at most
 * LOG_RETRIES times because a log can lag the job. Resolves to
 * { buf } | { reason: 'missing' | 'too-large' }.
 */
export async function fetchLog({ apiUrl, token, repo, jobId }, fetchFn = fetch, sleep = defaultSleep) {
  if (!Number.isSafeInteger(jobId) || jobId < 1) return { reason: 'missing' };
  const url = `${apiUrl}/repos/${repo}/actions/jobs/${jobId}/logs`;
  for (let attempt = 0; attempt <= LOG_RETRIES; attempt++) {
    if (attempt > 0) await sleep(attempt * 2000);
    const first = await fetchFn(url, { headers: apiHeaders(token), redirect: 'manual' });
    let res = first;
    if (REDIRECTS.has(first.status)) {
      let target;
      try {
        target = new URL(first.headers.get('location') ?? '', url);
      } catch {
        return { reason: 'missing' };
      }
      if (target.protocol !== 'https:') return { reason: 'missing' };
      // Different origin: send no credentials.
      res = await fetchFn(target.href, { headers: { 'User-Agent': 'ci-benchmark-archive' }, redirect: 'manual' });
    }
    if (res.status === 404) continue;
    if (!res.ok) return { reason: 'missing' };
    const buf = await readCapped(res, MAX_LOG_BYTES);
    return buf === null ? { reason: 'too-large' } : { buf };
  }
  return { reason: 'missing' };
}

const safeName = (name) => (typeof name === 'string' ? name.replace(/[^\x20-\x7e]/g, '?').slice(0, 200) : null);

/**
 * Archive one run attempt under <outDir>/raw/<runId>-<attempt>/.
 * `ctx` is { apiUrl, token, repo, runId, attempt }; `archiveRoutes` is the set
 * of route ids with archiveLogs. Throws only before anything is written.
 */
export async function archiveRun({ ctx, archiveRoutes, outDir, fetchFn = fetch, sleep = defaultSleep, warn = () => {} }) {
  const { headSha } = await checkRun(ctx, fetchFn);
  const response = await fetchJobsResponse(ctx, fetchFn);
  const dir = join(outDir, 'raw', `${ctx.runId}-${ctx.attempt}`);
  const logsDir = join(dir, 'logs');
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(join(dir, 'jobs.json'), `${JSON.stringify(response, null, 2)}\n`);

  const entries = [];
  for (const job of response.jobs) {
    if (!job || typeof job !== 'object' || typeof job.name !== 'string' || !job.name.startsWith('run ')) continue;
    const parsed = parseJobName(job.name);
    const jobId = Number.isSafeInteger(job.id) && job.id > 0 ? job.id : null;
    const entry = { jobId, name: safeName(job.name), route: parsed?.routeId ?? null, archived: false };
    entries.push(entry);
    if (!parsed || !archiveRoutes.has(parsed.routeId)) {
      entry.reason = 'route-not-enabled';
      continue;
    }
    if (jobId === null || job.status !== 'completed') {
      entry.reason = 'missing';
      continue;
    }
    let result;
    try {
      result = await fetchLog({ ...ctx, jobId }, fetchFn, sleep);
    } catch {
      warn(`the log request for job ${jobId} failed`);
      result = { reason: 'missing' };
    }
    if (!result.buf) {
      entry.reason = result.reason;
      warn(`job ${jobId}: log not archived (${result.reason})`);
      continue;
    }
    if (looksSecret(result.buf.toString('latin1'))) {
      entry.reason = 'secret-shaped';
      warn(`job ${jobId}: log not archived (secret-shaped)`);
      continue;
    }
    writeFileSync(join(logsDir, `${jobId}.log.gz`), gzipSync(result.buf, { level: 9 }));
    entry.archived = true;
    entry.bytes = result.buf.length;
    entry.sha256 = createHash('sha256').update(result.buf).digest('hex');
  }
  entries.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || (a.jobId ?? 0) - (b.jobId ?? 0));
  const manifest = { repo: ctx.repo, runId: ctx.runId, attempt: ctx.attempt, headSha, jobs: entries };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const ctx = readContext(process.env);
  const manifest = await archiveRun({
    ctx,
    archiveRoutes: readArchiveRoutes(join(root, 'routes.json')),
    outDir: arg('out') ?? 'out',
    warn: (m) => console.error(`archive: ${m}`),
  });
  const kept = manifest.jobs.filter((j) => j.archived).length;
  console.error(`archive: jobs.json saved, ${kept} of ${manifest.jobs.length} logs archived`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`archive: ${err.message}`);
    process.exit(1);
  });
}
