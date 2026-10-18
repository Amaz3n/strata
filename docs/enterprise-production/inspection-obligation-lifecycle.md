# Inspection obligation and accepted-attempt lifecycle

Date: 2026-10-04. Contract: E09-03.INSPECTION-CLOSING-CONTRACT in the existing national-builder goal. This is staged implementation with local evidence. No task, scenario or release gate is accepted from it.

## Owning workflow

The existing inspection service and workbench own the workflow. There is no feature flag (`INSPECTION_LIFECYCLE_ENABLED` is removed); the lifecycle is always on: the atomic completion branch, required-inspection reads (closing readiness calls `read_inspection_closing_readiness` unconditionally) and lifecycle controls run for every home, and organization tier never gates access.

A writer opens an inspection and selects **Require before closing**. The obligation binds that original home, inspection and reviewed source. Each attempt retains its own checklist. Completion records the original source, actor, result, event and audit in one SQL transaction. A failed or partial attempt does not complete its scheduled work. A passing required attempt remains pending an independent review.

For deficiencies, the original punch owner remains the corrective-work owner. Read-only inspection users can inspect links but do not receive corrective actions. Writers can create corrective work from a completed deficient item without changing its original responses or attachments. They resolve the linked punch work, document corrective evidence and select **Start reinspection**. The RPC checks the reviewed failed-item/punch associations, locks the actual current records, captures their resolved evidence and clones the original prompts into a new attempt with empty answers. It does not substitute an unrelated passing inspection or erase a failure.

Corrective work is raised by `raise_inspection_corrective_work` (migration `20261016100000_inspection_corrective_work_link.sql`): one transaction creates the owned punch item, links it to the failed inspection item, attaches the before photo and writes the event and audit, so a link can no longer exist without its punch item or the reverse. Members cannot write the link directly. Prior attempts are retained. A guard on `punch_items` (`20261016110000_inspection_punch_write_guard.sql`) requires `punch.write` and after-evidence before inspection-linked work that needs verification can close, which closes a bypass found from the review path. Legacy failed inspections received a non-gating obligation backfill. Both migrations are pending production approval.

An independent actor with organization and actual-home `inspection.review` authority documents acceptance or further correction. Acceptance records the decision and advances only the same home's noncancelled linked schedule slot. A rejected passing attempt can have a linked replacement. Accepted obligations retain their original attempt and review identities. Current required obligations are checked in the existing closing-readiness service and at the SQL closing transition; reopened or unavailable corrective work, changed source or missing receipt evidence cannot satisfy that check.

## Transaction and recovery boundary

The staged SQL uses locked current actor/membership/role/override/division facts, actual home serialization, obligation ownership, then the attempt and its ordered checklist/punch records. Receipt/event/audit changes and domain state share the same statement transaction. Completion is naturally identified by inspection ID. Lifecycle requests carry a UUID and exact original body; a committed request's key cannot be reused for another body, actor or scope. Recovery of a recorded lifecycle outcome remains readable after a later closing.

The client retains an uncertain request and retries that same key/body despite refreshed source props. Confirmed PostgreSQL aborts allow reviewing fresh evidence with a new request. This retention is currently in component memory, not reload-persistent storage or a durable pre-commit intent registry. It must not be claimed as complete lost-reply recovery across a reload. Completion's stored actor is preserved on retry; full original-actor recovery policy remains subject to acceptance.

Completed inspection and checklist evidence is protected by database triggers, including generic status updates and child edits. Downstream punch/observation links remain separate from immutable checklist responses. Schedule updates have a deferred proof check for bound obligations. Photo and corrective-punch home ancestry are checked. No generic authenticated/service table mutations are granted for the new lifecycle tables; RPC entry points enforce current actor identity and scope.

Required-obligation discovery uses bounded keyset pages; the selected attempt resolves its obligation independently of the current page. Each page exposes the latest five attempts and their total count. Complete intermediate-attempt history paging remains open. Original inspection/deficiency list completeness is also still a separate unresolved E09 requirement.

## Local evidence and unresolved acceptance

The isolated PGlite fixture executes this candidate migration and original RPCs. It exercises failure → resolved corrective work → passing reinspection → independent acceptance → closing; rejected review replacement; original history; receipt/event/audit rollback; stale source and corrective association; membership/permission/division failures; session actor mismatch; raw completion/schedule bypass; bounded discovery; reopened work; altered audit evidence; and same-request recovery. The real Supabase SDK transport and actual React declarations separately exercise role controls, exact request bodies, uncertain retries, selected-attempt reads and closing-service rejection. These fixtures are deliberately partial-schema and sequential.

Required before release:

- Review/apply the migration through the human-controlled release process; run the full compatible schema chain and current JWT/RLS tests in an isolated QA environment.
- Exercise independently concurrent actor revocation, home movement, source/child writes, obligation insertion versus closing, competing completion/review and lock-order/deadlock recovery. Sequential PGlite is not concurrency acceptance.
- Reconcile legacy completed inspections into governed original evidence before they can be required or accepted; do not fabricate completion receipts or silently trust historical status alone.
- Finish durable original-request inspection/recovery across reloads, complete intermediate attempt history, mobile/portal contracts, archive/restore, search, notification/outbox fanout and essential reports. New SQL activity records currently have titles but are not proof of notification delivery.
- Corrective punch creation and linking now share one transaction (see above); assignment, dispatch and accepted resolution recovery remain subject to acceptance.
- Exercise authenticated coordinator, inspector, independent reviewer and reader flows, accessibility/dark/mobile layouts, physical field devices and representative builder-scale performance.
- Validate template response semantics and customer policies, required-obligation/permit population and source-version expectations. The candidate does not establish that every required real-world inspection or permit is registered. A fail response cannot become a pass merely by clearing its deficiency flag.

The candidate migration is `supabase/migrations/20261005031540_inspection_obligation_lifecycle.sql`. It has not been applied. Existing production credentials were not used for mutation tests. Docker acceptance probe session 20780 was re-polled and remained live without output; that is not full-schema availability proof.
