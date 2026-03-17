# Arc AI Search Overhaul Gameplan (LLM-Optimized, System-Level)

Goal: Evolve command search from a retrieval helper into a true **org copilot** that can answer broad questions naturally, with high correctness, clear citations, and fast interaction quality.

This plan is grounded in the current implementation (`components/layout/command-search.tsx`, `app/api/ai-search/*`, `lib/services/ai-search.ts`, `lib/services/search.ts`) and is optimized for LLM-agent execution.

---

## 0) Current-State Findings (Repo Reality)

### 0.1 Retrieval is lexical and shallow
- Search uses `ILIKE` conditions across entity fields in `lib/services/search.ts`.
- Full-text indexes exist in migrations, but runtime search does not use `tsvector` ranking.
- Result ordering is type/date-biased, not relevance-biased.

Impact:
- Weak recall for natural language.
- Weak precision for ambiguous terms.
- “Not truly natural” behavior for users.

### 0.2 Analytics are partially computed in app memory
- Analytics path limits rows (`MAX_ANALYTICS_SCAN_ROWS = 2000`) and aggregates in TS.

Impact:
- Possible truncated or misleading totals/trends as data grows.

### 0.3 Planner/tooling is intentionally constrained
- Agent planner chooses one entity and simple operation (`list` or `aggregate`).
- Good for safety, but not enough for multi-entity reasoning.

Impact:
- Broad cross-domain questions feel brittle.

### 0.4 Export/data artifacts are process-memory only
- Artifact datasets are stored in memory maps with TTL.

Impact:
- Export links can fail across instance restarts or horizontal scaling.

### 0.5 Query transport uses GET for streamed AI
- User prompt is sent in URL params to `/api/ai-search/stream`.

Impact:
- Increased leakage risk via logs/history; poor fit for larger payloads.

---

## 1) Product Definition (What “Truly Special” Means)

### 1.1 Two explicit modes
1. `Org Copilot` (default in command bar):
   - Strictly grounded in org data.
   - Must cite records used in answer.
   - Should ask clarifying question when confidence is low.
2. `General Assistant` (opt-in toggle):
   - Can answer non-org questions.
   - Clearly marked as ungrounded from org data.

### 1.2 Core UX behaviors
- Users can ask natural questions:
  - “What’s most at risk this week?”
  - “Which projects are slipping and why?”
  - “Summarize cash risk for Riverside and Elmwood.”
- Answer includes:
  - short executive summary
  - key drivers
  - citations and clickable drilldowns
  - confidence + “missing data” notes when needed

### 1.3 System SLOs
- p50 end-to-end response: <= 2.5s
- p95 end-to-end response: <= 6s
- “no citation” grounded answers: 0%
- analytics correctness error on gold set: < 1%

---

## 2) Target Architecture

1. Query Understanding Layer
- Intent classification (lookup, aggregate, compare, diagnose, recommend).
- Entity set detection (single or multi-entity).
- Clarification gate when ambiguity is high.

2. Tool Layer (SQL-first, safe)
- Deterministic read-only tools for:
  - counts and grouped aggregations
  - time-window trends
  - top-N anomaly slices
- All tools org-scoped and permission-aware.
- Avoid JS-side aggregation for authoritative totals.

3. Retrieval Layer (hybrid)
- Lexical retrieval (FTS with ranking).
- Semantic retrieval (embeddings).
- Metadata filters (org/project/status/date).
- Optional reranker for final context selection.

4. Synthesis Layer
- Compose answer from tool outputs + retrieved evidence.
- Structured response schema:
  - answer
  - findings
  - citations
  - confidence
  - follow-up questions

5. Memory + Session Layer
- Conversation thread context for follow-ups.
- Store question + chosen plan + result summary.

6. Artifact/Export Layer
- Persist artifacts in DB (not process memory).
- CSV/PDF exports backed by durable rows.

---

## 3) Phased Delivery Plan

### Phase A - Correctness Foundation (Week 1)
Purpose: Remove known correctness/scaling gaps before adding sophistication.

Tasks:
- Replace app-memory aggregation with SQL aggregation tools.
- Remove `INNER` joins that drop nullable-relationship records.
- Convert AI stream endpoint from GET query params to POST body.
- Reduce noisy hot-path logs in search services.

Acceptance:
- Gold queries for totals/trends match SQL truth at scale.
- Invoices/proposals without project links are discoverable.
- AI prompt no longer appears in request URL.

### Phase B - Retrieval V2 (Weeks 2-3)
Purpose: Major quality jump for natural language retrieval.

Tasks:
- Add FTS query path using `to_tsquery`/`websearch_to_tsquery` and ranking (`ts_rank`).
- Introduce `search_documents` (or equivalent) unified view/materialized table:
  - `org_id`, `entity_type`, `entity_id`, `title`, `body`, `metadata`, `tsvector`.
- Add embeddings pipeline for high-value text fields (messages, RFIs, submittals, notes, OCR text).
- Implement hybrid retrieval strategy:
  - lexical candidates + semantic candidates -> merged + reranked.

Acceptance:
- Retrieval benchmark (50+ representative prompts) improves recall@10 and precision@5 by agreed thresholds.
- Significant reduction in “no matching records” for natural phrasing.

### Phase C - Planner + Tool Orchestration V2 (Weeks 3-4)
Purpose: Support broad, compositional questions.

Tasks:
- Upgrade planner to generate multi-step plans:
  - gather -> aggregate -> compare -> explain.
