# Suite audit autofix notes

- Applied at: 2026-07-09T13:16:57.889Z
- Findings: 0e / 0w / 0i

Mapping / coverage autofixes require re-running:

```bash
npm run ax-eval -- synthesize-suite --category database --out benchmarks/daeb/v1/suite.yaml --deterministic --task-count 10
npm run ax-eval -- audit-suite --suite benchmarks/daeb/v1/suite.yaml
```

