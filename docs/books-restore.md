# Arc Books — archive and restore

What a Books archive holds, and the recovery procedure proven end to end by the
RESTORE-01 acceptance scenario.

## The archive (`lib/services/books/export-contract.ts`, schema 34)

- One database snapshot (`capture_books_export_snapshot`) of every table in
  `EXPORT_TABLES` for one organization, so no table mixes revisions: the capture
  is one `stable` statement, and an entry committed while it runs is not in it
  (RESTORE-01 `background-archive`).
- **Bounded memory.** Documents are never held whole: each is streamed once to
  check its size and checksum against its record, then again straight into the
  gzip stream feeding an 8 MB-part multipart upload, base64-encoded as it goes and
  checked against the first pass. Verification before upload uses those
  digests; only payroll registers, which it re-reads, are held. The table capture
  is the one part held in memory, bounded by the company's records rather than its
  documents. A 240 MB document archives with under 96 MB of live memory growth
  (STORE-01 `large-document-archive`). The archive JSON and content hash are the
  same as when it was built whole.
- **Built in the background.** Requesting an export queues it
  (`requestBooksExport`); the `generate_books_export` outbox job builds it as the
  member who asked, with their export permission checked again. Each attempt is
  numbered and kept in `books_exports.attempts`: an attempt that died is recorded
  as interrupted when the next starts, a failure keeps its reason, each attempt
  writes its own object, and only the current attempt marks the archive ready
  after verifying and uploading it. The Books maintenance sweep fails an export
  whose job is gone, so none reads "generating" forever. The accountant package
  builds its archive inside its own request (`createBooksExportNow`).
- Each table carries a row count and checksum in the manifest;
  `verifyBooksExportBundle` rejects a missing table, changed rows, unsafe cents or
  an unsupported schema. Older schemas (2–17, 33) still verify; tables added in a
  later schema are simply absent from an older archive.
- **No secrets.** Taxpayer IDs stay in Vault: companies and payer companies carry
  last fours only, and the payer TIN's Vault pointer is stripped. Bank feed
  connections are archived without their credential reference or sync cursor;
  payment funding sources are restored disabled.

## Restore procedure

1. **Verify** the archive bytes (`scripts/verify-books-export.cjs`).
2. **Preflight** against the target schema's catalog
   (`scripts/preflight-books-restore.cjs`). It lists blockers (columns the target
   lacks, required values missing, broken relationships), external dependencies
   (organization, users) and `secretRecovery`: every vendor and company whose
   taxpayer ID must come back through the privileged Vault restore or a new W-9.
3. **Plan** with explicit identity mappings (`scripts/prepare-books-restore.cjs`).
   The plan never edits the archive; each change is recorded with its reason:
   generated columns recomputed by the target, funding sources disabled, bank
   feeds disconnected with a placeholder credential, older archives adapted (for
   example, one primary company owning every line before schema 33).
4. **Load** the plan's tables in one transaction with triggers off
   (`session_replication_role = replica`), excluding generated columns, then turn
   guards back on.
5. **Compare**: every archived table's checksum, the ledger tie-outs, and the saved
   statements of closed months must match the archive. The only expected
   differences are the plan's recorded changes.
6. **Reconnect and recover**: owners reconnect bank feeds; the Vault restore (or the
   company re-entering its EIN under Books → Taxes) brings back taxpayer IDs. Until
   then a 1099 filing file refuses rather than print a missing payer TIN.

After step 5 the company works normally: closed months stay closed, rerunning the
projector adds nothing, and new months are opened, billed, collected and closed.

## Documents in storage (STORE-01)

Proven against real storage: a document is private at both boundaries (storage
refuses an unsigned read, signed links expire, another organization gets none);
a stored path is never overwritten (`upload` with `upsert: false` is a
conditional write, and only the identical bytes count as already stored); each
version keeps its bytes as the current one moves; a background archive finishes,
downloads no-store and carries each document's exact bytes; and a document put
back from the archive at its manifest path keeps its checksum and privacy.

## Not covered yet

- An automated loader: step 4 is run by an operator from the plan.
