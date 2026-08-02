# Platform Foundations Gameplan

> **Status: ACTIVE PLAN — intent, not a description of the system.**
> Nothing in this document is guaranteed to exist. Never infer current app
> behavior from it. Source of truth is the code, `CLAUDE.md`, and the
> reference docs at the `docs/` top level.

**Status:** Awaiting execution. Written 2026-07-31.
**Audience:** an LLM executor. Five foundation workstreams: durable pipeline
execution, temporal tables for money, Typst PDFs, the cheap-classifier AI tier, and
one multimodal embedding space. These are load-bearing infrastructure — correctness
bars are higher and rollout is stricter than feature work. STOP means stop and ask
the human.

---

## WS-T1 — Durable workflows: one execution substrate for the pipelines

### Ground truth (verified 2026-07-31 — the mess is specific)
- One shared `outbox` table, but THREE processing loops with inconsistent
  semantics:
  1. `app/api/jobs/process-outbox/route.ts` (20 hardcoded job types in an `.in()`
     literal): does NOT use the `claim_jobs` RPC (raw select + bulk update →
     race-prone under concurrent invocations) and has NO stale-processing reclaim —
     a crashed job of these types is stranded in `processing` forever.
  2. `app/api/accounting/process-outbox`: uses `claim_jobs`, has timeout reclaim.
  3. Drawings/specs/starts pipeline routes: `claim_jobs` + two-tier heartbeat
     (batch-level `setInterval` bumping claimed-not-started jobs + per-job 45s
     heartbeat) + stale reclaim (3 min drawings/starts, 5 min specs) + self-chaining
     via trigger fetch (`triggerDrawingsPipeline` — dev deliberately kicks
     localhost:3000).
- `claim_jobs(job_types[], limit)` RPC exists (FOR UPDATE SKIP LOCKED, priority
  desc) — migration `20260729190000_outbox_priority.sql`.
- Job-type registry is duplicated string literals across route files and
  `*_JOB_TYPES` consts; unknown types are failed on sight. Orphan literals with no
  handler: `send_proposal_email`, `payment_succeeded` (enqueued by the Stripe
  webhook — verify whether its handler was lost; if truly dead, delete the enqueue).
- ~Half of enqueues bypass `enqueueOutboxJob` with raw `.insert()` on outbox.
- Starts pipeline already implements the best pattern in-house: `start_release` is
  ONE job walking a persisted step ledger (`start_release_steps`, resume-past-
  completed on retry) — that IS a durable workflow, hand-rolled.

### Decision (made — implement this, not alternatives)
Do NOT adopt an external workflow engine (Temporal) and do NOT rewrite pipelines on
Vercel Workflow DevKit in one move. The pipelines' claim/heartbeat/chain machinery
works and just shipped (WS-F9 era). The plan: (A) unify the broken/weak parts on the
existing machinery NOW; (B) trial Vercel WDK on ONE new pipeline (the next one built
— splats or floorplan interpretation) and judge with a written verdict; (C) migrate
old pipelines only if the trial wins decisively. Reasoning: the risk today is
inconsistency, not architecture; a big-bang engine swap of working 3,000-line
pipelines is negative-EV.

