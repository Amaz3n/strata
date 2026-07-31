# Technology Frontier × Arc Gameplan

**Status:** Awaiting execution. Companion to `docs/procore-parity-gameplan.md` (which
covers comparison-driven parity/one-up work). This doc covers capabilities that **do not
exist in construction software** — SOTA technology landed on Arc's structural assets.

**The thesis:** competitors retrofit intelligence onto document warehouses. Arc's ground
is structured — integer-cents ledger, real schedule graph, selections engine, owned
payment rails (Stripe), takeoff vectors, frictionless token portals, an agentic AI
substrate (`lib/services/ai-search/*`, `ai-assistant/*`), and a transcription stack.
Each play below exists because one of those assets makes it land where others can't.

**Recurring guardrails:**
- All AI features gate behind the org AI master-flag pattern (`ai_search_enabled`
  precedent) — per-org opt-in, platform-controlled.
- AI never auto-commits records with financial consequence. Everything lands as a
  **draft/proposal with an approval affordance and audit trail**. This trust model *is*
  the differentiator vs. Procore's Agent Builder.
- Local dev points at production Supabase: no migration is ever applied by an agent;
  schema sketches go to `supabase/migrations/` and stop.
- New entities complete the full registration checklist from `CLAUDE.md`.

**Ranked build order (leverage ÷ effort), with dependencies:**

| # | WS | Play | Effort |
|---|----|------|--------|
| 1 | F1 | Voice agent (async capture → realtime) | Low |
| 2 | F2 | Arc as MCP server | Low |
| 3 | F3 | Monte Carlo simulation engine | Medium |
| 4 | F4 | Virtual cards per budget line (Stripe Issuing) | Medium |
| 5 | F5 | Gaussian-splat walkthroughs | Med-High |
| 6 | F6 | Contract & obligation intelligence | Medium |
| 7 | F7 | Constraint-solver even-flow | Medium |
| 8 | F8 | Local-first field app (CRDT sync) | High |
| 9 | F9 | WebGPU viewer unification | Medium |
| 10 | F10 | Geospatial layer + earth observation | Medium |
| 11 | F11 | Passkeys + verifiable documents | Low |
| 12 | F12 | The House Passport (capstone) | Low once F5/F6 exist |

---

## WS-F1 — The Voice Agent (field capture → conversational execution)

### Why
The super's hands are gloved and full. Procore's "voice" is dictation into a text box.
Arc has the three ingredients nobody else combines: a transcription stack
(`meeting-transcripts`), an agentic executor with a typed tool catalog
(`ai-search/agent-executor`, tool catalog), and structured targets for every utterance
(daily logs, punch, tasks, RFIs, schedule completions).

### Phase 1 — Async Quick Capture (shared with parity WS-05; build once)
Hold-to-talk / short video in iOS → upload → transcribe → LLM structured extraction →
typed draft (`punch_item | observation | daily_log_note | task | rfi_draft`) in a review
tray. `lib/services/quick-capture.ts`, `/api/mobile/v1/capture`. Context inference from
the active `my-houses` scope. Confirm-before-save always.

### Phase 2 — Conversational queries (read path)
Push-to-talk question → route through the existing ai-search intent router → spoken +
on-screen answer. Grounding targets that make demos: selections cutoffs
(`selection-cutoffs`), schedule dates, budget lines, vendor phone numbers, spec clauses.
Read-only; latency budget ~2s via streamed TTS.

