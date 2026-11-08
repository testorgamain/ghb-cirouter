// Collects one workflow run attempt into result rows. No dependencies.
//
// Trust model: the job name, step timings and conclusions come from GitHub's
// jobs API. The route and workload of a row come from the job NAME, checked
// against routes.json and the workloads/ directory. The fingerprint artifact is
// untrusted: it is parsed as JSON, only known fields survive, each with a type
// and length limit, and its content is never used in a path or a shell command.
//
// Usage (environment: GITHUB_TOKEN, GITHUB_REPOSITORY, RUN_ID, RUN_ATTEMPT):
//   node bench/collect.mjs --artifacts <dir> --out <dir>
// Writes <out>/results/<suite>/<runId>-<attempt>.jsonl
import { lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const JOB_NAME_RE = /^run ([a-z0-9][a-z0-9-]{0,62}) ([a-z0-9][a-z0-9-]{0,62}) ([0-9]{1,2})$/;
export const MAX_REP = 10;
export const MAX_FINGERPRINT_BYTES = 4096;
const CONCLUSIONS = new Set(['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'neutral', 'action_required', 'stale']);
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const PRINTABLE_RE = /^[\x20-\x7e]+$/;

/** Parse `run <routeId> <workload> <rep>`; null for any other name. */
export function parseJobName(name) {
  if (typeof name !== 'string' || name.length > 200) return null;
  const m = JOB_NAME_RE.exec(name);
  if (!m) return null;
  const rep = Number.parseInt(m[3], 10);
  if (rep < 1 || rep > MAX_REP) return null;
  return { routeId: m[1], workload: m[2], rep };
}

/** The ids of the routes listed in routes.json (enabled or not). */
export function readRouteIds(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || !Array.isArray(parsed.routes)) throw new Error('routes.json: "routes" must be an array');
  const ids = new Set();
  for (const r of parsed.routes) {
    if (r && typeof r.id === 'string' && ID_RE.test(r.id)) ids.add(r.id);
  }
  return ids;
}

/** The valid workload ids: directories under workloads/. */
export function readWorkloadIds(dir) {
  return new Set(readdirSync(dir).filter((n) => ID_RE.test(n) && statSync(join(dir, n)).isDirectory()));
}

export function readSuiteVersion(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const v = parsed?.suite;
  if (typeof v !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/.test(v)) throw new Error('suite.json: bad suite version');
  return v;
}

export function toIso(value) {
  if (typeof value !== 'string' || value.length > 40 || !TIMESTAMP_RE.test(value)) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Seconds between two API timestamps, or null when either is missing or the order is wrong. */
export function secondsBetween(start, end) {
  const a = toIso(start);
  const b = toIso(end);
  if (a === null || b === null) return null;
  const s = (Date.parse(b) - Date.parse(a)) / 1000;
  return s >= 0 ? s : null;
}

/** Duration of the step with exactly this name, or null (missing, unfinished, ambiguous). */
export function stepSeconds(steps, name) {
  if (!Array.isArray(steps)) return null;
  const matches = steps.filter((s) => s && typeof s === 'object' && s.name === name);
  if (matches.length !== 1) return null;
  const step = matches[0];
  if (step.status !== 'completed') return null;
  return secondsBetween(step.started_at, step.completed_at);
}

function str(value, max) {
  return typeof value === 'string' && value.length >= 1 && value.length <= max && PRINTABLE_RE.test(value) ? value : null;
}
function int(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}
function num(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

/**
 * Reduce parsed (untrusted) JSON to the fingerprint schema. Unknown keys are
 * dropped; a value of the wrong type, range or length becomes null.
 * Returns null when the input is not a plain object.
 */
export function sanitizeFingerprint(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const own = (k) => (Object.hasOwn(raw, k) ? raw[k] : undefined);
  return {
    cpuModel: str(own('cpuModel'), 128),
    vcpus: int(own('vcpus'), 1, 4096),
    memoryMb: int(own('memoryMb'), 1, 16_000_000),
    diskTotalGb: num(own('diskTotalGb'), 0.001, 1_000_000),
    os: str(own('os'), 128),
    kernel: str(own('kernel'), 128),
  };
}

/** Read a fingerprint file safely: a regular file, small, valid JSON. Null otherwise. */
export function readFingerprintFile(path) {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_FINGERPRINT_BYTES) return null;
    return sanitizeFingerprint(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/** The directory name upload-artifact is given for a job; built only from validated parts. */
export function artifactDirName(attempt, routeId, workload, rep) {
  return `fingerprint-${attempt}-${routeId}-${workload}-${rep}`;
}

/**
 * Turn jobs-API jobs into rows. `ctx` carries trusted values:
 * { suite, repo, runId, attempt, routeIds, workloadIds, artifactsDir, warn }.
 * `readFingerprint(path)` is injectable for tests.
 */
export function buildRows(jobs, ctx, readFingerprint = readFingerprintFile) {
  const warn = ctx.warn ?? (() => {});
  const rows = [];
  const seen = new Set();
  for (const job of jobs) {
    if (!job || typeof job !== 'object') continue;
    if (typeof job.name !== 'string' || !job.name.startsWith('run ')) continue; // plan, collect
    const parsed = parseJobName(job.name);
    if (!parsed) {
      warn(`skipping a job with a malformed name ${JSON.stringify(String(job.name).slice(0, 80))}`);
      continue;
    }
    if (!ctx.routeIds.has(parsed.routeId) || !ctx.workloadIds.has(parsed.workload)) {
      warn(`skipping a job with an unknown route or workload ${JSON.stringify(String(job.name).slice(0, 80))}`);
      continue;
    }
    if (job.status !== 'completed') {
      warn(`skipping unfinished job ${JSON.stringify(job.name)}`);
      continue;
    }
    const key = `${parsed.routeId} ${parsed.workload} ${parsed.rep}`;
    if (seen.has(key)) {
      warn(`skipping a duplicate job ${JSON.stringify(key)}`);
      continue;
    }
    seen.add(key);
    const fingerprint = readFingerprint(
      join(ctx.artifactsDir, artifactDirName(ctx.attempt, parsed.routeId, parsed.workload, parsed.rep), 'fingerprint.json'),
    );
    rows.push({
      suite: ctx.suite,
      route: parsed.routeId,
      workload: parsed.workload,
      rep: parsed.rep,
      runId: ctx.runId,
      runUrl: `https://github.com/${ctx.repo}/actions/runs/${ctx.runId}/attempts/${ctx.attempt}`,
      attempt: ctx.attempt,
      conclusion: CONCLUSIONS.has(job.conclusion) ? job.conclusion : null,
      jobCreatedAt: toIso(job.created_at),
      jobStartedAt: toIso(job.started_at),
      jobCompletedAt: toIso(job.completed_at),
      setupSeconds: stepSeconds(job.steps, 'setup'),
      workSeconds: stepSeconds(job.steps, 'work'),
      fingerprint,
      costUsd: null,
      headSha: typeof job.head_sha === 'string' && SHA_RE.test(job.head_sha) ? job.head_sha : null,
      jobId: Number.isSafeInteger(job.id) && job.id > 0 ? job.id : null,
    });
  }
  rows.sort((a, b) => a.route.localeCompare(b.route) || a.workload.localeCompare(b.workload) || a.rep - b.rep);
  return rows;
}

/**
 * GET every page of the attempt's jobs. Returns { total_count, jobs } with the
 * jobs exactly as the API sent them. `fetchFn` is injectable for tests.
 */
export async function fetchJobsResponse({ apiUrl, token, repo, runId, attempt }, fetchFn = fetch) {
  const jobs = [];
  let totalCount = null;
  for (let page = 1; page <= 30; page++) {
    const url = `${apiUrl}/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`;
    const res = await fetchFn(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ci-benchmark-collect',
      },
    });
    if (!res.ok) throw new Error(`jobs API answered ${res.status}`);
    const body = await res.json();
    if (page === 1 && Number.isInteger(body?.total_count)) totalCount = body.total_count;
    const batch = Array.isArray(body?.jobs) ? body.jobs : [];
    jobs.push(...batch);
    if (batch.length < 100) return { total_count: totalCount ?? jobs.length, jobs };
  }
  throw new Error('jobs API: more than 30 pages');
}

/** GET every page of the attempt's jobs. `fetchFn` is injectable for tests. */
export async function fetchJobs(ctx, fetchFn = fetch) {
  return (await fetchJobsResponse(ctx, fetchFn)).jobs;
}

export function toJsonl(rows) {
  return rows.map((r) => `${JSON.stringify(r)}\n`).join('');
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

export function readContext(env) {
  const repo = env.GITHUB_REPOSITORY ?? '';
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo)) throw new Error('GITHUB_REPOSITORY is not owner/name');
  if (!/^[1-9][0-9]{0,18}$/.test(env.RUN_ID ?? '')) throw new Error('RUN_ID is not an integer');
  if (!/^[1-9][0-9]{0,5}$/.test(env.RUN_ATTEMPT ?? '')) throw new Error('RUN_ATTEMPT is not an integer');
  const apiUrl = env.GITHUB_API_URL ?? 'https://api.github.com';
  if (!/^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?(\/[A-Za-z0-9._/-]*)?$/.test(apiUrl)) throw new Error('GITHUB_API_URL is not an https URL');
  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not set');
  return {
    repo,
    runId: Number.parseInt(env.RUN_ID, 10),
    attempt: Number.parseInt(env.RUN_ATTEMPT, 10),
    apiUrl: apiUrl.replace(/\/$/, ''),
    token: env.GITHUB_TOKEN,
  };
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const env = readContext(process.env);
  const artifactsDir = arg('artifacts') ?? 'artifacts';
  const outDir = arg('out') ?? 'out';
  const suite = readSuiteVersion(join(root, 'suite.json'));
  const jobs = await fetchJobs(env);
  const rows = buildRows(jobs, {
    suite,
    repo: env.repo,
    runId: env.runId,
    attempt: env.attempt,
    routeIds: readRouteIds(join(root, 'routes.json')),
    workloadIds: readWorkloadIds(join(root, 'workloads')),
    artifactsDir,
    warn: (m) => console.error(`collect: ${m}`),
  });
  console.error(`collect: ${rows.length} rows from ${jobs.length} jobs`);
  if (rows.length === 0) return; // nothing to publish; no empty file
  const dir = join(outDir, 'results', suite);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${env.runId}-${env.attempt}.jsonl`), toJsonl(rows));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`collect: ${err.message}`);
    process.exit(1);
  });
}
