// Runs publish.sh against a local bare repository. The remote URL is rewritten
// with a throwaway global git config, so nothing leaves the machine.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'publish.sh');
const have = (cmd) => spawnSync(cmd, ['--version']).status === 0;

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'publish-'));
  const bare = join(base, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  const gitconfig = join(base, 'gitconfig');
  writeFileSync(gitconfig, `[url "file://${bare}"]\n\tinsteadOf = https://github.com/o/r.git\n[safe]\n\tdirectory = *\n`);
  const env = {
    PATH: process.env.PATH,
    HOME: base,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GITHUB_TOKEN: 'tok',
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_RUN_ID: '5',
    GITHUB_RUN_ATTEMPT: '1',
  };
  const publish = (out, extra = {}) => spawnSync('bash', [script, out], { env: { ...env, ...extra }, encoding: 'utf8' });
  const show = (path) => execFileSync('git', ['--git-dir', bare, 'show', `results:${path}`], { encoding: 'utf8' });
  const tree = () => execFileSync('git', ['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'results'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const out = (files) => {
    const dir = mkdtempSync(join(base, 'out-'));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return dir;
  };
  return { publish, show, tree, out };
}

const skip = !(have('git') && have('bash'));

test('publish.sh publishes raw-only output', { skip }, () => {
  const t = setup();
  const r = t.publish(t.out({ 'raw/7-1/jobs.json': '{}\n' }));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(t.tree(), ['raw/7-1/jobs.json']);
});

test('publish.sh never overwrites a file already on the branch, and a rerun adds only what is new', { skip }, () => {
  const t = setup();
  assert.equal(t.publish(t.out({ 'results/s/7-1.jsonl': 'old row\n', 'raw/7-1/jobs.json': 'old jobs\n' })).status, 0);
  const second = t.publish(
    t.out({ 'results/s/7-1.jsonl': 'NEW row\n', 'raw/7-1/jobs.json': 'NEW jobs\n', 'raw/7-1/manifest.json': 'manifest\n', 'raw/7-1/logs/9.log.gz': 'log\n' }),
    { PUBLISH_RUN_ID: '7', PUBLISH_RUN_ATTEMPT: '1' },
  );
  assert.equal(second.status, 0, second.stderr);
  assert.equal(t.show('results/s/7-1.jsonl'), 'old row\n');
  assert.equal(t.show('raw/7-1/jobs.json'), 'old jobs\n');
  assert.equal(t.show('raw/7-1/manifest.json'), 'manifest\n');
  assert.deepEqual(t.tree(), ['raw/7-1/jobs.json', 'raw/7-1/logs/9.log.gz', 'raw/7-1/manifest.json', 'results/s/7-1.jsonl']);
  // An identical rerun changes nothing.
  const third = t.publish(t.out({ 'raw/7-1/jobs.json': 'NEWER\n' }));
  assert.equal(third.status, 0);
  assert.match(third.stdout, /already up to date/);
  assert.equal(t.show('raw/7-1/jobs.json'), 'old jobs\n');
});

test('publish.sh exits cleanly with nothing to publish', { skip }, () => {
  const t = setup();
  const r = t.publish(t.out({ 'other.txt': 'x' }));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /nothing to publish/);
});
