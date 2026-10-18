# Documents and file transfers

Implementation status: code complete in the workspace; database rollout and live storage acceptance are pending. No production migrations or test writes were performed.

## Uploads

`DocumentTransferProvider` lives in the authenticated app shell. Its IndexedDB journal is scoped to the current user and organization and retains file bytes, transfer identity and metadata across navigation and reload. Reloaded work starts paused. Two files run concurrently, with bounded multipart concurrency inside each transfer. Storage quota errors are surfaced before the picker dismisses the affected selection.

The browser adapter in `lib/files/upload-document-form.ts` preserves existing project upload callers while using the shared queue. Organization-only assets retain the server upload path. Attachment linking checkpoints the committed file identity before linking, so a link retry cannot duplicate an upload.

Direct uploads reserve a server transfer before sending bytes. Multipart recovery reconciles storage's part inventory, signs parts in batches and resumes with the same transfer identity. Single PUT requests use `If-None-Match: *`. Finalization validates object identity and size and uses an atomic database receipt. Incremental hashing bounds memory instead of loading another full-file buffer.

Expired transfer cleanup runs through the existing outbox seven days after reservation. Version deletion records durable tombstones and queues object cleanup; committed references are protected from cleanup and retired storage identities cannot be reused.

## Mutations and views

Move, archive and restore use `document-mutations.ts` and transactional RPCs. Ten-minute Undo receipts preserve prior folder, sharing and archive state. Undo refuses to overwrite a newer edit. Moves optimistically hide selected rows until the authoritative refresh completes. View generations reject responses belonging to an older folder or filter.

Destination browsing loads children independently of the main Documents list. Folder search is server backed. Version commits and promotions invalidate search and previews atomically; asynchronous artifact patches require the matching storage path. Viewer URL caches include the current storage revision.

## Downloads and exports

Single-file downloads use a same-origin authorized attachment redirect. ZIPs stream bytes with backpressure rather than buffering every selected file. Selections larger than 100 files or 500 MiB use a durable export, capped at 500 files and 3 GiB. Export attempts have leases and separate output paths, recheck access, and expire after 24 hours. Browser receipts resume status polling and offer a Download action when ready.

The shared outbox worker handles `export_documents`, `cleanup_document_export`, `cleanup_document_transfer`, and `delete_file_blob`. Existing outbox scheduling must remain enabled.

## Release requirements

Approve and apply these migrations in repository order before releasing dependent application code:

1. `20261003004606_documents_integrity.sql`
2. `20261003004906_document_mutation_undo.sql`
3. `20261003004921_document_upload_transfers.sql`
4. `20261003010150_document_exports.sql`

Verify R2 CORS permits the application's origins, PUT request headers including `If-None-Match` and content type, and exposes `ETag` for multipart recovery. Do not use a blanket database push: unrelated migrations may also be pending in this workspace.

Verification on 2026-10-02: `pnpm test:documents` passed 94 tests with no failures or skips. The isolated browser fixture passed navigation, reload recovery, pause/resume, retry and cancellation without backend requests. Run `pnpm test:documents` and `pnpm test:documents-ui`; CI includes both. The browser fixture uses real queue/provider components and IndexedDB with deterministic transport mocks, including desktop/light and mobile/dark screenshots. The SQL tests execute migrations against isolated PGlite fixture schemas; they do not substitute for migration validation against a complete disposable Supabase schema.

Focused Documents lint passes. The final repository-wide TypeScript check reports an unrelated Books error in `lib/services/books/wip-review.ts:60` (`"create"` is not a supported audit action); repository-wide lint also reports unrelated mobile workspace `module` variable errors. An earlier full TypeScript run passed before concurrent workspace changes.

Before rollout, execute the migrations in a disposable Supabase instance and run acceptance with approved test credentials: interrupted multipart transfer, lost finalization response, concurrent version promotion/deletion, Undo after a conflicting edit, stale preview completion, export worker interruption, export expiry, and actual R2 CORS. Measure upload/download throughput and move acknowledgement p50/p95 against the same fixture sizes before and after release; production performance has not been measured.