### Phase A directives (unify semantics)
1. **Single job-type registry:** `lib/services/job-registry.ts` — one const object:
   `JOB_TYPES = { deliver_notification: { loop: 'general', maxRetries: 3, backoff:
   'exp5m', reclaimMinutes: 5 }, ... }` for ALL ~36 types (general 20 + accounting +
   3 pipelines). Every route derives its type list from `loop`; every `*_JOB_TYPES`
   const becomes a derived export from the registry (keep the export names so
   imports don't churn). Unknown-type handling unchanged.
2. **Fix the general loop:** rewrite `process-outbox`'s claim to use `claim_jobs`
   (its 20 types, limit 50) and add stale reclaim (registry-driven
   `reclaimMinutes`, default 5) + the batch-level heartbeat pattern copied from
   `drawings-pipeline.ts` (`resetStaleProcessingJobs` + waitingIds interval —
   extract BOTH into `lib/services/outbox-runtime.ts` shared helpers; drawings/
   specs/starts adopt the shared helpers in the same change, deleting their local
   copies).
3. **Close the raw-insert backdoor:** grep every `.from("outbox").insert` call site;
   convert to `enqueueOutboxJob` (it handles dedupe + never-throws). Exception: the
   drawings fan-out inserts (bulk page jobs) may keep a bulk path — add
   `enqueueOutboxJobs(batch)` to outbox.ts for them rather than leaving raw
   inserts.
4. **Step-ledger generalization:** extract the starts step-ledger pattern into
   `lib/services/outbox-runtime.ts` as `runStepLedger(jobId, steps, handlers)`
   (persisted per-step status/attempt/error, resume-past-completed). New multi-step
   jobs (reconciliation runs, underwriting packages, floorplan interpretation) use
   it instead of inventing per-domain ledgers. `start_release_steps` stays as-is
   (its table is fine; the RUNNER generalizes, not the storage — new consumers get
   a generic `outbox_job_steps` table in the same migration as their feature).
5. **Ops visibility:** `/admin/ops` gains an outbox panel: per job_type pending/
   processing/failed counts, oldest pending age, reclaim events last 24h (query
   `last_error = 'Recovered stale processing job'` — standardize that string in the
   shared helper). Alert (ops event) when oldest-pending exceeds 3× the type's
   expected cadence.

### Phase B directives (WDK trial)
When the next NEW pipeline is built: implement it twice-lightly — a thin WDK
version behind a flag vs. the outbox-runtime version — on the QA org only. Verdict
doc `docs/wdk-trial-verdict.md`: resumability ergonomics, observability, local dev,
cost, lock-in. STOP: the human reads the verdict before any migration of existing
pipelines is even planned.

### Acceptance
Kill-test: hard-crash (throw) mid-job in each loop on QA → job reclaimed and
completed within its reclaim window, no duplicates (idempotency asserted per
handler); zero raw outbox inserts remain (lint-able: add an ESLint no-restricted
pattern for `from("outbox")` outside outbox.ts); registry is the only place a job
type string exists.

---

## WS-T2 — Temporal tables: time-travel for money

### Ground truth
- NO history tables, NO DB-trigger auditing — `audit_log` (app-written, before/after
  jsonb, never pruned) and `events` are the only records. `budget_snapshots`
  (manual + nightly via forecast-snapshots cron) is the only as-of financial
  artifact, and it's coarse (summary + by_cost_code jsonb).
- Consumers who need as-of truth: draw packages ("budget as the bank saw it"),
  audit/dispute response, Arc Books B4 re-projection verification, WIP trend.

### Design (system-period versioning via triggers — no extension dependency)
1. Scope: FINANCIAL tables only, v1 list: `budgets`, `budget_lines`, `invoices`,
   `vendor_bills`, `commitments`, `change_orders`, `payments`, `retainage`,
   `pay_applications`, `draw_schedules`, `job_cost_entries`. Nothing else (history
   on hot non-financial tables is bloat).
2. Migration (write, then STOP — this one deserves careful human review):
   For each table `t`: a `t_history` table (same columns + `valid_from timestamptz,
   valid_to timestamptz, history_op char(1)`), no FKs, no RLS-for-users (service
   role + a read policy gated on an org-scoped financial permission), BRIN index on
   `valid_to`, btree on (id, valid_to). One generic trigger function
   `record_row_history()` (AFTER UPDATE OR DELETE: writes OLD with `valid_to =
   now()`; INSERTs write nothing — current row is the open period). Attach per
   table. This is write-amplification ×1 on UPDATE/DELETE only — acceptable on
   these tables' rates.
3. Retention: keep forever (matches audit_log doctrine); revisit with data volume.
   History tables are excluded from any future pruning migration by comment.
4. **As-of query layer:** `lib/services/as-of.ts` — `queryAsOf(table, orgId,
   timestamp)` composing `SELECT ... FROM t WHERE created_at <= ts AND id NOT IN
   (rows superseded before ts)` — implement precisely as: current rows created
   before ts UNION history rows whose [valid_from, valid_to) contains ts. Wrap per
   consumer, don't expose generically to UI.
5. First consumers (same change, proves the plumbing):
   - Draw package PDF gains "Budget as of <draw submission date>" (draws service
     passes the timestamp).
   - `financials/budget` Compare mode (parity WS-03) gets "as of any date" as a
     third comparison source (vs. snapshots' fixed dates).
   - A platform-staff debug page under `/admin` (as-of viewer for support disputes).
6. Explicit NON-decision: this does NOT replace `budget_snapshots` (snapshots are
   curated artifacts with labels/status; history is raw truth). Both stay.

### Acceptance
Update a budget line → history row appears with correct interval; `queryAsOf`
reconstructs yesterday's budget exactly against a fixture sequence of edits;
write-path overhead measured (<5% on `pnpm test:financials` runtime); RLS check:
non-privileged role cannot read history tables.

---

## WS-T3 — Typst for PDFs (adopt-on-new, migrate-on-touch)

### Ground truth
- Two generators: `@react-pdf/renderer` v4.3.1 (16 .tsx templates; `renderToBuffer`)
  and pdf-lib v1.17.1 (13 .ts templates via `lib/pdfs/document-kit.ts` — Helvetica
  StandardFonts only, NO Unicode).
- Known defects to inherit-fix: fonts registered only in `report.tsx` (DM Sans),
  `outputFileTracingIncludes` ships fonts for ONE route (others silently degrade to
  Helvetica on Vercel); `report.tsx` embeds `new Date().toLocaleString()` in the
  footer; `schedule-gantt-visual` computes `startOfDay(new Date())`; pdf-lib and
  react-pdf both write current-time Creation/ModDate metadata — NO PDF in the repo
  is byte-reproducible; `toLocaleString("en-US")` without timeZone → server-TZ-
  dependent output.
- Complexity peaks: `schedule-gantt-visual.tsx` (1057 lines, SVG bars),
  `quote-document.tsx` (421, shared engine), `pay-application-g702.tsx` (AIA form
  replica), `invoice.tsx` (392, sharp logo pipeline in `invoice-data.ts`).

### Strategy (decision made)
Typst becomes the generator for NEW document families and for templates migrated
WHEN TOUCHED. pdf-lib is NOT replaced (stamping/merging existing PDFs — esign,
submittal stamps, document-kit merges — is manipulation, not generation; Typst
cannot do it). No big-bang migration: 16 working templates are not a fire.

### Directives
1. **Toolchain:** `lib/pdfs/typst/engine.ts` wrapping the `typst` compiler.
   Preferred embedding: the `@myriaddreamin/typst.ts`-class WASM compiler pinned to
   an exact version (no system binary on Vercel). STOP if WASM bundle size or
   cold-compile time exceeds 2s for a 3-page doc — fallback plan is a sidecar
   compile route with the native binary via a build step, which needs human infra
   sign-off.
   API: `renderTypstPdf({ templateKey, data }): Promise<Buffer>` — templates in
   `lib/pdfs/typst/templates/*.typ`, data injected as a JSON `sys.inputs` (never
   string-interpolated into markup — injection discipline).
2. **Determinism from day one:** engine sets fixed CreationDate/ModDate from an
   input `documentDate` (or the entity's own timestamp — NEVER wall clock); all
   date formatting in templates from pre-formatted strings passed in data (server
   formats with explicit `timeZone`); no `datetime.today()` in any template
   (lint the .typ files for it in CI via a simple grep check in the engine's test).
   Acceptance for EVERY Typst doc: same input → byte-identical output (test
   helper `expectDeterministicPdf(render, data)` runs twice and compares hashes).
   This is what makes verifiable-documents hashing sane later.
3. **Shared layout library:** `templates/_arc.typ` — page setup (US Letter, 42pt
   margins to match document-kit), DM Sans embedded (fonts resolved from
   `lib/pdfs/fonts` — one place; add ALL pdf routes to
   `outputFileTracingIncludes` while here, fixing the existing per-route gap),
   header/footer party blocks, money formatting (input pre-formatted strings —
   cents math NEVER in templates), dense table styles with repeated headers on
   page breaks.
4. **First adopters (new families from other gameplans):** lien notice documents
   (lien-autopilot WS-L3), reconciliation/close summary (arc-books B2), monthly
   fee statements (fintech WS-P2), underwriting package summary (fintech WS-P5).
5. **Migrate-on-touch list (in likely-touch order):** `report.tsx` (fix its
   wall-clock footer at migration: `generatedAt` becomes a parameter), G702/G703
   (Typst's grid model fits the AIA form far better than flexbox), invoice (port
   the sharp logo pre-processing as-is — it feeds image bytes either way),
   pay-application. Rule per migration: pixel-review against the old output with
   the human, DELETE the old template + its imports in the same PR, one template
   never exists in both worlds.
6. `schedule-gantt-visual` is LAST or never — its SVG bar rendering is the one
   thing react-pdf does well here.

### Acceptance
Engine determinism test green; first new family ships on Typst with correct fonts
ON VERCEL (verify deployed bytes, not local); no template duplicated across
generators; `document-kit.ts` untouched (pdf-lib lane intact).

---

## WS-T4 — Cheap classifier tier (two-tier model routing)

### Ground truth
- `lib/services/ai-config.ts`: 3 providers (openai/anthropic/google), 6 features
  (`search | document_extraction | drawings_vision | spec_classification |
  transcription | meeting_minutes`), org → platform → env → default resolution.
  **Anthropic defaults are stale 3.5-era aliases** across the table.
- THREE call styles coexist: AI SDK `generateText` (harness, intent router, email
  classify, photo captions, minutes), raw Gemini REST (`document-ai-rename.ts`,
  `receipt-extraction.ts` — these BYPASS org/platform provider config), raw OpenAI
  REST (transcription). Zero `generateObject` — every structured output is
  hand-rolled JSON-fence parsing + zod + retry hacks (6+ copies).
- Classification-shaped work already live: email classification (outbox), photo
  caption/tags (outbox), spec page classification (pipeline), receipt extraction,
  filename suggestions, search intent routing (sync, cached).

### Directives
1. **One structured-call helper first:** `lib/services/ai/structured.ts` —
   `generateStructured<T>({ feature, tier, schema, system, prompt, timeoutMs }):
   Promise<T | null>` built on the AI SDK's `generateObject` with ONE retry on
   schema failure. This deletes the 6 hand-rolled parsers as call sites migrate.
   (Name/location note: `ai-search/structured.ts` exists — inspect it first; if it
   is this helper in embryo, extend it in place rather than adding a sibling.)
2. **Tier concept:** extend ai-config with `tier: 'reasoning' | 'classifier'`
   per call. New feature-tier default table:
   classifier defaults — openai `gpt-4.1-nano`-class, google
   `gemini-2.5-flash-lite` (already the de-facto cheap model in this codebase),
   anthropic `claude-haiku-*` current alias; reasoning defaults — the existing
   per-feature models. STOP: have the human confirm the exact current model IDs
   for all three providers at implementation time (training-data IDs go stale;
   this doc deliberately doesn't pin them) — and fix the stale Anthropic aliases
   in `AI_FEATURE_DEFAULT_MODELS` in the same change.
3. **Route to classifier tier** (mechanical migrations onto
   `generateStructured({ tier: 'classifier' })`): email classification, photo
   caption/tags, spec page classification, filename suggestion, search intent
   router (keep its version-keyed cache), quick-capture entity-type detection.
   Receipt extraction and doc-extraction stay reasoning-tier (accuracy-critical,
   money-adjacent) but MUST migrate off raw REST onto `resolveLanguageModel` so
   org/platform overrides finally apply to them (this is a correctness fix, not
   just hygiene).
4. **Cost telemetry:** `generateStructured` records per-call `{ feature, tier,
   provider, model, inTokens, outTokens, latencyMs }` into the existing
   `ai_search_events`-style telemetry (extend `ai-search/telemetry.ts`; add a
   platform admin band: AI spend by feature × tier × org). Without this, tiering
   savings are unverifiable.
5. Guardrail: classifier-tier outputs that gate MONEY behavior (e.g., a
   classification that routes a bill) must carry confidence and fall back to
   human review below threshold — pattern already in `classifyProjectEmail`'s
   confidence field; make it a required field of every classifier schema.

### Acceptance
All six hand-rolled parsers deleted; zero raw provider REST calls remain except
transcription (audio endpoints are genuinely not in scope of generateObject — leave
whisper path, but route its model choice through ai-config, which it already does);
telemetry shows tier split; classification quality spot-check: 50-email fixture
classified identically or better vs. the old path.

---

## WS-T5 — One multimodal embedding space

### Ground truth
- `search_embeddings`: pgvector `vector(1536)` HARD-CODED in DDL, OpenAI
  `text-embedding-3-small` via raw fetch, ivfflat cosine lists=100, unique
  (document_id, model).
- Embedded content = title/subtitle/description/projectName ONLY — extracted
  document text (`metadata.search.extracted_text`, drawings `page_text`, photo
  captions) is FTS-searchable but NEVER embedded.
- Retrieval: 3 tiers (FTS → trgm fuzzy → semantic gated to shortfall cases);
  vector similarity contributes CANDIDATES only — final ranking is hand-rolled
  lexical scoring; no fusion. Lazy backfill writes documents WITHOUT embeddings.
- Photos now have `ai_caption`/`ai_tags` (parity WS-04 shipped).

### Strategy (two steps; the second is the "multimodal" one)
Step 1 makes the EXISTING text space cover all content (cheap, huge recall win).
Step 2 introduces a true multimodal model for image-content search. Do them in
order — step 1 may be enough for months.

### Step 1 directives — embed what we already know
1. **Embed real content:** change `reindexEntity`'s embedded text to include the
   body/extracted text (truncate: title+meta first 500 chars + body up to the
   4,000-char input cap; for long docs, CHUNK: `search_embedding_chunks` is NOT
   needed — instead raise to N embeddings per document via a `chunk_index` column
   added to `search_embeddings` (unique becomes (document_id, model,
   chunk_index)), chunk size ~2,800 chars with 200 overlap, max 8 chunks per doc
   (cap = cost control; log truncations). `match_search_embeddings` RPC gains
   DISTINCT ON (document_id) max-similarity collapse. One migration: add column +
   swap unique index + replace RPC. STOP after writing.
2. **Photos into the space:** photo search documents' embedded text = ai_caption +
   ai_tags + album/location/trade names (the caption pipeline already produces
   these — this makes "pre-drywall electrical lot 42" work semantically with ZERO
   new models).
3. **Fusion:** replace candidates-only semantics with weighted RRF in
   `searchEntities`: final = RRF(rank_fts, rank_fuzzy, rank_semantic, k=60), then
   the existing recency tiebreak. Keep the semantic-tier cost gate (short queries
   skip vectors). Add an eval fixture (the `ai-search/evals.ts` harness exists —
   extend it) of 40 real-ish queries with expected top-3, run before/after; fusion
   must not regress the lexical winners.
4. **Backfill honesty:** lazily-backfilled documents enqueue a real
   `reindex_search` (embedding included) instead of staying vector-less — one-line
   fix in the backfill path.

### Step 2 directives — true multimodal (image vectors)
1. STOP first: provider choice (a CLIP-family/multimodal embedding API; options
   move fast — present current choices + pricing to the human; selection criteria:
   text+image joint space, dimension ≤ 1536 preferred, per-image cost at photo
   volumes).
2. New column strategy, not new dimension surgery: `search_embeddings.model`
   already discriminates spaces; image vectors insert with the multimodal model
   name (dimension MUST match 1536 or get their own table — if the chosen model
   isn't 1536, create `search_embeddings_mm` with its own dimension + index; do
   NOT alter the existing column type in place).
3. Embed: photo images at caption time (extend `caption_photo` job — one more API
   call while the image is in hand); drawing sheet thumbnails at pipeline enrich
   time. Query path: text query embedded by the SAME multimodal model for
   image-space search, exposed as a search filter (`kind:photo` queries hit the
   image space; global search fuses via RRF with source weighting).
4. The payoff queries to verify: "photos of the detail on sheet A-301"
   (cross-modal), "find the spec section matching this photo" (image→text,
   assistant tool), "punch items that look like this" (image→image, later).

### Acceptance
Step 1: eval suite recall@3 improves and lexical winners hold; chunked docs
retrievable by mid-document phrases; embedding cost per 1k documents recorded in
telemetry (WS-T4's). Step 2: the three payoff queries return sane results on the QA
org's fixture media; per-photo embed cost within the human-approved budget.

---

## Recommended order
T4 (classifier tier + structured helper — everything else's AI calls get cheaper) →
T1 phase A (outbox unification — reliability under everything) → T5 step 1 →
T3 (engine + first new family) → T2 (temporal, gated on careful review) →
T5 step 2 and T1 phase B as gated trials.
