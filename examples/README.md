# Examples

This folder holds shareable, self-contained HTML reports copied out of local
`results/runs/...` directories and given stable paths inside the repo.

Current examples:

- [Stripe four-surface cross-harness report](./stripe-four-surface-cross-harness.html)
  - `claude-code` + `codex`
  - `API / SDK / CLI / MCP`
  - useful for studying surface-aware MCP scoring and the full matrix story
- [Notion four-surface cross-harness report](./notion-four-surface-cross-harness.html)
  - `claude-code` + `codex`
  - `API / SDK / CLI / MCP`
  - useful for studying generated pack repair, run anomaly handling, and MCP gaps
- [Linear GraphQL cross-surface, cross-harness report](./linear-graphql-cross-surface-cross-harness.html)
  - `claude-code` + `codex`
  - `API / SDK / MCP`
  - useful for studying GraphQL pack behavior across multiple agent surfaces
- [Exa cross-harness, cross-surface report](./exa-cross-harness-cross-surface.html)
  - `claude-code` + `codex`
  - `API / SDK / MCP`
  - useful for studying agent-discovery gaps when task success is already high

If you are new to the project, read one of these reports before editing the
report pipeline. They show the intended output shape more clearly than raw run
artifacts inside `results/runs/`.
