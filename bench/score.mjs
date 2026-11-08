// Scoring, as described in METHODOLOGY.md. No dependencies.
//
// Usage: node bench/score.mjs [--results results] [--suite <version>]
//          [--time-baseline <vcpu>=<routeId>]... [--cost-baseline <routeId>]
// Reads results/<suite>/*.jsonl, routes.json and suite.json, prints JSON.
//
// Unknown is null, never 0: a missing cost makes Value and Score null.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIN_ATTEMPTS = 20;
export const MIN_DAYS = 3;
export const MIN_TIME_WINDOWS = 2; // distinct 6-hour UTC windows
export const MIN_RELIABILITY_PERCENT = 95;
export const UNSTABLE_CV = 0.15;
export const P95_MIN_SAMPLES = 40;
const ATTEMPT_CONCLUSIONS = new Set(['success', 'failure', 'timed_out']);

/** Percentile by linear interpolation between closest ranks. `sorted` ascending, non-empty. */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Geometric mean; null for an empty list or any null, non-finite or non-positive value. */
export function geomean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  let sumLogs = 0;
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
    sumLogs += Math.log(v);
  }
  return Math.exp(sumLogs / values.length);
}

/** n, p50, p90, p95 (only from 40 samples), mean, coefficient of variation, unstable. */
export function summarize(samples) {
  const xs = samples.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return { n: 0, p50: null, p90: null, p95: null, mean: null, cv: null, unstable: false };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  let cv = null;
  if (n >= 2 && mean > 0) {
    const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
    cv = Math.sqrt(variance) / mean;
  }
  return {
    n,
    p50: percentile(xs, 0.5),
    p90: percentile(xs, 0.9),
    p95: n >= P95_MIN_SAMPLES ? percentile(xs, 0.95) : null,
    mean,
    cv,
    unstable: cv !== null && cv > UNSTABLE_CV,
  };
}

function ratio(value, base) {
  if (typeof value !== 'number' || typeof base !== 'number') return null;
  if (!Number.isFinite(value) || !Number.isFinite(base) || base <= 0 || value <= 0) return null;
  return value / base;
}

function startOf(row) {
  const t = Date.parse(row.jobStartedAt ?? row.jobCreatedAt ?? '');
  return Number.isNaN(t) ? null : new Date(t);
}

/** The CPU model of a row's fingerprint, or null when it is missing (rows from 0.1.0 may lack it). */
function cpuModelOf(row) {
  const model = row.fingerprint?.cpuModel;
  return typeof model === 'string' && model.trim() !== '' ? model : null;
}

/**
 * Work time per CPU model, from finished attempts. A row without a model is
 * grouped under `cpuModel: null`; it is never dropped and never read as 0.
 * Models sort by name, the unknown group last.
 */
function byCpu(successes) {
  const groups = new Map();
  for (const r of successes) {
    if (typeof r.workSeconds !== 'number') continue;
    const model = cpuModelOf(r);
    if (!groups.has(model)) groups.set(model, []);
    groups.get(model).push(r.workSeconds);
  }
  return [...groups.entries()]
    .map(([cpuModel, samples]) => {
      const { n, p50, p90, mean, cv } = summarize(samples);
      return { cpuModel, n, p50, p90, mean, cv };
    })
    .filter((g) => g.n > 0)
    .sort((a, b) => (a.cpuModel === null) - (b.cpuModel === null) || (a.cpuModel ?? '').localeCompare(b.cpuModel ?? ''));
}

function buildCell(rows) {
  const attempts = rows.filter((r) => ATTEMPT_CONCLUSIONS.has(r.conclusion));
  const successes = attempts.filter((r) => r.conclusion === 'success');
  const days = new Set();
  const windows = new Set();
  for (const r of attempts) {
    const d = startOf(r);
    if (d === null) continue;
    days.add(d.toISOString().slice(0, 10));
    windows.add(Math.floor(d.getUTCHours() / 6));
  }
  const costs = successes.map((r) => r.costUsd).filter((c) => typeof c === 'number' && Number.isFinite(c) && c >= 0);
  return {
    attempts: attempts.length,
    finished: successes.length,
    days: days.size,
    timeWindows: windows.size,
    work: summarize(successes.map((r) => r.workSeconds).filter((v) => typeof v === 'number')),
    byCpu: byCpu(successes),
    setup: summarize(successes.map((r) => r.setupSeconds).filter((v) => typeof v === 'number')),
    cost: summarize(costs),
  };
}

/**
 * @param {object[]} rows         result rows (any suite version; filtered here)
 * @param {object}   opts
 * @param {string}   opts.suite
 * @param {string[]} opts.workloads         every workload of the suite
 * @param {{id: string, vcpu: number}[]} opts.routes
 * @param {Record<number, string>} opts.timeBaselines   vcpu -> baseline route id
 * @param {string|null} opts.costBaseline   route id of the cost reference (e.g. the private 2-vCPU run)
 */
