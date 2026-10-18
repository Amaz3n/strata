# Drawings lifecycle implementation — 2026-10-01

Status: IMPLEMENTED / RELEASE PENDING. Reviewed changes are integrated into the user workspace; 72 copied files were independently hash-verified. No deployment or production migration has been performed.

## Delivered scope

Approved plans 003–012 are implemented together:

- Shared upload controls for drawing packages and single-sheet replacements, including pause/resume/cancel, persisted operation receipts, cross-tab ownership, bounded multipart concurrency, batched signing and recovery without retransferring completed parts. The unreachable old upload wizard and duplicate progress state were removed.
- Upload reservation before transfer, immutable generation-specific object paths, fingerprint/size/ownership checks and atomic file/revision/job registration. Retries return the committed result. Expired reservations rotate paths; cancellation distinguishes an already registered revision from a cancelled upload. Existing document-library sources remain supported.
- Owned worker leases, heartbeat/recovery, release of unstarted jobs, stale-write fencing, visible terminal failures and manual retry that preserves single-sheet targets and completed page work.
- Transactional bulk deletion/discard with durable receipts, followed by bounded asynchronous storage cleanup. Cleanup handles more than 1,000 objects, partial failures, independent retry/backoff, shared references, abandoned native uploads and late writes to retired generations.
- Atomic publication of current pointers, required follow-up jobs, audit/event records and replay receipts; a scoped live register replaces global materialized-view refreshes. Obsolete refresh enqueue calls were removed; old queued refresh jobs retain a compatible no-op RPC.
- Progressive review while independent identity verification runs. Confirmed human edits survive late AI results. Publication checks identity decisions, full page coverage and complete rendered artifacts in the database.
- Exact page/renderer fingerprints and organization-scoped immutable artifact reuse. Unsupported PDF features use the original source rather than unsafe stripped-page reuse.
- Supported PDF splitting reads/opens the source once per attempt, registers at most eight pages per transaction with a 32 MiB batch-flush threshold (an individual oversized page can exceed that threshold). Page work is durable before upload and retries retain committed work. Large/unsupported sources retain the legacy fallback.
- Redacted lifecycle metrics, deterministic failure fixtures, mandatory database test dependencies and an isolated browser CI gate.

## Verification

- Full TypeScript check: passed in both the isolated checkout and integrated workspace.
- Full drawings suite: 258 tests passed in both the isolated checkout and integrated workspace, zero failed and zero skipped, including the final targeted-retry and 300-page render-reuse regressions.
- Browser fixtures: passed actual review dialog and shared upload hook, progressive keyboard confirmation, late AI preservation, incomplete-manifest publication blocking, pause/resume, cancellation races, two-tab ownership, lost registration response with no repeat PUTs, and single-sheet replacement. Live backend requests are blocked.
- Database fixtures execute the new SQL in local PGlite, including upload/publication/deletion transactions, org isolation, expired ownership, artifact retirement/reference safety, deleted-page coverage and retry behavior. These do not substitute for the full migration-chain release gate.
- Actual page-handler reuse fixture: a supported 300-page replacement adopts 299 existing artifacts and performs one native render. Tests also reject reuse for changed text, image, font, crop, rotation or renderer recipe, and conservatively decline unsupported PDF features.
- Cleanup fixtures cover 2,501 objects, bounded batches, storage failures, fair retries and protection of referenced originals.
- Full repository lint: blocked by 10 unrelated `@next/next/no-assign-module-variable` errors in concurrent mobile workspace files/tests. Drawing-only lint passed for all task source and fixtures.
- Synthetic benchmark: [saved raw report](drawings-synthetic-benchmark-2026-10-01.json). Apple M4 Max, Node 22.22.0, three samples each for 1/24/25/300-page synthetic PDFs; storage and database are in-memory doubles, network blocked. Each supported split uses one source download/open. The 300-page case uses 38 registration calls rather than one per page. Timings and process RSS are fixture measurements; production latency, production render memory and storage throughput remain unmeasured. No claimed production speedup or two-second p95 guarantee.

Reproduce with `pnpm test:drawings`, `pnpm test:drawings-ui`, `pnpm benchmark:drawings` and `pnpm typecheck`. Browser verification requires installed Playwright Chromium. CI also checks the six-assertion pgTap lifecycle file is present and executed, then runs the full database suite.

## Preservation and integration

Implementation checkout: `/Users/agustinzenuto/.codex/worktrees/drawings-lifecycle/arc`.
User workspace: `/Users/agustinzenuto/Desktop/Projects/arc`.

The checkout includes the user's uncommitted baseline. Integration is based on content hashes, not the raw Git diff: initial `/tmp/arc-drawings-implementation-baseline.json`, refreshed `/tmp/arc-drawings-integration-baseline.json`, and reviewed `/tmp/arc-drawings-integration-manifest.json`. Concurrent preconstruction, floorplan, financial and iOS changes are preserved. Package/workflow changes retain preconstruction/floorplan commands and the existing PGlite dependency. Credentials, `.env*`, `.mcp.json`, `.git`, `.codex`, `.aws`, `supabase/.temp`, generated outputs and dependencies are excluded. All 72 reviewed files were copied and their hashes verified, with no new conflicts. Pre-copy backups are at `/tmp/arc-drawings-integration-backup-20261001-130054`; the exact before/after records are `/tmp/arc-drawings-pre-copy-manifest.json` and `/tmp/arc-drawings-post-copy-manifest.json`. No commits or pushes were made.

## Unapplied migrations and release gates

Nine additive migrations were authored:

- `20261001121920_drawing_job_leases.sql`
- `20261001122054_drawing_upload_operations.sql`
- `20261001123000_drawing_page_artifacts.sql`
- `20261001124849_drawing_storage_cleanup.sql`
- `20261001124901_drawing_publication_receipts.sql`
- `20261001124910_drawing_current_register.sql`
- `20261001162622_drawing_artifact_guards.sql`
- `20261001162632_drawing_split_manifest.sql`
- `20261001164202_drawing_split_registration.sql`

`CLAUDE.md` requires human approval before applying migrations. None has been applied to Supabase. Docker was unavailable, so the full disposable Supabase migration-chain/pgTap gate remains pending in CI. The build is CI-only under repository instructions. Production configuration has not been used for tests.

Release order: pass the full disposable migration/build gates; obtain migration approval; drain old drawing workers; apply the reviewed additive schema in order; deploy compatible consumers; restore the drawing job schedule and verify in the dedicated QA org. Test interrupted transfers, lost acknowledgements, concurrent publication/deletion, worker termination and native storage cleanup in that environment. Confirm multipart lifecycle configuration and measure production-like memory/latency before asserting performance budgets.

Rollback must retain operation receipts, generation records, tombstones and compatibility RPCs. Do not drop the new schema or re-enable unfenced old workers against active new operations. Prefer a compatible application rollback or a forward fix after draining workers. Original library PDFs and legacy derived files without provable ownership are deliberately retained; automatic historical backfill, estimate resynchronization and markup destruction were not introduced.
