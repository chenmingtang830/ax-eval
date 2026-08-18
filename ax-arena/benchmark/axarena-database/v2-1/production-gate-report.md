# DAEB V2.1 production gate report

Generated: 2026-08-15

## Decision

**NOT FROZEN. NOT APPROVED. NO FORMAL RUN STARTED.**

This is the honest completion state of the work that can be done locally
without fabricating model, oracle, or calibration evidence. DAEB v2 and its
51-cell local-qualification result are preserved as the immutable baseline.
The requirement-by-requirement audit is in `completion-audit.md`.

## Completed

- New V2.1 namespace created under this directory; baseline V2 was not
  overwritten.
- Six-vendor CLI candidate synthesis completed: 16 candidates, with the three
  required anchors present exactly once.
- Official CLI/data-plane source reachability snapshot completed: 26/26 HTTP
  sources returned successfully; hashes are in `docs-snapshot-manifest.yaml`.
- OpenRouter model/provider endpoint resolution was refreshed and recorded in
  `preflight/model-registry-snapshot.json`; the DeepSeek provider endpoint is
  healthy but filtered by the current workspace account policy.
- Local OpenRouter enforcement gateway implemented and tested: canonical model,
  single provider, no fallback, required parameters, route attestation,
  usage/cost/latency ledger, and secret redaction.
- Resumable V2.1 formal controller implemented: it emits the 432-cell plan,
  runs one family session per cell, retains invalid/N/A rows, verifies before
  cleanup, and resumes only from identity-matching terminal checkpoints.
- Calibration planner implemented and materialized at
  `calibration/plan-v21-calibration.json`: 288 Pi trial-1 cells across the 16
  candidates, with Gemini and DeepSeek as calibration models and GLM as the
  holdout; 87 low-coverage cells remain explicit structural N/A.
- Pi 0.84.2 and OpenCode 1.18.18 installed, pinned, and parity-probed through
  the gateway. Gemini 3.7 Flash and GLM 5.2 now pass clean no-write route
  probes in both harnesses; their text-only probe artifacts remain explicitly
  non-scoring.
- The latest loopback gateway-only retry is retained under `preflight/gateway-r8/`:
  Gemini `200/ok`, GLM `200/ok`, DeepSeek `404/upstream-error`; the key is valid
  for inference but the guardrail-management endpoint returns `401`.
- Candidate artifacts, the Supabase extension overlay, and an explicit pack
  readiness report are hash-bound:

  - suite `e41edd3a72ae2b641fe4ac679000e1745b30d08cf4fb7f46337aa5d13dc93b70`
  - selection ledger `55bff315703530ebe228afa11a759e92d8f32eb56c2b1d1e2b16f87bc8188bbd`
  - support matrix `0f15c5f7941f622f10e8994baacff9e5a4b3d31b510b9b11d4df4781b9b1f954`
  - docs snapshot `f7cd10da61f0b13ac822617653b7f9438dbbb727aa8ef778686febf4f14d3d63`
  - pack readiness `c8c233939c9ff55fa352d44afcd31292703a7509a988b09a2aabd4fde1c3a92d`: 67 ready tuples, 0 blocked supported tuples, 29 structural N/A/non-admitted tuples

## Blocking gates

1. DeepSeek exact pinned route is rejected by the current OpenRouter privacy /
   guardrail policy. OpenRouter's model endpoint exists, but the workspace
   account policy refuses the available DeepSeek provider endpoint. A diagnostic
   probe shows DeepInfra/StreamLake can serve the model, but those providers are
   not admissible substitutes under the frozen provider pin and were not used.
2. The four family capacity gates pass. Lower-coverage research candidates are
   explicitly marked structural N/A/non-admitted; they are not silently moved
   into the formal denominator.
3. No V2.1 calibration observations, selection ledger, frozen suite, pack
   approvals, or formal ledger exist. This is intentional.
4. The candidate audit now has zero errors and zero warnings after adding the
   negative-query candidate. The ten-sample delegated trace/protocol review is complete, with
   its non-independent-review limitation recorded in the artifact.

## Exact resume conditions

After the DeepSeek route gate is repaired without changing the frozen slugs:

The local key is valid for inference but `/api/v1/key` reports
`is_management_key:false`; no privacy or guardrail setting was changed
automatically. An account/workspace admin must admit the pinned DeepSeek
provider (or supply a key with that guardrail) before calibration can start.

1. Run Pi trial-1 calibration for Gemini and DeepSeek, retaining GLM as
   holdout and retaining all invalid observations.
2. Compose and witness the six V2.1 CLI packs; resolve the candidate audit.
3. Run `calibrate-suite`, then `freeze-suite` with real hashes for all six
   gates; verify `production_eligible: true`.
4. Run `plan-v21` and only then open the 432-cell formal controller.
5. Publish the complete ledger, including structural N/A, invalid, latency,
   TTFT, tool-call, token, and cost panels.
