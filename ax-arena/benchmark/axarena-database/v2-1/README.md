# DAEB v2.1 Harness-Neutral Production Benchmark

V2.1 is a new immutable namespace. It does not replace the existing DAEB v2
local-qualification evidence or its 51-cell appendix.

Current status: **candidate authoring complete; V2.1 is not frozen or
approved**. See `production-gate-report.md`, `calibration/README.md`, and
`oracles-witness-gate.md` for the blocking gates and exact resume procedure.
The requirement-by-requirement current-state audit is in
`completion-audit.md`.

The production design is:

- six vendors: CockroachDB, InsForge, Neon, Nile, Turso, Supabase;
- CLI surface only, with Pi and OpenCode;
- Gemini 3.7 Flash, DeepSeek V4 Flash 0731, and GLM 5.2;
- three trials and four independent family sessions;
- 432 planned invocation cells before structural N/A task observations.

The reviewed local harness pins are Pi 0.84.2 and OpenCode 1.18.18; a formal
controller must fail closed on any detected binary-version drift.

The frozen route policy explicitly sets OpenRouter `data_collection: allow`;
this is a route-eligibility setting, not a fallback. It is recorded in the
route manifest so privacy policy is part of the reproducible run identity.

The current official CLI/data-plane source reachability and content hashes are
recorded in `docs-snapshot-manifest.yaml` (26/26 HTTP sources succeeded on the
latest refresh). This snapshot is an input-audit artifact; it does not by itself
approve a capability inventory or oracle.

OpenRouter model alias resolution and provider endpoint status are recorded in
`preflight/model-registry-snapshot.json`; date-stamped request slugs are kept
as the registered inputs, while the resolved endpoint ids remain visible.

## Authoring gates

    node --import tsx ax-arena/benchmark/src/cli.ts benchmark synthesize-suite --category database --vendors cockroachdb,insforge,neon,nile,turso,supabase --candidate-count 16 --difficulty-profile discriminative --anchors workspace://ax-eval/ax-arena/benchmark/axarena-database/v2/production/suite.yaml --surface cli --deterministic --benchmark-root workspace://ax-eval/ax-arena/benchmark/axarena-database --out workspace://ax-eval/ax-arena/benchmark/axarena-database/v2-1/candidate-suite-v2-1.yaml
    npm run ax-arena -- benchmark calibrate-suite --candidate-suite axarena-database/v2-1/candidate-suite-v2-1.yaml --results <calibration-root>/observations.jsonl --target-count 10 --out axarena-database/v2-1/selection-v2-1.json
    npm run ax-arena -- benchmark freeze-suite --suite axarena-database/v2-1/selection-v2-1.json --freeze-gates axarena-database/v2-1/freeze-gates.json --out axarena-database/v2-1/suite-v2-1.yaml
    npm run ax-arena -- benchmark plan-v21 --suite axarena-database/v2-1/suite-v2-1.yaml --vendors cockroachdb,insforge,neon,nile,turso,supabase --out axarena-database/v2-1/plan-v2-1.json

`freeze-gates.json` is a controller-side object such as
`{"docs":"<sha256>","support":"<sha256>","oracle":"<sha256>","witness":"<sha256>","calibration":"<sha256>","review":"<sha256>"}`.

Before calibration, inspect the pack gate with:

    npm run ax-arena -- benchmark prepare-v21-packs --suite axarena-database/v2-1/candidate-suite-v2-1.yaml --apply

The current draft derives 67 ready vendor-task tuples from existing and fresh
independent witnesses, records no admitted tuple without a witness, and keeps
29 structural N/A/non-admitted tuples visible. The generated `packs/` are
partial drafts only; they are not pack approvals and cannot be used for a
formal run until every supported candidate task has its own oracle and witness.

Calibration uses Pi with one trial for Gemini and DeepSeek. GLM is a holdout
and is never used to select the ten tasks. A freeze is rejected
unless the anchor, family-quota, five-of-six-vendor-support, invalid-rate, and
calibration-band gates all pass.
The freeze sidecar records hash gates for docs, support, oracle, witness,
calibration, and review; a missing gate keeps `production_eligible` false.

After freeze, the resumable controller is started from the repository root:

    npm run v21:formal --workspace @ax-arena/benchmark -- --dry-run
    npm run v21:formal --workspace @ax-arena/benchmark

It reads `DAEB_V21_SUITE` and `DAEB_V21_RUN_ROOT` when set (otherwise it uses
the canonical v2.1 paths), writes one checkpoint and observation file per cell,
and resumes only from a matching terminal checkpoint. It refuses to start when
the suite is not production-eligible, any vendor pack lacks a full-file human
approval, a harness binary drifts, or the isolated OpenRouter key is absent.
The dry run writes only the 432-cell controller plan and never starts a model.

## Route and execution gates

Every formal invocation uses a controller-owned loopback OpenRouter gateway.
The gateway injects the frozen canonical model, a single provider in both
only and order, allow_fallbacks:false, and require_parameters:true. Pi and
OpenCode receive isolated homes and config; they do not receive ambient
provider keys or model aliases. A missing or mismatched resolved-provider
attestation is invalid-route, never an ordinary task failure.

The final ledger must retain every planned cell and observation with one of:
pass, fail, structural-na, invalid-infra, or invalid-route. The primary score
is pass@1 provider-oracle usability. Discovery, strict/recovery trace quality,
latency/TTFT/tool calls, and gateway-reported cost are separate panels.

No V2.1 live run is publication-ready until the route preflight, suite freeze,
oracle/witness coverage, full ledger, and all tests/typecheck/build gates pass.
