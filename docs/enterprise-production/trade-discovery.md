# Trade look-ahead discovery and dispatch

Locally implemented and verified 2026-10-05. E07-03 and release acceptance remain open.

The original Trade look-aheads page now uses the ambient community/division, searchable group summaries, group pagination and separately selected task pagination. Browser payloads contain at most 50 group summaries and 50 tasks, with whole-group task/confirmation counts. Selected detail loads independently of the group page/search. Unavailable selections have a visible return-to-list path. URL navigation preserves reviewed search/window/page; changing actor/org/scope remounts client state. Keyboard links open groups and canonical home schedule items.

Readers have no Send control. The original ActionResult action validates company/window/community/division inside its error wrapper. The existing service receives reviewed community/division, applies current division access and sends all company trades in that scope/window. The UI states that scope, preserves pending/failure feedback and distinguishes provider-accepted sending from an existing daily dispatch record. This does not establish exactly-once delivery or a recoverable dispatch transaction.

Schedule, PO fallback and contact reads now use the existing ID-keyset exhaustion helper; a provider returning fewer rows cannot silently end history. Each page reapplies source predicates, exhaustion requires an empty response, cap/errors propagate, and schedule detail order remains date/id. Whole-source aggregation remains in memory; bounded DTOs are not enterprise server capacity acceptance.

Verification passed: 17 focused original service/action/actual-SDK cases, 1,672 authorization regressions, 96 Starts regressions, 27 schedule regressions, typecheck, lint and compiled browser fixture. The browser exercises reader controls, keyboard focus/canonical links, reviewed dispatch arguments, pending state, failed delivery without refresh, prior-record feedback and accepted-send refresh. The initial sandbox listener failure and successful approved loopback run are retained. No production writes/provider sends, migrations or deployment occurred.

## Remaining acceptance

- Full-schema/current JWT/RLS, actual-home/assignment authority and independent revocation/parent-move/concurrent-edit races remain unproven.
- Browser DTOs are bounded, but original service still collects up to 100,000 schedule rows and per-reference PO rows before grouping/search. Database aggregation, server query plans, measured SLOs and snapshot-safe pagination remain open.
- Schedule/PO/contact keyset reads exhaust empty sources and surface caps/errors, but embedded child completeness must be proven against real PostgREST/schema.
- Dispatch still reads sent events before sending and records event/audit after provider acceptance. Atomic intent/claim/exact-body receipt, ambiguous provider responses, cancellation and durable recovery are missing.
- Existing daily company-level suppression can suppress another scoped notice on the same day; reviewed-scope delivery policy and legacy-writer cutover need explicit contract/acceptance.
- No authenticated browser/device, full accessibility/dark/mobile, customer policy, archive/restore or delivery sandbox acceptance. No production sends, migrations or deployment.

Durable evidence.
