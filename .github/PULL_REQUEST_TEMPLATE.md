## Summary

- 

## Verification

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build` if release/build output could be affected
- [ ] `npm --cache .npm-cache pack --dry-run` if publishable files changed
- [ ] Live eval not needed, or reason:

## Documentation / Artifacts

- [ ] README / command examples updated if user-facing behavior changed
- [ ] `SKILL.md` / `AGENTS.md` / `CONTRIBUTING.md` updated if agent or developer workflow changed
- [ ] `.env.example` / `targets/README.md` / pack approvals updated if target, auth, or surface behavior changed
- [ ] Examples, snapshots, or assets refreshed if report output changed

## Notes

- Tests must stay keyless and offline by default.
- Live evals make real writes; use a sandbox, never production.
- Generated packs are executable intent. Do not bypass the review gate in code.
- Do not include secrets, tokens, private workspace ids, or live run artifacts.