- Allow multi-entity execution where needed (e.g., invoices + payments + commitments).
- Add uncertainty and clarification policy:
  - ask question when entity scope/time range ambiguous.
- Add deterministic repair strategy for empty/weak results.

Acceptance:
- Complex prompts produce coherent multi-step outputs with citations.
- Ambiguous prompts trigger useful clarifying follow-up instead of low-quality guessing.

### Phase D - Conversation + Memory (Week 5)
Purpose: Make the system feel like a real assistant, not single-shot search.

Tasks:
- Persist session threads (last N turns + summarized memory).
- Resolve references in follow-ups:
  - “that project”, “last quarter”, “same vendors”.
- Add conversation-scoped tool context carryover.

Acceptance:
- Follow-up benchmark passes (10-20 multi-turn scripts).
- Reduced need for user restating context.

### Phase E - Production Hardening + Evaluation (Week 6)
Purpose: Ensure reliability under real traffic and evolving data.

Tasks:
- Build eval harness:
  - gold queries + expected metric bands
  - citation quality checks
  - hallucination guard checks
- Add observability:
  - plan chosen, tools run, rows scanned, latency by stage, failures.
- Add feature flags + staged rollout by org.

Acceptance:
- Defined launch gate metrics met for quality and latency.
- Safe rollback path validated.

---

## 4) Data Model and DB Work

### 4.1 New/updated data assets
- `search_documents` (table or materialized view):
  - `id`, `org_id`, `entity_type`, `entity_id`, `project_id`, `title`, `body`, `metadata`, `updated_at`, `search_vector`
- `search_embeddings`:
  - `document_id`, `org_id`, `embedding vector(...)`, `model`, `updated_at`
- `ai_search_artifacts`:
  - durable export payloads with org ownership and TTL
- `ai_search_sessions` + `ai_search_messages`:
  - session memory + turn history

### 4.2 Indexing strategy
- GIN on `search_vector`
- IVFFlat/HNSW index for embeddings (if pgvector enabled)
- Composite filters for common scoping:
  - `(org_id, project_id, updated_at)`
  - `(org_id, entity_type, updated_at)`

### 4.3 Security model
- Keep org scoping via RLS and service-layer checks.
- Read-only SQL tool boundary.
- Validate user permissions before tool execution.

---

## 5) API and Service Refactor Plan

### 5.1 API endpoints
- `POST /api/ai-search/stream` (SSE or chunked stream)
  - body: `query`, `sessionId`, optional `mode`
- `POST /api/ai-search/export`
  - returns export URL for persisted artifact

### 5.2 Service decomposition
- `lib/services/ai-search/planner.ts`
- `lib/services/ai-search/tools.ts`
- `lib/services/ai-search/retrieval.ts`
- `lib/services/ai-search/synthesis.ts`
- `lib/services/ai-search/memory.ts`
- `lib/services/ai-search/evals.ts`

### 5.3 Backward compatibility
- Keep current endpoint contract behind feature flag.
- Dual-run old/new path for selected orgs and compare outputs.

---

## 6) Evaluation Framework (Non-Optional)

### 6.1 Gold set categories
- Lookup: “Find RFI 042”
- Aggregate: “Invoice totals by month for last 12 months”
- Cross-domain: “Are commitments exceeding budget on active projects?”
- Diagnostic: “What is driving overdue work?”
- Multi-turn follow-up: “Now only for Riverside”

### 6.2 Metrics
- Retrieval: recall@k, precision@k
- Answer quality: factuality, completeness, actionability
- Citation quality: precision/coverage
- Ops: latency by stage, timeout rate, tool error rate

### 6.3 Launch gates
- No critical factual mismatches on gold set.
- Citation coverage >= 95% for grounded answers.
- p95 latency within SLO under production-like load.

---

## 7) Rollout Strategy

1. Internal dogfood (platform users only).
2. Early-access org allowlist.
3. Default-on for low-risk org cohorts.
4. Full rollout with kill switch.

Kill switches:
- planner v2 off
- hybrid retrieval off
- conversation memory off
- full fallback to current deterministic path

---

## 8) Risks and Mitigations

Risk: Increased complexity reduces reliability.
- Mitigation: strict module boundaries + eval gates + feature flags.

Risk: Token/context costs spike.
- Mitigation: tighter context selection, caching, summarization of long docs.

Risk: Semantic search drifts relevance.
- Mitigation: hybrid retrieval + reranker + periodic benchmark recalibration.

Risk: Security leakage across orgs.
- Mitigation: org_id constraints in every query path + RLS + automated security tests.

---

## 9) LLM Execution Notes (How to Implement Safely)

1. Prefer deterministic tools for any numeric claim.
2. Never aggregate authoritative metrics in app memory.
3. Always emit citations for grounded answers.
4. If evidence is weak, ask a clarifying follow-up.
5. Keep answer schema strict and parseable.
6. Preserve existing permissions and org context boundaries.

---

## 10) Implementation Backlog (Actionable)

### P0
- SQL-first aggregation tools
- Fix nullable relationship drops in search joins
- POST-based AI stream API
- Persist artifact datasets

### P1
- FTS runtime integration with ranking
- Unified search document index
- Embeddings + hybrid retrieval

### P2
- Multi-step planner + tool orchestration
- Session memory
- Eval harness + dashboards

---

## 11) Definition of Done

The overhaul is “done” when:
- Natural-language query success rate is materially higher on benchmark set.
- Financial/analytic answers are SQL-correct at production scale.
- Every grounded answer includes reliable citations.
- Follow-up queries work without repeating full context.
- Latency and reliability targets are met under staged production rollout.
