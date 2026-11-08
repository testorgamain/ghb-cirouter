# CI runner benchmark

An open benchmark of CI runners: the same real build and test jobs, run on
different runners, with the duration, cost and reliability of each one.

## Status

**Stage 1: baseline.** This repository holds two workloads and one route, the
GitHub-hosted 4-vCPU Ubuntu runner. The point of this stage is to prove the
harness and to see how noisy repeated runs are.

**No comparison published yet.** There are no results on this page and none
should be read into the numbers in a single run. Nothing is ranked.

## Conflict of interest

This benchmark is run by the people who build ci-router,
a routing layer that places GitHub Actions jobs on different compute providers.
ci-router sells one of the routes this benchmark will rank, so we have a reason
to want it to look good. Our answers to that:

- Every result links to a public GitHub Actions run, so the logs and timings can
  be read by anyone. A result without a public run link is not published.
- The workloads, pinned commits, scoring code and raw rows are all in this
  repository.
- Benchmark jobs get no special treatment from the router.
- You do not have to trust us: you can run the whole thing yourself (below).

The one planned exception to "every result has a public run" is the private
2-vCPU reference run, described in [METHODOLOGY.md](METHODOLOGY.md).

This repository does not accept outside pull requests. To run the benchmark
yourself, fork it (below).

## What is here

| Path | What it is |
| --- | --- |
| `LICENSE`, `LICENSE-RESULTS` | Apache-2.0 for the code, CC-BY-4.0 for results and raw data |
| `METHODOLOGY.md` | Principles, workloads, metrics, scoring, ranking rules, limits |
| `suite.json` | The suite version and the pinned workloads |
| `suites/<version>.json` | The workload list of earlier suite versions, so their results can still be scored |
| `routes.json` | The routes under test (one enabled in stage 1, one declared but disabled) |
| `workloads/<name>/setup.sh`, `work.sh` | Install the toolchain and dependencies, then do the timed work |
| `bench/` | Fingerprint, planning, collection and scoring scripts, and their tests |
| `.github/workflows/benchmark.yml` | The benchmark, started by hand |
| `.github/workflows/archive.yml` | Saves the raw data of an earlier run, started by hand |

## Reproduce it by forking

1. Fork this repository. Keep it public: a public repository's standard
   Ubuntu runner has 4 vCPUs and 16 GB, a private one has 2 vCPUs and 8 GB, and
   the results are only comparable at the same size.
2. In your fork's Actions tab, enable workflows.
3. Run the `benchmark` workflow from the default branch with `workflow_dispatch`.
   The `repeats` input is an integer from 1 to 10 (default 1).
4. Each job is named `run <route> <workload> <repeat>`. The `setup` and `work`
   steps are timed by GitHub, and the log shows exactly what ran.
5. When the run is on the default branch, the `collect` job appends one row per
   job to a `results` branch in your fork, under `results/<suite>/`, and saves
   the raw jobs-API response and some logs under `raw/` (see
   [What is saved](METHODOLOGY.md#what-is-saved)). It never pushes to the
   default branch.
6. Score the rows with `node bench/score.mjs --results <dir> --time-baseline 4=github-hosted-4vcpu`.

A private fork needs `contents: read` on the jobs that check out the code. The
workflow sets `permissions: {}` because the public repository does not need it.

To run the checks on your own machine you need Node 22 and no packages:

```
node --test
```

## Safety

The workflow starts only from `workflow_dispatch`. There is no `pull_request`
trigger, no secrets in the benchmark jobs, no caches and no third-party actions;
the four GitHub-owned actions in use are pinned by full commit SHA. The router
itself refuses to place jobs that did not come from a manual or scheduled run on
the default branch, so a pull request from a fork cannot start paid compute.

## Licence

- The code in this repository (scripts, workflows, workload definitions and
  tests) is licensed under the [Apache License 2.0](LICENSE).
- The results and the raw data on the `results` branch are licensed under
  [Creative Commons Attribution 4.0 International](LICENSE-RESULTS) (CC-BY-4.0).
  Attribute them to "ci-router benchmark".
