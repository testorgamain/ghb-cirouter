// Builds the job matrix for the benchmark workflow. No dependencies.
//
// Reads routes.json and the workloads/ directory, takes the repeat count from
// the REPEATS environment variable (never from the command line or a shell
// string), and writes `matrix=<json>` to $GITHUB_OUTPUT (or stdout).
import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function parseRepeats(value) {
  if (typeof value !== 'string' || !/^[0-9]{1,2}$/.test(value)) {
    throw new Error('repeats must be an integer from 1 to 10');
  }
  const n = Number.parseInt(value, 10);
  if (n < 1 || n > 10) throw new Error('repeats must be an integer from 1 to 10');
  return n;
}

export function readRoutes(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!parsed || !Array.isArray(parsed.routes)) throw new Error('routes.json: "routes" must be an array');
  const seen = new Set();
  return parsed.routes.map((r) => {
    if (!r || typeof r !== 'object') throw new Error('routes.json: a route must be an object');
    if (typeof r.id !== 'string' || !ID_RE.test(r.id)) throw new Error(`routes.json: bad route id ${JSON.stringify(r.id)}`);
    if (seen.has(r.id)) throw new Error(`routes.json: duplicate route id ${r.id}`);
    seen.add(r.id);
    for (const key of ['provider', 'runsOn', 'image']) {
      if (typeof r[key] !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(r[key])) {
        throw new Error(`routes.json: route ${r.id} has a bad ${key}`);
      }
    }
    for (const key of ['vcpu', 'memoryGb']) {
      if (!Number.isInteger(r[key]) || r[key] < 1) throw new Error(`routes.json: route ${r.id} has a bad ${key}`);
    }
    if (typeof r.enabled !== 'boolean') throw new Error(`routes.json: route ${r.id} has a bad enabled`);
    return {
      id: r.id,
      provider: r.provider,
      runsOn: r.runsOn,
      vcpu: r.vcpu,
      memoryGb: r.memoryGb,
      image: r.image,
      enabled: r.enabled,
    };
  });
}

/** Names of the directories under workloads/ that are valid workload ids. */
export function listWorkloads(dir) {
  return readdirSync(dir)
    .filter((name) => ID_RE.test(name) && statSync(join(dir, name)).isDirectory())
    .sort();
}

export function buildMatrix(routes, workloads, repeats) {
  const include = [];
  for (const route of routes.filter((r) => r.enabled)) {
    for (const workload of workloads) {
      for (let rep = 1; rep <= repeats; rep++) include.push({ route, workload, rep });
    }
  }
  return { include };
}

function main() {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const repeats = parseRepeats(process.env.REPEATS ?? '1');
  const matrix = buildMatrix(readRoutes(join(root, 'routes.json')), listWorkloads(join(root, 'workloads')), repeats);
  if (matrix.include.length === 0) throw new Error('the matrix is empty: no enabled route or no workload');
  const line = `matrix=${JSON.stringify(matrix)}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  else process.stdout.write(line);
  console.error(`plan: ${matrix.include.length} jobs`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`plan: ${err.message}`);
    process.exit(1);
  }
}