export function score(rows, opts) {
  const { suite, workloads, routes, timeBaselines = {}, costBaseline = null } = opts;
  const suiteRows = rows.filter((r) => r && typeof r === 'object' && r.suite === suite);
  const routeIds = new Set([...routes.map((r) => r.id), ...suiteRows.map((r) => r.route)]);
  const vcpuOf = new Map(routes.map((r) => [r.id, r.vcpu]));

  const cells = new Map(); // route -> workload -> cell
  for (const id of routeIds) {
    const byWorkload = new Map();
    for (const w of workloads) {
      byWorkload.set(w, buildCell(suiteRows.filter((r) => r.route === id && r.workload === w)));
    }
    cells.set(id, byWorkload);
  }

  // A workload that never succeeds on any route in this data set is not held against a route.
  const failsEverywhere = new Set(
    workloads.filter((w) => {
      let attempts = 0;
      let finished = 0;
      for (const id of routeIds) {
        const c = cells.get(id).get(w);
        attempts += c.attempts;
        finished += c.finished;
      }
      return attempts > 0 && finished === 0;
    }),
  );

  const results = [];
  for (const id of [...routeIds].sort()) {
    const byWorkload = cells.get(id);
    const vcpu = vcpuOf.get(id) ?? null;
    const timeBase = vcpu !== null ? (timeBaselines[vcpu] ?? null) : null;

    const timeRatios = workloads.map((w) =>
      timeBase === null ? null : ratio(byWorkload.get(w).work.p50, cells.get(timeBase)?.get(w).work.p50),
    );
    const costRatios = workloads.map((w) =>
      costBaseline === null ? null : ratio(byWorkload.get(w).cost.p50, cells.get(costBaseline)?.get(w).cost.p50),
    );
    const gTime = geomean(timeRatios);
    const gCost = geomean(costRatios);
    const speed = gTime === null ? null : 100 / gTime;
    const value = gCost === null ? null : 100 / gCost;
    const scoreValue = speed !== null && value !== null ? Math.sqrt(speed * value) : null;

    let attempts = 0;
    let finished = 0;
    for (const w of workloads) {
      if (failsEverywhere.has(w)) continue;
      attempts += byWorkload.get(w).attempts;
      finished += byWorkload.get(w).finished;
    }
    const reliabilityPercent = attempts === 0 ? null : (100 * finished) / attempts;

    const reasons = [];
    for (const w of workloads) {
      const c = byWorkload.get(w);
      if (c.work.n === 0) reasons.push(`${w}: no successful result`);
      if (c.attempts < MIN_ATTEMPTS) reasons.push(`${w}: ${c.attempts} attempts, need ${MIN_ATTEMPTS}`);
      if (c.days < MIN_DAYS) reasons.push(`${w}: ${c.days} days, need ${MIN_DAYS}`);
      if (c.timeWindows < MIN_TIME_WINDOWS) reasons.push(`${w}: ${c.timeWindows} times of day, need ${MIN_TIME_WINDOWS}`);
    }
    if (attempts === 0 || finished * 100 < attempts * MIN_RELIABILITY_PERCENT) {
      reasons.push(`reliability ${reliabilityPercent === null ? 'unknown' : `${reliabilityPercent.toFixed(1)}%`}, need ${MIN_RELIABILITY_PERCENT}%`);
    }
    if (scoreValue === null) {
      reasons.push(`no score (${speed === null ? 'speed unknown' : 'value unknown, cost missing'})`);
    }

    results.push({
      route: id,
      vcpu,
      cells: Object.fromEntries(workloads.map((w) => [w, byWorkload.get(w)])),
      timeRatios: Object.fromEntries(workloads.map((w, i) => [w, timeRatios[i]])),
      costRatios: Object.fromEntries(workloads.map((w, i) => [w, costRatios[i]])),
      reliabilityPercent,
      speed,
      value,
      score: scoreValue,
      unstableCells: workloads.filter((w) => byWorkload.get(w).work.unstable),
      ranked: reasons.length === 0,
      rank: null,
      reasons,
    });
  }

  // Standard competition ranking among ranked routes, best Score first.
  const ranked = results.filter((r) => r.ranked).sort((a, b) => b.score - a.score);
  ranked.forEach((r, i) => {
    r.rank = i > 0 && ranked[i - 1].score === r.score ? ranked[i - 1].rank : i + 1;
  });
  return { suite, workloads, routes: results };
}

function args(name) {
  const out = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1] !== undefined) out.push(process.argv[i + 1]);
  });
  return out;
}

export function readJsonl(dir) {
  const rows = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // a damaged line is skipped, not guessed at
      }
    }
  }
  return rows;
}

function readSuite(root, suite) {
  if (!/^\d+\.\d+\.\d+$/.test(suite)) throw new Error(`not a suite version: ${suite}`);
  try {
    return JSON.parse(readFileSync(join(root, 'suites', `${suite}.json`), 'utf8'));
  } catch {
    throw new Error(`unknown suite ${suite}: no suites/${suite}.json`);
  }
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const current = JSON.parse(readFileSync(join(root, 'suite.json'), 'utf8'));
  const suite = args('suite')[0] ?? current.suite;
  // An earlier suite is scored with its own workload list, kept in suites/<version>.json.
  const suiteJson = suite === current.suite ? current : readSuite(root, suite);
  const resultsDir = join(args('results')[0] ?? join(root, 'results'), suite);
  const routes = JSON.parse(readFileSync(join(root, 'routes.json'), 'utf8')).routes.map((r) => ({ id: r.id, vcpu: r.vcpu }));
  const timeBaselines = {};
  for (const spec of args('time-baseline')) {
    const [vcpu, id] = spec.split('=');
    timeBaselines[Number.parseInt(vcpu, 10)] = id;
  }
  const out = score(readJsonl(resultsDir), {
    suite,
    workloads: Object.keys(suiteJson.workloads),
    routes,
    timeBaselines,
    costBaseline: args('cost-baseline')[0] ?? null,
  });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`score: ${err.message}`);
    process.exit(1);
  }
}
