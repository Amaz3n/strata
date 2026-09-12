# Daily Logs redesign and rollout

The default experience opens today with an inline note composer. Attachments and structured details are optional. Activity shows one attributed contribution at a time, with replies collapsed. History is a collapsible desktop panel and a mobile sheet; it uses month summaries, search within the month's notes, and a date jump. Historical dates offer an explicit Add log action; submitted dates offer Add addendum.

There is one workspace per day. Day details expands inline for conditions, crews, previous-day carry-forward, optional report fields, submission, sharing, and PDF export. It does not repeat logs, work entries, photos, replies, or date navigation. Saved logs flow into the report automatically. The old DayRecord screen and its separate note renderer, rollups, navigation, and completeness-ring UI have been removed.

The composer and activity feed stay mounted when details opens. Unfinished crew/section forms survive collapsing details. Submission is disabled while a log or day-details form is unfinished. Submitted-day additions are labeled Addendum in the same feed. Standalone site photos live in activity. The delay register opens as a separate project tool from the overflow menu; range export is in that menu too. Unlogged weekdays remain opt-in in history while day details is open.

## Performance changes

- Initial data is restricted to the selected day's logs, report, linked attachments, and a bounded timezone window of standalone photos.
- History requests use compact, month-scoped summaries. Context pickers, day details, delay data, exports, and the image viewer load when needed.
- Day reads use a seven-day, 60-second client cache, request deduplication, and preceding-day prefetch. Invalidations fence in-flight reads so uploads and edits cannot restore stale snapshots.
- Independent reads run together. GET reads and multipart POST uploads avoid the client server-action queue. Upload concurrency is limited to three.
- SQL saves atomically persist the contribution and linked work updates. Weather and notification delivery do not delay the save response.
- A scoped date index supports daily-log reads. Existing generated thumbnails are used when available.

These are structural improvements, not a measured latency claim. Browser timings and production query plans still need verification after rollout. The read API includes Server-Timing to support that check.

## Recovery

Drafts and upload queues persist per user and project. Submission IDs make uncertain save retries safe. Attachment IDs include content and target context, so restoring a cloned File after reload addresses the same upload. Completed uploads persist their acknowledgement before queue cleanup. Failed uploads remain visible and retryable.

## Verification on September 7, 2026

- The initial implementation passed the full TypeScript check. Subsequent unified-workspace checks reported unrelated waiver errors in `waiver-register-client.tsx` and `lib/services/lien-waivers.ts`, with no Daily Logs errors. The last full recheck was stopped after a prolonged run while other repository processes were active.
- Daily Logs lint and diff whitespace checks passed after the unified-workspace changes. Fourteen draft, cache, offline, and upload recovery tests were rerun and passed.
- 36 targeted tests passed, with no failures or skips, including isolated PGlite transaction tests, draft recovery, offline retries, cache races, email delivery, pagination, and upload replay.
- Repository-wide lint is blocked by existing `no-assign-module-variable` errors in `tests/payable-intake.test.js:32` and `tests/payable-upload-duplicates.test.js:15`.
- The real workspace, composer, day-details forms, and activity components were rendered in an isolated Chromium fixture with fake data and external network requests blocked. Desktop/mobile checks passed for single date navigation and log rendering, draft preservation across expansion, crew edit preservation, unfinished-form submission guards, submission/addendum/reopen, delay register, historical empty days, mobile history, dark mode, and no horizontal overflow or runtime errors.
- This browser check stubs authentication, backend calls, and the file viewer. It does not verify production API writes or PDF generation.
- No production writes, migration application, build, or deployment were performed during the UI implementation. The separately approved migration application is recorded below.

## Migration applied — September 8, 2026

The user explicitly approved applying `supabase/migrations/20260907213753_daily_log_atomic_submission.sql`. It was applied to the linked Arc production project `gzlfiskfkvqgpzqldnwk` through the Supabase connector after the isolated CLI dry run stalled. Only this migration was applied. The connector's generated version `20260908151423` was reconciled to repository version `20260907213753` and name `daily_log_atomic_submission`.

Verified after application:

- The `submission_id` UUID and `submission_payload` JSONB columns exist.
- Both the unique submission index and scoped date index are valid.
- The RPC body hash matches the reviewed file (`df68d147a9d78d9c3020dc13848f9fb1`).
- The RPC remains SECURITY INVOKER with an empty search path; anon/authenticated cannot execute it, while service_role can.
- The migration ledger contains the original repository version exactly once.
- Seven isolated transaction tests passed immediately before application.
- No customer test records were created, no application deployment was performed, and no migration/test processes remain running.

The database prerequisite for the new save action is now installed. End-to-end save, attachment retry, and addendum acceptance should still be verified in an explicitly authorized QA environment. Do not create test records through the local app's production Supabase connection.

## Save correction — September 8, 2026

A real save exposed an invalid `projects.address` reference in the original RPC. The isolated fixture incorrectly included this column, masking the error. Production uses a `location` JSONB column. The fixture now matches that shape and reproduced the reported failure before the correction.

Applied `20260908151828_daily_log_project_name_fix.sql` to production. The replacement RPC uses the project's name with a generic fallback and an organization-scoped lookup. The related application mention-notification lookup was corrected as well. All remaining referenced columns were checked against the live schema; none were missing. Seven isolated transaction tests and targeted lint passed.

The live function body matches the correction (`345c63d3b90dc5153d26af94415072da`), with SECURITY INVOKER and service-only execution preserved. The connector-generated migration version was reconciled to repository version `20260908151828`. No production test records were created.
