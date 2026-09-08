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

These are structural improvements, not a measured latency claim. Browser timings and production query plans still need verification after the approved migration rollout. The read API includes Server-Timing to support that check.

## Recovery

Drafts and upload queues persist per user and project. Submission IDs make uncertain save retries safe. Attachment IDs include content and target context, so restoring a cloned File after reload addresses the same upload. Completed uploads persist their acknowledgement before queue cleanup. Failed uploads remain visible and retryable.

## Verification on September 7, 2026

- The initial implementation passed the full TypeScript check. Subsequent unified-workspace checks reported unrelated waiver errors in `waiver-register-client.tsx` and `lib/services/lien-waivers.ts`, with no Daily Logs errors. The last full recheck was stopped after a prolonged run while other repository processes were active.
- Daily Logs lint and diff whitespace checks passed after the unified-workspace changes. Fourteen draft, cache, offline, and upload recovery tests were rerun and passed.
- 36 targeted tests passed, with no failures or skips, including isolated PGlite transaction tests, draft recovery, offline retries, cache races, email delivery, pagination, and upload replay.
- Repository-wide lint is blocked by existing `no-assign-module-variable` errors in `tests/payable-intake.test.js:32` and `tests/payable-upload-duplicates.test.js:15`.
- The real workspace, composer, day-details forms, and activity components were rendered in an isolated Chromium fixture with fake data and external network requests blocked. Desktop/mobile checks passed for single date navigation and log rendering, draft preservation across expansion, crew edit preservation, unfinished-form submission guards, submission/addendum/reopen, delay register, historical empty days, mobile history, dark mode, and no horizontal overflow or runtime errors.
- This browser check stubs authentication, backend calls, and the file viewer. It does not verify production API writes or PDF generation.
- No production writes, migration application, build, or deployment were performed.

## Release dependency

`supabase/migrations/20260907213753_daily_log_atomic_submission.sql` is pending human approval. Apply this additive migration before releasing the application code: the new create action requires its RPC. Do not use a blanket database push because the workspace contains other unrelated pending migrations.

After approval and migration application, verify a log save, a replay of the same submission, attachment retry, and a submitted-day addendum in an explicitly authorized QA environment. Review desktop and mobile capture, history, inline day details, empty/error states, and local draft restoration. Do not create test records through the local app's production Supabase connection.
