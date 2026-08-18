# V2.1 calibration gate

Status: **blocked; no calibration result exists**.

The registered calibration lane is Pi, trial 1, with Gemini 3.7 Flash and
DeepSeek V4 Flash 0731. It also requires GLM 5.2 as a holdout. The current
route preflight records:

- `google/gemini-3.7-flash-20260813` → Google Vertex: passed after the explicit
  `data_collection: allow` policy was injected by the controller.
- `deepseek/deepseek-v4-flash-20260731` → DeepSeek: OpenRouter returned
  `404 No endpoints available matching your guardrail restrictions and data policy`.
- GLM `z-ai/glm-5.2-20260616` passed the no-write route probe in Pi and
  OpenCode, but it cannot substitute for either registered calibration model.

There is intentionally no `observations.jsonl` or `selection-v2-1.json` in
this directory. Creating either from missing/failed route data would turn an
external route failure into fabricated calibration evidence. The formal
command remains:

```text
npm run ax-arena -- benchmark calibrate-suite \
  --candidate-suite axarena-database/v2-1/candidate-suite-v2-1.yaml \
  --results <calibration-root>/observations.jsonl \
  --target-count 10 \
  --out axarena-database/v2-1/selection-v2-1.json
```

Once the DeepSeek workspace guardrail is repaired, populate one Pi trial per
registered model and candidate task, retain invalid observations, and rerun the
command. Gemini and GLM route evidence is already present but is not calibration
evidence.
