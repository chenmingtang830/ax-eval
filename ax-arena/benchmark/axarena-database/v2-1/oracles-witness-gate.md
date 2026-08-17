# V2.1 oracle and witness gate

Status: **blocked; no V2.1 pack approval**.

The existing DAEB v2 packs and 51-cell witness evidence remain immutable
baseline artifacts. They are not silently promoted into V2.1. V2.1 now has
independent task-specific witnesses for all task-fit-admitted candidate tuples
plus full support/readiness accounting. Lower-coverage research concepts are
explicit structural N/A/non-admitted entries.

Current deterministic audit facts:

- `audit-suite` reports zero errors and zero warnings after the negative-query
  candidate and witness were added.
- The delegated trace-review checkpoint is complete (`10/10` sample ids);
  independent human sign-off, if required for publication, is still separate.
- The candidate support matrix and draft packs are aligned for all admitted
  task-fit tuples; lower-coverage concepts remain explicit N/A.
- 12/16 candidates currently have complete strict verifier-ready evidence for
  every task-fit-admitted tuple; the remaining five research concepts are
  below the five-of-six gate and are structural N/A/non-admitted.

Required before freeze:

1. Review and approve the six CLI-only V2.1 draft packs generated from the
   refreshed inventories.
2. Reconfirm the independent read-back oracle, exact-scope cleanup, and
   deterministic controller fixture for every admitted vendor/task tuple.
3. Retain the witness matrix; any invalid or inconclusive tuple stays visible
   and cannot be converted to `structural-na` by omission.
4. Retain the completed delegated trace review and, if publication requires an
   independent human reviewer, obtain that separate sign-off.
5. Hash the resulting docs, support, oracle, witness, calibration, and review
   artifacts into `freeze-gates.json`.

Until those steps pass, `freeze-suite` must not be invoked with invented gate
hashes and no `pack.approval.json` should be created for V2.1.
