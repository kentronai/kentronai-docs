
################ H2-core-runtime-api-sdk :: Documentation implications ################
## Documentation implications

### What to claim

* An append-only, hash-chained event log ("receipts") with canonical-JSON hashing, `verify`, replay by fold, time travel (`stateAt`), idempotent commands, optimistic concurrency, and metadata-only branching with rebase-on-read. All verified in `@receipt/core`.
* Postgres as the single durable store, per-tenant schemas derived from `DATA_DIR`, rebuildable projections, and (new) crash-safe projection scheduling with a trigger-fed outbox and versioned reducer checkpoints. Say "derived and rebuildable", not "always consistent"; the doc itself lists the remaining full-replay paths.
* A single runtime image with role-based workers, a durable dispatch layer (Resonate) whose ledger is best-effort beside authoritative receipts, and a documented HTTP/SSE/WebSocket surface (Section 5). Publish the deprecation of `/jobs/:id/wait`.
* Live browser sync of projections through Zero with server-side authorisation in queries and mutators, and the rule that every client-schema table must be published.
* A TypeScript SDK (`defineAgent`, `action|assistant|tool|human`, `merge`) with an explicit side-effect contract and durable invocation identity.
* Receipt-backed Factory audits that produce recommendations, memory summaries and reports, applied only by explicit operator action.
* Importing Claude Code transcripts as receipts and inspecting them (metrics, replay completeness, bounded evidence) on `/sessions` — while noting the page is currently reached by URL.

### What to avoid claiming

* Anything about datasets, labels, annotation, fine-tuning, retraining, or "model iteration". No code path produces or consumes such artefacts.
* Semantic memory search or embeddings; none is wired.
* Autonomous self-improvement, auto-fix, or policy mutation; the loop is recommendation-only by design.
* `agent-token` streaming, `/factory/events`, the extended `/healthz` fields, `/improvement/:id/validate`, or anonymous `/memory/*` routes.
* Framework adapters (CrewAI, LangGraph, AutoGen).
* That `receipt new` produces a runnable agent from the repository root.

### Marketing claims, graded

| Claim | Status | Reason |
|---|---|---|
| "Automatically transform production conversations into high-quality training datasets for rapid model iteration." | **unsupported** | No dataset writer, export route, or training artefact exists (Section 12.6). Conversations become receipts and projections, which serve replay and UI, not model training. |
| "Extract and label production conversations automatically for instant model retraining." | **unsupported** | No labeling or annotation code; the only "labels" are count-threshold statuses (`pass|watch|action`) on imported Claude Code sessions, and nothing retrains anything. |
| "Turn customer interactions into validated training data without manual annotation." | **unsupported** | Receipts are hash-verified (`verify()`, DST audit) and the Evidence panel exposes bounded event bodies, but "validated" here means chain integrity, not data-quality validation, and no training data is produced. |
| "Close the feedback loop: production insights powering continuous AI model improvement." | **partial** | A receipt-backed feedback loop exists for *Factory agent runs*: terminal objectives are audited, recommendations and memory summaries feed later task context, and the historical auto-fix feedback report scores whether a fix worked. It improves agent orchestration context, not the AI model, and applying a recommendation is a manual operator action. Claim "continuous feedback on agent runs" only if worded that way. |

### Suggested page split

1. **Receipt model** — Sections 1 and 2 (shape, context vs hints, canonical JSON, ids, verify, streams, branches, idempotency, concurrency, stream families).
2. **Storage and projections** — Sections 3 and 4 (tables, tenancy, pools, publication membership, durable projection work, what still replays fully, tuning knobs).
3. **Runtime API reference** — Section 5 (roles, conventions, every route with status codes and strings, deprecations; a one-line note that internal diagnostics exist and are token-gated).
4. **Live and durable layers** — Sections 6 and 7 (topics, events, keepalive, browser client; workflow/activity ledger and what is best-effort).
5. **Browser sync (Zero)** — Section 8.
6. **Web app API** — Section 9.
7. **SDK** — Section 10, with the scaffold caveat.
8. **Evaluation, simulation and audit** — Sections 12.2-12.5 (self-improvement loop, eval harness, DST corpus, memory), positioned as agent-run quality tooling.
9. **Sessions (imported Claude Code activity)** — Section 12.1, describing metrics/checks/replay/evidence and explicitly not promising lesson drafting until it executes.

---


################ J2-internal-docs-index :: Documentation implications ################
