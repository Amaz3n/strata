# Closeout preparation and read authority

Local implementation verified 2026-10-05. E09-03 and release acceptance remain open.

Opening Closeout now reads the actual home's package without creating records. An unprepared or partially prepared new checklist shows an explicit Prepare checklist action to an authorized writer; readers see why preparation is required. Failed preparation remains visible and retryable. Existing requirements remain inspectable during partial preparation; further item edits wait for preparation to finish. New package/default IDs are stable and inserts ignore primary-key conflicts, preserving completed progress, owners, notes and existing requirements on retry. Legacy packages retain their existing requirements.

The original closeout service owns preparation and item creation. The thin server action validates the home ID and revalidates its page. Item creation verifies supplied package organization/home ancestry before inserting. Close readiness now authorizes the actual home before financial reads. The page no longer converts failed GMP financial evidence into an absent panel. Readers cannot add, change status, edit details or upload/detach through Closeout controls. Final waiver status stays derived from the waiver register.

The final local checks passed: 15 focused service/actual-SDK/React tests, 1,639 authorization regressions, 3,386 financial regressions, typecheck, lint and diff check. The compiled field browser fixture passed read-only controls, explicit preparation, pending state, failed preparation without refresh, same-home retry, confirmed success refresh and existing draft/stale-attachment/project-change checks. These are isolated transports and fixtures, not authenticated database QA. The financial suite contained the initial 12 focused cases; the final focused and authorization runs include the three added readiness/SDK/partial-display cases.

The existing browser fixture needed explicit inspection writer capability and isolation of the new inspection lifecycle action import. The original assertions remain intact. Initial lint/build/listen/writer-fixture failures are retained with the successful results in [the evidence manifest](evidence/2026-10-05-closeout-preparation/manifest.json).

The acceptance infrastructure was revalidated first. Existing Docker probe session 20780 remains live with no output. Read-only process inspection found its CLI waiting on Docker AI plugin metadata. Bypassing the CLI, the local version socket returned HTTP 200 and zero body bytes; the bounded readiness probe correctly rejected it. No existing process/container was restarted and no migrations or database writes were performed. F02 still needs a proven disposable database, full applicable schema, current JWT/RLS and independent sessions.

## Remaining acceptance

- No full-schema/current JWT/RLS, independent PostgreSQL sessions or authenticated customer/persona QA; no release acceptance.
- Package/default inserts and best-effort audit remain separate requests. Transaction-bound current permission/ancestry, original immutable receipt/event/audit co-commit and legacy writer cutover remain open.
- Stable primary-key conflict-ignore retries do not establish database uniqueness across legacy writers using random package IDs; duplicate existing packages surface as errors.
- Legacy packages retain their original requirements; historical incomplete defaults require governed reconciliation, not title-based completion or silent read repair.
- Closeout item/readiness/attachment collections still need complete bounded discovery and accurate whole-scope exports/counts.
- Required inspection acceptance is not yet enforced across every generic closeout completion writer/export; file upload/link recovery remains separate.
- Production/home hierarchy, search, mobile, reports, provider fanout, accessibility/dark/device QA and customer-specific close policies remain open.