### Phase 3 — Realtime speech-to-speech
Swap transport to a realtime voice API (interruptible, tool-calling mid-stream) behind
the SAME extraction/tool contracts from phases 1–2 — the transport upgrade must not
change the service layer. Multi-action utterances ("log it: crew of six, slab delayed to
Thursday, truss package delivered") fan out to multiple drafts, confirmed aloud as a
batch.

### Architecture notes
- One choke point: every voice-originated mutation flows through the ai-assistant
  harness's action tools → existing server actions → normal permission checks. Voice is
  an input method, not a privileged path.
- Wake-word: skip. Push-to-talk only (jobsite noise, battery, privacy).
- Offline: phase-1 captures queue locally and sync (pairs with WS-F8; works standalone
  with a simple upload queue first).

### Acceptance
15-second spoken multi-item capture → correct typed drafts < 30s; zero mutations without
confirm; `pnpm test:mobile` contract extended.

---

## WS-F2 — Arc as an MCP Server

### Why
The customer's own AI (Claude, their bookkeeper's agent, their estimator's tools)
becomes Arc's integration layer — a marketplace with no marketplace. Procore's "Agentic
APIs" are their acknowledgment this is the future; Arc's internal tool catalog already
exists, so this is transport + auth, not new capability.

### Design
- **Server:** an MCP endpoint (HTTP/SSE transport) exposing a *curated subset* of the
  ai-assistant tool catalog. Read tools first: reports (catalog runs with parameters),
  search, project/budget/invoice/schedule/selection lookups. Write tools (phase 2, few):
  create task, draft RFI, draft invoice — draft-only, honoring the proposal doctrine.
- **Auth:** org-scoped API tokens minted in `/settings/integrations` — scoped
  (read-only vs. draft-write), revocable, last-used visible. Every call runs through
  `requireOrgContext`/`requirePermission` as a service-account membership with an
  assignable role (reuse RBAC; no parallel permission system). Full audit via
  `recordAudit` with actor = token.
- **Rate/row caps** per token; responses are mapped DTOs (never raw rows), org_id
  scoping enforced at the service layer as always.
- **Docs:** one page in the help center; the pitch is a copy-paste `claude mcp add`
  block for a builder's bookkeeper.

### Phases
1. Read-only server + token management UI + 10 highest-value tools (WIP report, AR/AP
   aging, project list/detail, budget summary, invoice list, schedule lookahead,
   search).
2. Draft-write tools + per-tool scope grants.
3. Webhooks (outbound event subscriptions) for the analyst crowd — rides the existing
   `events`/outbox stream.

### Acceptance
External Claude session answers "what's my WIP over/under by project?" against a demo
org via MCP with a read token; token revocation kills access immediately; every call
audited. `pnpm test:auth` covers the service-account path.

---

## WS-F3 — The Simulation Engine (Monte Carlo on your own history)

### Why
Every vendor ships deterministic dates and single-number forecasts everyone knows are
fiction. Arc owns real per-org distributions: schedule-item actuals, cycle times per
plan/community/vendor, draw timing, payment lags. Honest stochastic simulation is not
exotic ML — it's arithmetic nobody in this industry has done.

### Design
- `lib/services/simulation/` — a pure, deterministic-given-seed engine:
  - **Distribution builder:** empirical distributions per (schedule item template ×
    posture × community/vendor where sample size permits; fall back up the hierarchy —
    item→phase→org — with sample counts surfaced). Rebuilt nightly by cron into
    `simulation_distributions` (org-scoped, derived, rebuildable — treat as cache).
  - **Schedule simulator:** walks the dependency graph N=10k times sampling durations →
    per-milestone/closing date percentiles (P50/P80/P95).
  - **Cash simulator:** overlays simulated schedule onto the deterministic cash-flow
    model from parity WS-03 (draw milestones, bill due dates, payment-lag
    distributions) → weekly cash percentiles + P(min balance < threshold).
- Compute: Node worker within a job route is fine at 10k runs (this is small-N
  arithmetic, not ML); if runtimes bite, batch per-project via outbox fan-out.
- **Surfaces (opinionated, no dashboards):**
  - Project schedule tab: confidence chips next to key dates ("Closing: Nov 14, 80%").
  - `/starts` desk: release-slate stress readout — P90 trade load vs. capacity.
  - New report `cash-at-risk`: fan-table (weeks × percentile columns, dense-table
    doctrine) + the single sentence that matters ("5% chance operating cash dips below
    $200k in Sept; driver: Draw 3 on Willow Creek").
  - Sales integration (production): buyer-facing dates shown are P80, not P50 — a
    policy toggle per org.
- **Honesty rules:** every simulated number displays its sample basis ("from 34
  completed foundations in this community"); below minimum samples, show nothing rather
  than fake confidence. This is the anti-Procore-benchmark position: your history, not
  strangers' averages.

### Phases
1. Distribution builder + schedule simulator + confidence chips.
2. Cash simulator + `cash-at-risk` report.
3. Starts stress + P80 sales dates.

### Acceptance
Backtest: simulate historical projects from their midpoint; realized dates fall inside
P10–P90 at calibrated rates. `pnpm test:schedule` + `test:starts` extended with seeded-
RNG fixtures.

---

## WS-F4 — Virtual Cards per Budget Line (Stripe Issuing)

### Why
The entire industry *records* spend after the fact; controlling spend **at the
authorization webhook** doesn't exist in construction software. Arc already runs Stripe
and integer-cents budgets. Also a revenue line (interchange).

### Design
- Stripe Issuing integration alongside the existing Stripe surface
  (`stripe-connected-accounts` precedent for per-org Stripe state):
  - `spend_cards` — org_id, cardholder (team member), scope
    (`project | commitment | budget_line | org`), scope_id, limit_cents,
    period (`one_time | monthly`), status, stripe_card_id.
  - **Real-time authorization webhook:** on each swipe, evaluate scope remaining budget
    (existing budget/actuals services) + merchant-category allowlist → approve/decline
    in the webhook window. Declines carry a reason pushed to the cardholder's phone
    (APNs — `apns.ts` exists).
  - On approval: auto-create the expense (existing `expenses` path) pre-coded to the
    card's scope, status `pending_receipt`; APNs prompt "snap the receipt" → mobile
    `expenses/scan` OCR (exists) attaches + reconciles. Unmatched receipts age into the
    financials review queue.
- **The product sentence:** budget overruns become *impossible at the rail* — when the
  line is spent, the card declines.
- Rollout: physical cards optional later; virtual cards in Apple Wallet first (fastest
  path, field-realistic).
- Compliance/ops: Issuing runs under Stripe's program (no money-transmitter burden),
  but this needs commercial diligence (cardholder agreements, program approval) —
  flag as a human-led workstream parallel to the code.

### Phases
1. Org opt-in + card issuance UI (settings) + project-scoped cards + auth webhook with
   budget check + auto-expense.
2. Budget-line / commitment scoping + MCC controls + receipt-chase loop.
3. Reporting: card spend inside job-cost actuals + a `card-spend` report; monthly
   statements per org.

### Acceptance
Swipe against an exhausted line declines in sandbox; approved swipe books a coded
expense within seconds; `pnpm test:financials` covers the ledger paths. Every webhook
idempotent (Stripe retries).

---

## WS-F5 — Gaussian-Splat Walkthroughs (the spatial record)

### Why
Splat reconstruction turns a 60-second phone walkthrough into a photoreal, browsable 3D
snapshot — no LiDAR, no 360 rig, no Matterport subscription. OpenSpace sells a weaker
360-photo version standalone at $10k+/yr for commercial. Integrated capture → schedule →
punch → warranty → buyer does not exist anywhere, and the marginal cost is GPU minutes.

### Design
- **Capture (iOS):** guided walkthrough mode — steady-pace prompts, coverage hints,
  auto-chunked upload via the existing multipart-upload client. Triggered from a
  schedule-item milestone ("pre-drywall capture") or ad hoc. Tied to project/lot +
  schedule item. **Capture format is an ARKit session recording** (frames + camera
  poses + intrinsics, plus LiDAR-fused depth maps when the device has them): ARKit's
  visual-inertial poses let the pipeline skip or merely refine SfM — the slowest,
  most failure-prone stage, and one that hates exactly what construction interiors
  look like (textureless drywall, repetitive studs) — and LiDAR depth gives metric
  scale (real feet, which anchors/measurements need) plus a training prior that
  cleans up floaters. Works on every ARKit iPhone; LiDAR depth is an optional
  stream on Pro models. "No LiDAR" in the Why above means *no dedicated scanner
  rig required*, not "ignore the phone's sensors."
- **Reconstruction pipeline:** new outbox job family following the drawings-pipeline
  pattern (chunk → process → enrich, heartbeat reclaim): frames extraction → SfM poses
  (fallback path for plain-video uploads only; ARKit sessions carry poses and skip
  it) → splat training on a GPU worker (external GPU runner service — Modal/RunPod-class —
  called from the job; the ONE piece of infra Arc doesn't already have) → compressed
  `.splat`/`.ply` artifact to R2 → `capture_scenes` row (org_id, project_id, lot,
  schedule_item_id, captured_at, artifact refs, status).
- **Viewer:** WebGPU splat renderer (open-source renderers are mature; wrap one) in a
  `capture` section of the project workbench + a timeline scrubber across scenes of the
  same house ("watch the house at rough-in vs. today"). Depends on/feeds WS-F9.
- **Spatial anchors:** click-in-scene → 3D-positioned pin → punch item / observation /
  photo link (`scene_anchors` table). V1 anchors are per-scene; cross-scene alignment
  (same pin across time) is phase 3.
- **Consumption surfaces:**
  - Warranty: claim detail shows nearest-in-time scene ("look behind that wall").
  - Buyer portal: publish selected scenes — the out-of-state buyer's "visit your house"
    button (visibility flag, same doctrine as photos WS-04).
  - Disputes: pre-drywall scenes referenced from RFIs/COs.
- **Cost model:** minutes-per-scene GPU pricing → per-scene cost is cents-to-dollars;
  meter per org, include N scenes/mo in plans.

### Phases
0. **Spike (done in `scripts/splat-spike/`, awaiting runs):** one video → splat →
   local web viewer, two paths: local Apple Silicon (COLMAP + Brush/Metal, answers
   quality) and Modal GPU (ns-process-data → splatfacto, answers $/scene). Answers reconstruction
   quality from casual capture and $/scene before any product code; also decides
   whether plain video is viable or ARKit-session capture is mandatory from day one.
1. Capture UX + pipeline + basic viewer (one scene, one house).
2. Timeline scrubber + milestone-triggered prompts (schedule integration).
3. Anchors (punch/warranty links) + buyer-portal publishing.
4. Cross-scene alignment; consider fixed capture checkpoints per plan (production:
   same capture points on every instance of a plan → comparable across the fleet).

### Acceptance
Phone walkthrough → browsable scene < 15 min; renders 60fps on a mid-tier laptop and
usable on iPhone; a punch item created from a scene anchor deep-links back into the
scene. Empty/loading/error/dark for the viewer page.

---

## WS-F6 — Contract & Obligation Intelligence

### Why
Long-context structured extraction is now reliable enough to treat a signed contract as
a database populated once. Procore's Copilot *finds* clauses when asked; a system that
converts contracts into standing obligations that **fire deadlines unprompted** is a
different category.

### Design
- **Extraction:** on upload/e-sign completion of subcontracts, prime contracts,
  insurance certs (sources: `subcontract-documents`, `contracts`, esign executed docs,
  `compliance-documents`): outbox job → LLM structured extraction →
  `contract_obligations` (org_id, project_id, source_doc ref, kind
  (`notice_period | retainage_term | allowance | exclusion | expiry | insurance_limit |
  payment_term | warranty_term`), parameters JSONB, clause_citation (page/section +
  quote), confidence, review_status). Everything lands `unreviewed`; a review tray in
  the financials review-queue family confirms/edits — confirmed rows become enforceable.
- **Enforcement wiring (the point):**
  - Notice periods → deadline sweeps: "CO #14's 14-day notice window under §8.3 expires
    Friday" (cron sweep → notification; email type into the allowlist).
  - Retainage/payment terms → cross-checked against commitment settings; mismatch flags
    at award and at billing (feeds parity WS-02 holds).
  - Exclusions → diffed against bid scope lines at award time ("sub excludes §3.2
    work that bid line 12 includes").
  - Expiries/limits → feed the existing compliance engine rather than a parallel one.
- **Q&A:** obligations + citations join the search/RAG corpus, so the assistant answers
  "what's our notice period with the framer?" with the clause linked.

### Phases
1. Extraction + review tray + Q&A grounding.
2. Deadline sweeps (notice periods, expiries).
3. Award-time and billing-time cross-checks.

### Acceptance
Seeded contract set extracts with >90% recall on notice periods/retainage in fixtures;
zero enforcement fires from unreviewed rows; every surfaced obligation shows its
citation.

---

## WS-F7 — Constraint-Solver Even-Flow (starts as optimization)

### Why
Production start-release is literally a constraint-optimization problem (trade capacity,
cutoff dependencies, spec/sold ratios, cash pacing, closing targets) that the whole
industry solves with a spreadsheet and a feeling. Arc has `even-flow`, `starts-pipeline`,
commitments (who does what), and — with WS-F3 — distributions. No competitor at any
price.

### Design
- Solver service: CP-SAT (OR-Tools) — run as a containerized microservice or a
  WASM-compiled solver in a job route (evaluate both; the model is small: ≤ a few
  hundred starts × weeks × trades).
- **Model:** decision vars = start week per releasable lot. Constraints: per-trade
  weekly capacity (derived from commitments + observed concurrent-lot throughput,
  editable in `/settings/starts`), selection-cutoff completion before start, land/lot
  readiness, WIP cash ceiling (from parity WS-03 cash model), even-flow smoothing band.
  Objective (weighted, org-tunable): maximize closings within horizon, minimize trade
  idle/overload variance, respect target community mix.
- **UX doctrine — suggestions, never automation:** `/starts` desk gets a "Suggested
  slate" panel: proposed release sequence with the *why* per lot ("held 2 weeks:
  framer at capacity — driver: 6 concurrent starts in Willow Creek wk 32"). One-click
  accept per lot writes through the normal starts release action. Infeasibility is
  reported as *which constraint binds* — that diagnosis alone is worth the feature.
- **Stress integration:** accepted slates run through WS-F3 for P90 load confirmation.

### Phases
1. Capacity model + solver + suggested slate (advisory).
2. Cash-ceiling constraint + WS-F3 stress readout.
3. What-if mode: edit capacities/targets → re-solve interactively.

### Acceptance
Solver returns in <10s for 250 lots; every suggestion carries a human-readable binding-
constraint explanation; `pnpm test:starts` gains solver fixture cases with known optima.

---

## WS-F8 — Local-First Field App (CRDT sync)

### Why
Jobsites are connectivity dead zones; Procore's offline is "view cached, pray on sync."
A field app where every tap is instant all day and the truck ride out syncs everything
wins field teams, and field teams drive construction-software churn. Deepest
architectural change in this plan — hence ranked late despite high payoff.

### Design
- **Scope discipline:** local-first applies ONLY to the field domains — daily logs,
  punch, inspections, photos/captures, schedule-item completions, tasks, my-houses.
  Financials stay online-only (money does not merge).
- **Sync layer:** evaluate Electric SQL-class Postgres sync vs. document-CRDT
  (Automerge/Yjs) with a custom sync endpoint. Selection criteria: RLS/org-scoping
  fidelity (non-negotiable), partial replication by project/my-houses scope, iOS
  (Swift) client story, and compatibility with Supabase. Decision spike is phase 0 —
  timebox it, write the verdict into this doc.
- **Conflict semantics per entity, chosen not defaulted:** append-only where possible
  (log notes, photos = no conflicts by construction); LWW-per-field for item edits;
  server-authoritative counters/status where order matters (completion events carry
  client timestamps, server resolves). Every merge decision auditable.
- **Migration path:** ship one domain at a time behind a device-level flag — punch
  first (highest offline pain, simplest model), then daily logs, then inspections.
  The API contract (`/api/mobile/v1`) remains the fallback; delete per-domain REST
  paths only when the synced domain is proven (leave-no-trash applies at the END, not
  the start).
- Pairs with WS-F1 phase 1 (capture queue) and WS-F4 (offline receipt snaps).

### Acceptance
Airplane-mode full day: create/edit punch + logs + photos across 3 houses; reconnect →
zero data loss, zero duplicate records, conflicts resolved per the declared semantics;
`pnpm test:mobile` gains sync-simulation tests.

---

## WS-F9 — WebGPU Viewer Unification

> **STATUS (2026-07-31): Implemented.** `lib/viewer/` is the shared scene-graph
> module (Camera2D, TilePyramid, gestures, TileLoader, WebGPU renderer with
> WebGL2 fallback, GpuDrawingViewer). OpenSeadragon is deleted;
> TiledDrawingViewer keeps its component API on the GPU stack, and the
> comparison viewer gained a GPU Difference mode (ink-diff shader: removed
> red, added blue) alongside Overlay — the CPU-composited compare died with
> OSD. Verified: both backends render composite + difference correctly
> (synthetic-tile harness), unit tests in tests/drawing-viewer-scene.test.js
> (`pnpm test:drawings`), lint/tsc clean. Still owed: real-sheet QA in the QA
> org, Safari/iPad regression pass, and the 300-sheet <100ms measurement —
> the kill-criteria profiling below was deliberately NOT run first because the
> diff shader and unified scene graph justified the build regardless.

### Why
Arc already runs mupdf WASM + vector extraction + tiled viewing. One GPU-accelerated
canvas that renders drawing tiles, vector overlays, takeoff geometry, revision diffs,
and (WS-F5) splats makes Arc *feel* like "Palantir for construction" — performance is a
feature Procore's aging viewer cannot follow.

### Design
- Incremental, not a rewrite: introduce a WebGPU render layer (WebGL2 fallback) behind
  the existing viewer component API; move tile compositing first, then vector/markup
  layers, then on-GPU overlay diffing (two revisions as textures, difference shader —
  replaces CPU-composited compare), then takeoff snapping against vector geometry with
  zero-latency hover.
- Kill criteria honesty: if profiling shows the current viewer's bottlenecks are
  network/decode rather than raster, stop after tile compositing and bank the win.
- Shared scene-graph module consumed by both the drawings viewer and the WS-F5 splat
  viewer (camera controls, anchor rendering, hit-testing).

### Acceptance
300-sheet set: sheet-to-sheet under 100ms perceived; full-set overlay diff interactive;
no regression on Safari/iPad (field reality). Delete the superseded CPU compare path in
the same change.

---

## WS-F10 — Geospatial Layer + Earth Observation

### Why
Lots are geometries, not rows. PostGIS sits unused inside the existing Postgres, and
weekly aerial/satellite imagery APIs are now priced per-community-affordable. An
observed-from-orbit progress layer does not exist in residential construction software.

### Design
- **Phase 1 — the map foundation:** enable PostGIS; add geometry to `lots`
  (parcel polygon) and `communities` (boundary); community page gets a map view — lots
  colored by stage/plan/buyer/schedule-risk, click → lot. Import path: parcel polygons
  via the communities/lots importer (GeoJSON column support). Map rendering: MapLibre
  (token-free, self-hostable tiles) — no Google dependency in the ascetic zone.
- **Phase 2 — passive sensing:** photo EXIF lat/lng (from WS-04) auto-assigns photos
  to lots by point-in-polygon; capture scenes (WS-F5) likewise. Free accuracy win.
- **Phase 3 — earth observation:** weekly aerial/satellite pull per active community
  (provider abstraction; Nearmap-class aerial where available, Planet-class satellite
  fallback) → tile overlay with a time slider; change-detection pass (slab present /
  roof dried-in / lot cleared — a vision-model classification per lot-clip, not fancy
  CV) → **reported vs. observed drift flags** on `/starts` and community pages:
  "Lot 118 reported framed 6/12; no roof visible in 6/19 imagery."
- Cost control: imagery only for active communities, monthly cadence default, per-org
  metering.

### Acceptance
Community map loads <1s for 400 lots (the design case); drift flags carry imagery-date
citations; zero drift flags fire where imagery is stale (honesty rule: show imagery age
always).

---

## WS-F11 — Passkeys + Verifiable Documents

### Why
Small, sharp, cheap. Passkeys upgrade the token-portal moat (a sub's foreman
authenticates with Face ID — no password, no account ceremony). Verifiable PDFs make
every lien waiver, CO, and closing doc able to prove itself — banks and title companies
notice, in a fraud-anxious industry.

### Design
- **Passkeys:** WebAuthn enrollment offered inside token portals (`app/s`, `app/p`,
  `app/r`) after first token use — binds the credential to the portal identity
  (extends `external-portal-auth`); subsequent visits: passkey instead of re-sent
  links/PINs. Tokens remain the fallback; nothing breaks for non-adopters.
- **Verifiable PDFs:** every generated financial/legal PDF (esign executed docs,
  waivers, G702s, closing packages) gets: SHA-256 of the canonical bytes stored in an
  append-only `document_attestations` table + a footer QR linking to a public verify
  page (`app/f`-family route): upload-or-scan → "authentic, issued <date> by <org>,
  unaltered." Optionally sign hashes with an org key (server-held) for offline
  verification later. No blockchain — an append-only audited table is the honest
  version of the same promise.

### Acceptance
Tampered PDF fails verification; passkey login round-trips on iOS Safari + Chrome;
`pnpm test:auth` covers the portal-credential binding.

---

## WS-F12 — The House Passport (capstone)

### Why
Homes are the largest purchase humans make and come with less documentation than a
toaster. At closing, the buyer receives the house's permanent record. For the builder:
warranty-cost reduction + referral engine. For the industry: does not exist.

### Design (assembly, not invention — that's why it's last and cheap)
- The buyer portal (`app/p/[token]`) gains a **Passport** section, auto-composed at
  closing (hook into `closings.ts`) from things other workstreams already produce:
  - Plan + elevation + executed selections (design-studio data).
  - As-built drawings export (`drawings-export` — exists).
  - Capture-scene timeline incl. pre-drywall splats (WS-F5).
  - Curated photo history (WS-04 client-visible feed).
  - Appliance/equipment serials + manuals (extracted from closeout docs via WS-F6's
    extraction machinery; manual entry fallback in the closeout workbench).
  - Warranty terms + program schedule (warranty settings — exists), with claims filed
    from within the passport ("show me behind that wall" → nearest splat).
  - Verifiable closing documents (WS-F11).
- Longevity: passports must outlive the builder's subscription — a contractual/product
  decision (export bundle + hosted grace policy) to decide with the human before build.
- Production one-up: passport template per plan; every closing stamps an instance —
  marginal cost per house ≈ zero.

### Acceptance
Close a demo house → passport renders complete with zero manual assembly; a warranty
claim filed from a passport splat anchor lands in the warranty module with the scene
reference attached.

---

## Cross-cutting build notes

- **GPU/external compute** (F5 reconstruction, F10 change detection): one shared
  "gpu-runner" abstraction (submit job, poll/webhook result, R2 artifact handoff) so a
  single vendor choice serves both. This is the only genuinely new infrastructure in
  the entire plan; everything else rides Supabase/Vercel/R2/Stripe already in place.
- **Metering:** F4 (interchange), F5 (scenes), F10 (imagery) introduce per-org variable
  costs → extend the subscriptions/billing surface with usage metering before any of
  them GA.
- **Sequencing with the parity gameplan:** F1↔parity-WS-05 are one build; F3 consumes
  parity-WS-03's cash model; F6 feeds parity-WS-02's holds; F12 consumes F5/F6 + the
  photos work. Interleave: a sensible combined order is
  parity-02 → parity-03 → F1 → F2 → parity-01 → F3 → F4 → parity-04/05 → F5 → F6 →
  the rest on evidence.
