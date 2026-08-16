# DAEB v2 complete local result matrix

Every row is one observed `vendor × harness × model × trial` cell. The release cohort and comparative appendix are kept separate.

## Aggregate lanes

| cohort | lane | cells | task usability | discovery | AX | strict | mean cell | first action | cost coverage | reported cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| release | core-codex-gpt56-terra | 15 | 89/93 (95.70%) | 90.00% | 92.76% | 64/93 | 249.6s | 12.7s | 0/15 | N/A |
| release | core-claude-sonnet5 | 15 | 93/93 (100.00%) | 100.00% | 100.00% | 93/93 | 186.0s | 1.3s | 15/15 | $12.187 |
| release | supabase-cli-codex-gpt56-terra | 3 | 21/21 (100.00%) | 83.33% | 90.91% | 21/21 | 286.6s | 14.4s | 0/3 | N/A |
| release | supabase-cli-claude-sonnet5 | 3 | 21/21 (100.00%) | 100.00% | 100.00% | 21/21 | 187.4s | 1.2s | 3/3 | $2.510 |
| appendix | core-opencode-glm52-local-comparative | 15 | 89/93 (95.70%) | 100.00% | 97.80% | N/A | 588.1s | 3.3s | 0/15 | N/A |

## Every cell

| cohort | vendor | harness | model | trial | task pass | discovery | AX | strict | latency | first action | reported cost |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| release | cockroachdb | codex | gpt-5.6-terra | 1 | 7/7 | 100.00% | 100.00% | 7/7 | 270.0s | 14.1s | N/A |
| release | cockroachdb | codex | gpt-5.6-terra | 2 | 7/7 | 100.00% | 100.00% | 0/7 | 88.2s | 10.0s | N/A |
| release | cockroachdb | codex | gpt-5.6-terra | 3 | 7/7 | 100.00% | 100.00% | 7/7 | 198.9s | 13.6s | N/A |
| release | insforge | codex | gpt-5.6-terra | 1 | 6/6 | 50.00% | 66.67% | 1/6 | 274.5s | 11.4s | N/A |
| release | insforge | codex | gpt-5.6-terra | 2 | 2/6 | 50.00% | 40.00% | 1/6 | 196.4s | 10.4s | N/A |
| release | insforge | codex | gpt-5.6-terra | 3 | 6/6 | 100.00% | 100.00% | 1/6 | 194.5s | 10.8s | N/A |
| release | neon | codex | gpt-5.6-terra | 1 | 7/7 | 100.00% | 100.00% | 6/7 | 324.6s | 12.5s | N/A |
| release | neon | codex | gpt-5.6-terra | 2 | 7/7 | 100.00% | 100.00% | 7/7 | 220.9s | 13.6s | N/A |
| release | neon | codex | gpt-5.6-terra | 3 | 7/7 | 100.00% | 100.00% | 1/7 | 158.8s | 18.4s | N/A |
| release | nile | codex | gpt-5.6-terra | 1 | 6/6 | 50.00% | 66.67% | 6/6 | 279.3s | 21.5s | N/A |
| release | nile | codex | gpt-5.6-terra | 2 | 6/6 | 100.00% | 100.00% | 6/6 | 324.9s | 11.7s | N/A |
| release | nile | codex | gpt-5.6-terra | 3 | 6/6 | 100.00% | 100.00% | 6/6 | 313.9s | 10.3s | N/A |
| release | turso | codex | gpt-5.6-terra | 1 | 5/5 | 100.00% | 100.00% | 5/5 | 234.7s | 11.6s | N/A |
| release | turso | codex | gpt-5.6-terra | 2 | 5/5 | 100.00% | 100.00% | 5/5 | 379.0s | 9.4s | N/A |
| release | turso | codex | gpt-5.6-terra | 3 | 5/5 | 100.00% | 100.00% | 5/5 | 285.8s | 11.5s | N/A |
| release | cockroachdb | claude-code | claude-sonnet-5 | 1 | 7/7 | 100.00% | 100.00% | 7/7 | 174.1s | 1.6s | $0.750 |
| release | cockroachdb | claude-code | claude-sonnet-5 | 2 | 7/7 | 100.00% | 100.00% | 7/7 | 211.6s | 1.1s | $0.962 |
| release | cockroachdb | claude-code | claude-sonnet-5 | 3 | 7/7 | 100.00% | 100.00% | 7/7 | 193.1s | 1.3s | $0.949 |
| release | insforge | claude-code | claude-sonnet-5 | 1 | 6/6 | 100.00% | 100.00% | 6/6 | 158.6s | 1.4s | $0.677 |
| release | insforge | claude-code | claude-sonnet-5 | 2 | 6/6 | 100.00% | 100.00% | 6/6 | 193.0s | 1.3s | $0.867 |
| release | insforge | claude-code | claude-sonnet-5 | 3 | 6/6 | 100.00% | 100.00% | 6/6 | 144.0s | 1.1s | $0.610 |
| release | neon | claude-code | claude-sonnet-5 | 1 | 7/7 | 100.00% | 100.00% | 7/7 | 232.2s | 1.5s | $0.938 |
| release | neon | claude-code | claude-sonnet-5 | 2 | 7/7 | 100.00% | 100.00% | 7/7 | 202.1s | 1.2s | $0.847 |
| release | neon | claude-code | claude-sonnet-5 | 3 | 7/7 | 100.00% | 100.00% | 7/7 | 216.1s | 1.1s | $0.958 |
| release | nile | claude-code | claude-sonnet-5 | 1 | 6/6 | 100.00% | 100.00% | 6/6 | 242.4s | 1.4s | $0.991 |
| release | nile | claude-code | claude-sonnet-5 | 2 | 6/6 | 100.00% | 100.00% | 6/6 | 160.7s | 1.3s | $0.788 |
| release | nile | claude-code | claude-sonnet-5 | 3 | 6/6 | 100.00% | 100.00% | 6/6 | 117.6s | 1.4s | $0.552 |
| release | turso | claude-code | claude-sonnet-5 | 1 | 5/5 | 100.00% | 100.00% | 5/5 | 170.2s | 1.7s | $0.735 |
| release | turso | claude-code | claude-sonnet-5 | 2 | 5/5 | 100.00% | 100.00% | 5/5 | 151.3s | 1.1s | $0.651 |
| release | turso | claude-code | claude-sonnet-5 | 3 | 5/5 | 100.00% | 100.00% | 5/5 | 223.4s | 1.2s | $0.910 |
| release | supabase | codex | gpt-5.6-terra | 1 | 7/7 | 100.00% | 100.00% | 7/7 | 264.2s | 18.5s | N/A |
| release | supabase | codex | gpt-5.6-terra | 2 | 7/7 | 50.00% | 66.67% | 7/7 | 330.2s | 10.2s | N/A |
| release | supabase | codex | gpt-5.6-terra | 3 | 7/7 | 100.00% | 100.00% | 7/7 | 265.5s | 14.6s | N/A |
| release | supabase | claude-code | claude-sonnet-5 | 1 | 7/7 | 100.00% | 100.00% | 7/7 | 189.3s | 1.2s | $0.859 |
| release | supabase | claude-code | claude-sonnet-5 | 2 | 7/7 | 100.00% | 100.00% | 7/7 | 154.5s | 1.1s | $0.729 |
| release | supabase | claude-code | claude-sonnet-5 | 3 | 7/7 | 100.00% | 100.00% | 7/7 | 218.3s | 1.3s | $0.922 |
| appendix | cockroachdb | opencode | openrouter/z-ai/glm-5.2 | 1 | 7/7 | 100.00% | 100.00% | N/A | 502.5s | 3.0s | N/A |
| appendix | cockroachdb | opencode | openrouter/z-ai/glm-5.2 | 2 | 7/7 | 100.00% | 100.00% | N/A | 567.2s | 3.1s | N/A |
| appendix | cockroachdb | opencode | openrouter/z-ai/glm-5.2 | 3 | 7/7 | 100.00% | 100.00% | N/A | 497.2s | 3.1s | N/A |
| appendix | insforge | opencode | openrouter/z-ai/glm-5.2 | 1 | 6/6 | 100.00% | 100.00% | N/A | 509.5s | 2.7s | N/A |
| appendix | insforge | opencode | openrouter/z-ai/glm-5.2 | 2 | 5/6 | 100.00% | 90.91% | N/A | 569.5s | 2.9s | N/A |
| appendix | insforge | opencode | openrouter/z-ai/glm-5.2 | 3 | 5/6 | 100.00% | 90.91% | N/A | 824.7s | 3.0s | N/A |
| appendix | neon | opencode | openrouter/z-ai/glm-5.2 | 1 | 7/7 | 100.00% | 100.00% | N/A | 678.8s | 3.6s | N/A |
| appendix | neon | opencode | openrouter/z-ai/glm-5.2 | 2 | 7/7 | 100.00% | 100.00% | N/A | 408.3s | 2.8s | N/A |
| appendix | neon | opencode | openrouter/z-ai/glm-5.2 | 3 | 7/7 | 100.00% | 100.00% | N/A | 867.4s | 3.6s | N/A |
| appendix | nile | opencode | openrouter/z-ai/glm-5.2 | 1 | 6/6 | 100.00% | 100.00% | N/A | 579.6s | 4.9s | N/A |
| appendix | nile | opencode | openrouter/z-ai/glm-5.2 | 2 | 6/6 | 100.00% | 100.00% | N/A | 407.5s | 3.5s | N/A |
| appendix | nile | opencode | openrouter/z-ai/glm-5.2 | 3 | 6/6 | 100.00% | 100.00% | N/A | 612.7s | 3.3s | N/A |
| appendix | turso | opencode | openrouter/z-ai/glm-5.2 | 1 | 5/5 | 100.00% | 100.00% | N/A | 479.6s | 2.8s | N/A |
| appendix | turso | opencode | openrouter/z-ai/glm-5.2 | 2 | 3/5 | 100.00% | 75.00% | N/A | 589.2s | 3.9s | N/A |
| appendix | turso | opencode | openrouter/z-ai/glm-5.2 | 3 | 5/5 | 100.00% | 100.00% | N/A | 728.4s | 3.7s | N/A |

## Interpretation boundary

- Provider-oracle task success remains the primary behavioral metric; AX is a secondary harmonic composite of usability and cell-level discovery.
- Discovery was observed once before each cell's task batch, not independently for every task.
- Latency is complete cell wall time. Per-task latency is only an aggregate normalization, not independently timed task latency.
- `N/A` cost means the harness did not report cost. It does not mean zero cost, and no list-price estimate is substituted.
- OpenCode GLM 5.2 is a comparative appendix and is not pooled into the release total.

## Recommendations

1. Publish provider-oracle usability as the primary result, with discovery, strictness, latency, and reported cost as separate panels.
2. Keep OpenCode GLM 5.2 in a labelled comparative appendix until it is rerun under the exact release cohort policy.
3. Do not publish a cross-harness cost ranking until Codex and OpenCode provide observed cost telemetry; `N/A` is not zero.
4. Add task-level start/finish events in the next runner revision. Current latency is exact per cell, but per-task latency is only an aggregate normalization.
5. For the next pack revision, run discovery per task family or with isolated cold starts; the current once-per-cell discovery measurement remains relatively saturated.
