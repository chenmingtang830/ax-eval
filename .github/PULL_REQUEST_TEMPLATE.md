## Summary

- 

## Verification

- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run build` if release/build output could be affected
- [ ] Live eval not needed, or reason:

## Notes

- Tests must stay keyless and offline by default.
- Live evals make real writes; use a sandbox, never production.
- Generated packs are executable intent. Do not bypass the review gate in code.
- Do not include secrets, tokens, private workspace ids, or live run artifacts.

