# DAEB V2.2 Native Journey Pilot

V2.2 is a bounded construct-validity pilot. It does not replace or modify the
immutable V2 baseline, and it is not part of the unfrozen V2.1 calibration.

The pilot asks one question: can an agent, given only a vendor, a desired
outcome, sandbox boundaries, and credential environment-variable names,
discover a vendor's recommended terminal-operable path, connect to the correct
sandbox, complete a stateful operation, and recover from a harmless stale
target hint?

The agent may choose an official CLI, API, SDK, or SQL client. The prompt does
not reveal a binary, command, endpoint, or documentation URL. Outcome-equivalent
vendor adapters use independent live-state read-back and exact-scope cleanup.

Initial calibration is deliberately small:

- six vendors;
- Pi only;
- pinned Gemini 3.7 Flash through the local OpenRouter enforcement gateway;
- one trial;
- one end-to-end session per vendor;
- four separately reported stages: discovery, connect, operate, recovery.

The first diagnostic is complete; see [`PILOT_RESULT.md`](./PILOT_RESULT.md).
All six journeys ultimately passed, so the preregistered non-unanimous-stage
gate did not pass. The run also exposed and repaired a transcript-persistence
redaction defect. A clean Gemini replication with zero invalid JSONL lines is
required before any additional model is admitted.

A passing task outcome never repairs missing discovery evidence, and a
discovery miss never changes the independent world-state usability result.
