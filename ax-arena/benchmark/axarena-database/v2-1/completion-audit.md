# DAEB V2.1 completion audit

Generated from the current `/Users/richardtang/ax-eval` checkout. This is an
audit of the production objective, not a claim that the benchmark is frozen.

| Requirement | Current evidence | Status |
|---|---|---|
| Pi/OpenCode latest binaries pinned | Pi 0.84.2; OpenCode 1.18.18; route manifest and direct version checks | proven |
| Six-vendor official input refresh | `docs-snapshot-manifest.yaml`, 26/26 sources fetched and hashed | proven as input reachability |
| V2.1 16-task candidate synthesis | `candidate-suite-v2-1.yaml`, three anchors retained exactly once | proven as draft |
| CLI-only support matrix | `candidate-suite-v2-1.support-matrix.yaml`, CLI entries only; Supabase extension overlay included | proven as draft |
| Independent oracle/witness coverage | `pack-readiness.yaml`: 67 ready, 0 blocked supported, 29 structural N/A/non-admitted; session/principal variants have five fresh witnesses each, and constraint/transaction/aggregate/negative-query variants have fresh controller witnesses | proven for all task-fit-admitted tuples; research candidates remain explicit N/A |
| Family-quota feasibility | `family-quota-capacity.yaml`: access 2, schema 3, query 5, lifecycle 2 candidates meet both the >=5/6 CLI coverage and readiness gates | proven as capacity; calibration still not run |
| Ten-task calibration selection | `calibration/plan-v21-calibration.json` is a 288-cell Pi trial-1 plan (Gemini + DeepSeek calibration, GLM holdout) with 87 explicit structural N/A cells; no model observations have been admitted | not run |
| Freeze and pack approvals | no valid selection, freeze-gate hash set, or six-vendor approved pack set | not run |
| Gateway route policy | `route-manifest.yaml`; fallback/batch disabled, provider-only/order enforced, data policy explicit | proven for Gemini/GLM; DeepSeek blocked |
| Harness parity preflight | `preflight/harness-r6/` plus current `preflight/gateway-r8/` | Gemini/GLM proven; DeepSeek blocked |
| 432-cell formal execution | no formal run started; no cells fabricated | not run |
| Resumable formal controller | `src/runtime/v21-controller.ts` plus `scripts/run-v21-formal.ts`; dry-run plan and checkpoint tests pass | implemented, live-gated |
| Publication ledger | no V2.1 formal ledger exists; V2 baseline remains separate and immutable | not eligible |
| Offline quality gates | core 59 files/572 tests and arena 57 files/332 tests; typecheck and build both pass after the latest authoring/runtime changes | proven |

## External action required

The local `.env` now contains an OpenRouter key and the read-only `/api/v1/key`
check succeeds, but it is not a management key. The latest loopback preflight
(`preflight/gateway-r8/summary.json`) still rejects the exact DeepSeek route with
`No endpoints available matching your guardrail restrictions and data policy`.
The model endpoint itself lists 28 endpoints and the DeepSeek provider is
present; DeepInfra/StreamLake diagnostic routes pass but remain inadmissible
provider substitutions.
No privacy or guardrail setting has been changed by this workspace; an account
admin must adjust the workspace/account policy or provide a key whose guardrail
admits the pinned DeepSeek provider.
