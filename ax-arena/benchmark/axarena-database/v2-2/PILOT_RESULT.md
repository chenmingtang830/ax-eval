# DAEB V2.2 Native Journey Pilot Result

Status: **diagnostic complete; expansion gate did not pass**. This is not a
production leaderboard and does not replace the immutable V2 baseline.

The bounded run used Pi 0.84.2, one trial, and
`google/gemini-3.7-flash-20260813` pinned to Google Vertex through the local
OpenRouter enforcement gateway. All six final cells have route evidence,
controller read-back, and exact-table cleanup. One Nile upstream/model stop
error was retained as the original invalid observation and linked to one valid
replacement slot.

## Corrected outcome

| Vendor | Final | Discover | Connect | Operate | Recover | Time | Commands | Fetches | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| CockroachDB | pass | pass | pass | pass | pass | 128 s | 15 | 0 | $0.0782 |
| InsForge | pass | pass | pass | pass | pass | 586 s | 61 | 1 | $0.2179 |
| Neon | pass | pass | pass | pass | pass | 150 s | 23 | 7 | $0.0910 |
| Nile | pass | pass | pass | pass | pass | 532 s | 70 | 26 | $0.2539 |
| Supabase | pass | pass | pass | pass | pass | 220 s | 46 | 7 | $0.1367 |
| Turso | pass | pass | pass | pass | pass | 139 s | 8 | 0 | $0.0879 |

Final denominators: 6/6 sessions present; 6 pass, 0 fail, 0 invalid-infra,
and 0 invalid-route. All four stages are 6/6. Gateway-reported final-cell cost
was $0.8656.

## Correction and limitation

The first audit reported Turso recovery as failed. That was a false negative:
the persisted Turso tool evidence contains both a stale-target probe and the
observed 404 before recovery, but string-level secret redaction damaged 149
JSONL lines and the decoder missed the command. The corrected audit preserves
the original observation and adds a reconciliation ledger rather than silently
overwriting it.

The same persistence defect affected fewer lines in four other final
transcripts. Consequently, command/fetch counts and discovery-mode differences
remain useful diagnostics but are not publication-grade measurements from this
run. The harness now parses each JSONL event, redacts decoded values, and
serializes the event again so future transcripts remain valid.

The pilot retains three candidate differentiating dimensions—discovery mode,
tool count, and latency—but it did not satisfy the preregistered requirement
for a non-unanimous capability stage. Decision: **do not expand directly**.
First rerun the same Gemini baseline with zero invalid transcript lines; only
then admit additional models.

## Local evidence

- `results/v22-native-pilot-20260815-r1`
- `results/v22-native-pilot-20260815-nile-replacement-r1`
- `results/v22-native-pilot-20260815-audit-r2`

The corrected machine-readable gate is
`results/v22-native-pilot-20260815-audit-r2/final-pilot-gate.json`; replacement
and scoring corrections are in `replacement-ledger.jsonl` and
`reconciliation-ledger.jsonl`. These ignored live artifacts are not package
contents.
