# Procore Parity & One-Up Gameplan

**Status:** Implemented for WS-01 through WS-10; production migrations were applied on
July 31, 2026. WS-11 remains gated by its P6-shop prospect trigger.

**Source:** July 2026 deep review of procore.com (Preconstruction, Project Execution,
Cost Management, Resource Management, Analytics/Helix AI, Pay, platform) against Arc's
full surface inventory. This doc covers the *comparison-driven* work — closing gaps that
matter and converting each into a superiority position. The frontier-technology plays
(splats, virtual cards, voice agent, etc.) live in `docs/tech-frontier-gameplan.md`.

**Doctrine reminders that govern everything below** (from `CLAUDE.md`):
- Mutations live on project workbenches; org desks rank/aggregate/deep-link only.
- Posture branches only through choke points (`lib/product-tier.ts`, `lib/terminology.ts`,
  `lib/project-modules.ts`, `lib/financials/billing-model.ts`, `project-nav-items.ts`).
- Money is integer cents. Every query org-scoped. New entities complete the full
  registration checklist (RLS, RBAC catalog seed, search index, events, email allowlist,
  mobile API if field-relevant, cron registry).
- No `-v2` names; anything obsoleted is deleted in the same change.

**Priority tiers:**
- **P0** — commercial-posture credibility blockers; build first.
- **P1** — high-leverage one-ups on existing assets.
- **P2** — checkbox closers and small steals; batch opportunistically.
- **NG** — explicit non-goals; do not build without lost-deal evidence.

---

## WS-01 (P0) — Change Events + RFQ fan-out ("catch change before it's a CO")

### Why
The single largest financial gap vs. Procore. Their chain — Change Event → RFQ →
Commitment PCO / Prime PCO → CO — is the flagship Cost Management workflow. Arc jumps
straight from "someone noticed something" to a change order. For a commercial GC with 40
open events across 12 subs, the *event ledger* (exposure before commitment) is the
product. The one-up: events that create themselves from sources Arc already observes.

### Data model (proposal)
- `change_events` — org_id, project_id, number (per-project via `project-sequence`
  pattern, copy the RFI impl), title, description, origin_type
  (`manual | rfi | drawing_revision | selection | email | tm_ticket | inspection`),
  origin_id (polymorphic, nullable), scope (`in_scope | out_of_scope | tbd`),
  status (`open | pricing | pending_approval | converted | void`), rom_cents (rough
  order of magnitude), latest_price_cents (rolls up from RFQ responses), created_by,
  timestamps.
- `change_event_lines` — change_event_id, cost_code_id (nullable when cost codes off —
  respect `lib/financials/cost-codes-enabled.ts`), budget_line_id (nullable), description,
  qty numeric, uom, unit_cost_cents, rom_cents.
- `change_event_rfqs` — change_event_id, commitment_id (the sub being asked), status
  (`draft | sent | responded | declined | expired`), due_date, sent_at, responded_at,
  response_amount_cents, response_notes, attachment file refs via `file_links`.
- Link column on `change_orders`: `change_event_id` (nullable). No renames of existing
  CO machinery — the event layer sits **upstream** of the CO engine that already exists.

RLS/indexes per the registration checklist: `(org_id, project_id)` indexes, policies
copied from a recent neighbor, `(select auth.uid())` everywhere.

### Service & UI plan
- `lib/services/change-events.ts` — full service exemplar shape (`requireOrgContext` →
  `requirePermission` → logic → `recordEvent` + `recordAudit` → DTO). Key functions:
  create (with origin), price (manual line entry), sendRfqs (fan-out), recordRfqResponse,
  convertToChangeOrder (prime and/or commitment; pre-fills CO lines from event lines or
  winning RFQ), void.
- **RFQ delivery through the sub portal** (`app/s/[token]`) — new `rfqs` section:
  invited sub sees scope + attachments, submits price + notes + attachments, zero
  account. This is the one-up over Procore (their RFQ recipients need Procore accounts).
  Reuse `portal-links` capability helper + `external-portal-auth`.
- Project workbench: `app/(app)/projects/[id]/change-orders` grows a **Change Events**
  sub-tab (do NOT create a separate top-level tab; events and orders are one domain).
  Event detail sheet mirrors `invoice-detail-sheet.tsx` structure.
- Org desk: `/change-orders` desk adds an exposure band — open-event ROM + unconverted
  latest-price totals across projects. Read-only, deep-links to workbench.
- Exposure math: extend the existing `getChangeExposure` to include open change events
  (ROM until priced, latest price after), so budget forecast (WS-03) and reports see
  uncommitted change.

### Auto-catch (the one-up, phased behind the manual flow)
Emitters create **draft** events (never auto-send RFQs):
1. RFI answered with flag "answer implies scope change" (checkbox on the answer form,
   later AI-suggested).
2. Drawing revision processed → takeoff re-anchor delta exceeds threshold
   (`takeoff-reanchor` already computes deltas; wire an outbox job that drafts an event
   with the quantified lines). This is the flagship demo.
3. Selection change post-cutoff (production posture: this largely exists as
   selection-COs — do NOT duplicate; production keeps its selection-CO path, and the
   choke point is `getProjectFinancialFeatureConfig`).
4. Inbound project email classified as change-relevant (depends on WS-07).

### Registration checklist deltas
- RBAC keys: `change_events.read/write/convert` — grant to same roles holding
  `change_orders.*`; RFQ portal handled by portal token scopes.
- Search index: register `change_event`. Events + audit standard. Email: RFQ invite +
  response-received must be added to `EMAIL_NOTIFICATION_TYPES` (remember the
  silent-no-send bug).
- Mobile: read-only list under project in a later phase; not launch-blocking.

### Phases
1. Schema + service + workbench sub-tab + manual event → price → convert (1 migration).
2. RFQ fan-out + sub-portal section + notification emails.
3. Exposure integration (budget/forecast/report) + org desk band.
4. Auto-catch emitters (revision-delta first, RFI flag second).

### Acceptance
- Mixed-posture safe: production projects still route selection changes through
  selection-COs; commercial/residential get the event ledger. `pnpm test:financials`
  extended with event→CO conversion cases; draw regression gate untouched.

### Non-goals
- No Procore-style "Change Event line item Latest Price sync into CCO SOV" complexity in
  v1 — convert copies lines; live-sync later only if requested.

---

## WS-02 (P0) — Payment holds: compliance- and waiver-gated release

### Why
Procore Pay's actual value is not the FBO bank rail — it's "payment cannot release until
insurance is current and the waiver is signed." Arc has every ingredient
(`compliance-documents`, `compliance-autopilot`, `lien-waivers` incl. subtier,
`payments`, vendor bills) but does not hard-gate. Wiring the gate delivers ~80% of
Procore Pay with 0% money-transmitter burden, and converts compliance from reporting
into enforcement.

### Design
- `payment_hold_policies` (org-level, JSONB in `org_settings` if simple; own table if
  per-project overrides needed): which conditions block payment —
  `insurance_current`, `waiver_signed`, `compliance_docs_approved`, `retainage_rules_met`,
  plus per-condition enforcement level (`block | warn`).
- Hold evaluation is a **pure function** in `lib/services/payment-holds.ts`:
  `evaluateHolds(billId) -> { holds: Hold[], releasable: boolean }`, computed from
  existing compliance status + waiver records. No new state to drift; holds are derived,
  never stored (store only manual overrides).
- `payment_hold_overrides` — bill_id, hold_kind, overridden_by, reason (required),
  timestamps. Override requires a dedicated permission (`payments.override_hold`) —
  seed to admin/bookkeeper-with-SoD only, per the RBAC catalog-as-code migration.
- Enforcement point: the existing bill-payment mutation path in
  `payments.ts`/`org-payables` refuses (returns `{ success: false, error }`) when
  `releasable` is false and no override exists. UI shows hold chips on the bill row and
  payables desk (`/payables`) with one-click deep-links to the *cure*: the compliance
  request or the waiver signature chase.
- **Waiver auto-chase:** when a bill enters "approved, held on waiver," auto-send (or
  queue for one-click send) the waiver signature request through the existing sub-portal
  waiver flow (`app/s/[token]/waivers/[billId]`). The hold cures itself.
- **Pay-when-paid chains (one-up):** optional link `vendor_bills.funding_invoice_id` →
  when the linked owner invoice/draw is paid (Stripe webhook already observed), linked
  bills flip from `held_on_funding` to releasable. This is a capability Procore cannot
  ship because they never see owner-side money movement.

### Phases
1. Hold evaluation + block/warn enforcement + override with audit (no migration if
   overrides ride an existing pattern; else 1 small migration).
2. Waiver auto-chase wiring.
3. Pay-when-paid linkage.

### Acceptance
- `pnpm test:financials` cases: held bill cannot pay; override path audited; waiver
  signature cures hold; funding-linked release. Empty/loading/error/dark verified on
  payables desk chips.

### Non-goals
- No FBO/for-benefit-of accounts, no money transmission, no Commerce-Bank-style rails.
  Revisit only at meaningful payment volume, as a separate regulated-product decision.

---

## WS-03 (P0) — Continuous forecasting + snapshot comparison

### Why
Procore ships Advanced Forecasting Curves + formal snapshot rituals + a snapshot
comparison tool. Arc has CTC/WIP reports, variance alerts, baselines, snapshots — but no
time-phased view and no snapshot-vs-snapshot comparison. The one-up: Procore's forecast
is a manual ritual because their data is stale; Arc's should be **computed continuously**
and snapshotted automatically.

### Design
- **Nightly auto-snapshot:** extend the existing budget snapshot mechanism with a cron
  (`CRON_JOBS` + `vercel.json` + `PUBLIC_API_ROUTES`, GET handler) that captures a
  budget/forecast snapshot per active project (append-only, like `report_runs`).
  Retention: daily for 90 days, then monthly. Manual "formal" snapshots keep a label +
  status field so month-end packages still exist as named artifacts.
- **Comparison view:** in `financials/budget`, a Compare mode: pick any two snapshots
  (or snapshot vs. live), per-line variance columns + aggregate deltas. Pure read UI on
  snapshot rows — no new schema beyond ensuring snapshots store line-grain data.
- **Time-phasing:** forecast-CTC distributed across months using **actual schedule
  dates** (schedule items already carry per-item costs and dates; where linkage is
  missing, fall back to project start/end spread linear or front/back-loaded curve
  selectable per line). Surfaces: a time-phased forecast table in `financials/budget`
  and a new report `forecast-time-phased` in `lib/reports/definitions/financial.ts`.
  Rendering follows the dense-table doctrine — a table with month columns, not an
  S-curve chart, in v1.
- **Org cash-flow forecast (one-up):** new report `cash-flow-forecast` — inflows
  (open invoices/draws by expected date, recurring schedules) minus outflows (approved
  bills by due date, committed-but-unbilled spread by schedule) per week/month, org- and
  division-scoped via `reporting-scope`. This is the report Procore structurally cannot
  produce. (Monte Carlo bands over this live in the frontier gameplan; ship the
  deterministic version here first.)

### Phases
1. Auto-snapshot cron + comparison view.
2. Time-phased forecast table + report.
3. Cash-flow forecast report + `/reports` catalog registration + weekly exec snapshot
   inclusion.

### Acceptance
- Snapshot comparison correct against hand-computed fixtures; cron registered in
  `CRON_JOBS` mirror-checked; new reports in catalog with ambientScope honesty;
  `pnpm test:financials` extended.

---

## WS-04 (P1) — Photos as a tool (and a sensor)

### Why
Procore Photos (timeline, albums, tags, GPS/Maps, AI photo insights) is a daily-driver;
Arc's photos are a capture stream. This is Arc's weakest everyday field surface in the
comparison.

### Design
- Schema deltas on the existing photos tables: `album_id` (new `photo_albums` table),
  `location_id` (reuse `locations` service), `trade` (company_id nullable), `taken_at`
  (EXIF), `lat/lng` (EXIF), `ai_caption` text, `ai_tags` text[].
- Project `photos` tab rebuild: Timeline (by date) / Albums / Map (lots + geotags —
  production communities get per-lot filtering via the community lens) / search box that
  queries captions+tags. Pagination from day one (the doctrine).
- **AI captioning pipeline:** outbox job per uploaded photo → vision model captions +
  tags (trade, phase, visible elements). Follows the drawings-pipeline async-enrichment
  pattern (`drawings-pipeline-v2` fan-out + heartbeat reclaim). Captions power search
  ("pre-drywall electrical lot 42") through the existing search index + embeddings.
- **Buyer-facing curated feed (one-up):** per-photo `visibility` (`internal | client`)
  + a portal section in `app/p/[token]` showing client-visible photos grouped by date.
  Default internal; one-tap publish from the workbench and from mobile. Production
  posture's marketing weapon; residential's client-delight feature.
- Mobile: extend existing daily-log photo upload so all photos flow through one ingest
  path; add album/visibility controls to the iOS capture flow (`/api/mobile/v1` photos
  endpoints — new).

### Phases
1. Schema + tab rebuild (timeline/albums/filters) + EXIF extraction.
2. AI captioning outbox job + search integration.
3. Client visibility + portal feed.
4. Map view.

### Non-goals
- No 360/reality-capture here (splats are frontier WS). No standalone org-level photos
  desk — photos don't pass the desk test.

---

## WS-05 (P1) — Field Quick Capture (voice/photo → structured records)

### Why
Procore's most-loved field feature: speak or film → transcribed, structured punch item /
observation. Arc has the transcription muscle (meetings) and every target entity.

### Design
- iOS-first (this is a field feature): a single capture affordance in the Arc app —
  hold-to-talk or short video → upload → server transcribes (reuse the meeting
  transcription stack) → LLM structured-extraction to a **typed draft**:
  `punch_item | observation | daily_log_note | task | rfi_draft`, with
  project/lot inferred from the active context (`my-houses` scope) and confirm-before-
  save UX. Never auto-commit; drafts land in a review tray.
- Server: `lib/services/quick-capture.ts` + `/api/mobile/v1/capture` endpoint; extraction
  behind the ai-assistant harness so tool-permissions and org AI gating
  (`ai_search_enabled` master flag pattern) apply.
- Web gets the same affordance in daily-logs and punch workbenches (mic button) —
  shared extraction service.
- This WS is the parity slice of the fuller realtime voice agent (frontier gameplan
  WS-F1); build the async capture first, upgrade transport later without changing the
  extraction contract.

### Acceptance
- Round-trip: 15-second spoken punch item lands as a draft with photo attached in <30s;
  offline capture queues and syncs. `pnpm test:mobile` contract updated.

---

## WS-06 (P1) — Submittal register generation + first-class revisions

### Why
Two gaps in one domain. Procore treats submittal revisions (Rev 0→1→2) as first-class
history; Arc's revision handling is thin. And the one-up — auto-building the register
from spec ingest — turns project setup drudgery into a "how did it do that" moment.

### Design
- **Revisions:** promote to a real model — `submittal_revisions` (submittal_id, rev
  number, status, superseded_at, files, review outcomes) with the review-step machine
  operating per-revision; workbench shows revision history rail; reviewer portal
  (`app/r/[token]`) pins to a revision. Migrate existing thin data in the same change
  (delete the old path — no parallel implementations).
- **Register generation:** extend `specs-pipeline` with a submittal-requirement
  extraction pass: for each CSI section, detect "submit/shop drawings/product data/
  samples" obligations → draft register rows (section ref, type, suggested trade via
  cost-code/commitment mapping, suggested lead time). Land as **drafts** in the
  submittals workbench with bulk accept/edit. Confidence shown; every row cites the
  clause (links into the specs tab).
- One-up detail Procore lacks: registered submittals link back to the live spec section,
  so a spec *revision* flags affected submittals for re-review.

### Phases
1. Revision model + UI + portal pinning (migration).
2. Extraction pass + draft register UX.
3. Spec-revision → submittal flagging.

---

## WS-07 (P1) — Project email ingest = Emails tool + Correspondence, in one move

### Why
Procore ships two tools (Emails: project inbox; Correspondence: typed formal notices,
tier-gated to 10–30 types). Arc already runs inbound email for AP
(`payables-email-ingest` + Resend inbound webhook). Generalizing it closes both gaps
Arc-natively and feeds WS-01's auto-catch.

### Design
- Per-project ingest address (slug pattern mirrors AP ingest; same Resend catch-all
  domain infrastructure, extend the webhook router).
- `project_emails` — org_id, project_id, direction, from/to/cc, subject, body refs
  (store bodies in files/R2, not rows), attachments via `files`, thread_id,
  classification (`correspondence | rfi_related | co_trigger | bill | submittal_related |
  general`), classified_by (`ai | user`), linked_entity (polymorphic, nullable).
- AI classification via outbox job (same pattern as WS-04 captioning). Classification
  routes: bills → existing AP ingest path (do not fork it); CO-trigger → draft change
  event (WS-01); everything → searchable correspondence log.
- Workbench surface: a **Correspondence** tab (project-level; commercial + residential
  postures via `project-nav-items.ts` `postures:` field; production off by default) —
  threaded list, filters by classification, link-to-entity actions.
- **Formal notices (one-up over their letter registry):** notice templates (delay
  notice, NCR, etc.) as generated PDFs via the `lib/pdfs/esign.ts` family, sent through
  the mailer with delivery/read events, e-signable natively. Procore needs DocuSign +
  manual filing for this.
- Outbound: BCC-to-record address so users' normal email client files into the log —
  cheapest possible adoption path; no "compose inside Arc" requirement in v1.

### Phases
1. Ingest + storage + manual classification + tab.
2. AI classification + entity linking + WS-01 hook.
3. Notice templates + e-sign + delivery tracking.

### Non-goals
- No full email client (compose/reply UI) in v1. No per-user mailbox sync/OAuth —
  project addresses and BCC only.

---

## WS-08 (P2) — Structured forms (generalize the inspections engine)

- Do NOT build a PDF filler. Extract the checklist-template engine from `inspections`
  into a shared structured-forms core (sections, item types: checkbox/choice/number/
  text/photo/signature; org-level templates; runs against project/lot/vendor).
- Inspections become the first consumer (no behavior change); new consumers: safety
  forms, site-specific plans (covers Procore's Action Plans use case via templates with
  required signatures + blocking items), ad-hoc org forms.
- Responses are rows, not PDFs → queryable, reportable, triggerable (failed item →
  task/observation, reusing the inspections spawn mechanic).
- PDF *output* (a filled form rendered for the record) via the existing PDF stack.

## WS-09 (P2) — Small parity steals (batch these)

Each is small, self-contained, and user-visible; batch into a hardening pass:

1. **Drawing markup inheritance** — carrying markups (except freehand) onto the next
   revision, with a per-markup "carried from Rev N" badge. `drawing-markups` +
   pipeline hook.
2. **Personal vs. published markup layers** — `visibility` on markups + explicit
   Publish action. (Check current behavior first; if all markups are already shared,
   this is one column + filter.)
3. **Daily-log auto-weather** — weather API fetch by project/community location at log
   creation; cache per (location, date). Verify not already present before building.
4. **OSHA 300/300A/301 export** — render from existing incident data; add recordability
   classification fields if missing. The year-end artifact is the feature.
5. **RFI forward-by-email joins the workflow** — forwarding an RFI to an external email
   creates a portal-tokened participant whose reply files into the RFI.
6. **Conditional invoice auto-approval** — org rules (amount thresholds, vendor
   trust tier) that let the financials review queue auto-pass matching items, with
   audit. Extends `financials-review-queue`.
7. **Spec section → email distribution** — send a spec section (with files) from the
   specs tab through the mailer.

## WS-10 (P2) — Reporting: saved views, schedules, and export — not a builder

- **Saved report configurations:** persist parameter sets per report slug per user/org
  ("My WIP — Division South, monthly") on top of the existing catalog; list them on
  `/reports`.
- **Scheduled delivery:** cron that runs saved configs and emails CSV/PDF (extend
  `report_runs`; email type must enter the allowlist).
- **Data export surface:** a documented, token-authed CSV/JSON export endpoint per
  catalog report (org-scoped, permission-checked) — enough for the customer's analyst
  or accountant without building BI. (A fuller MCP/API story is frontier WS-F2.)
- **Self-benchmarks:** production reports (cycle-time, margin-by-plan, even-flow) gain
  trailing-period comparison columns — "vs. your last 4 quarters" — Arc's answer to
  Procore's fleet benchmarks, requiring no fleet.

### Non-goal
- No drag-and-drop report designer, no Power BI connector, no semantic layer. Revisit
  only on repeated enterprise lost-deal evidence.

## WS-11 (P2, commercial-gated) — Scheduling interop: XER/MPP import

- Parser for Primavera P6 `.xer` (text, documented-ish) and MS Project `.mpp`
  (use `.xml` MSPDI export as the supported path; raw `.mpp` is a licensing/format
  swamp — accept MSPDI and say so).
- Import maps to native schedule items/dependencies via the existing importer framework
  (`import-definitions.ts` — new `schedule` importer with column/field mapping and
  validation preview). Re-import updates in place (match on activity ID) rather than
  duplicating.
- One-way import only in v1; export to XER is NG until demanded.
- **Trigger condition:** build when commercial pipeline shows a P6-shop prospect; not
  before. Everything upstream of this WS ships without it.

---

## Explicit non-goals (the "say no" list)

Recorded so future sessions don't relitigate:
- **BIM / model coordination / IFC** — wrong segment; revisit only if commercial moves
  past $50M GCs.
- **Equipment fleet & telematics; Materials tracking; LaborChart-style workforce
  planning** — the trade-load schedule view (frontier/starts work) covers the useful
  fraction.
- **App marketplace** — MCP server (frontier WS-F2) is the integration story.
- **Construction Network / public bid marketplace** — network effects can't be copied;
  the counter is zero-friction token portals.
- **Procore Pay-style FBO rails, insurance brokerage, training/certification center** —
  different businesses.
- **GPS clock-in / crew surveillance features** — measure output (schedule/PO
  completions), not input.

## Sequencing summary

| Order | WS | Depends on |
|---|---|---|
| 1 | WS-02 payment holds | — (pure wiring) |
| 2 | WS-03 forecasting/snapshots | — |
| 3 | WS-01 change events (phases 1–3) | — |
| 4 | WS-04 photos | — |
| 5 | WS-05 quick capture | — |
| 6 | WS-06 submittals | specs pipeline |
| 7 | WS-07 email ingest | feeds WS-01 phase 4 |
| 8 | WS-01 phase 4 auto-catch | WS-06/07, takeoff re-anchor |
| 9 | WS-08 forms, WS-09 steals, WS-10 reporting | opportunistic |
| 10 | WS-11 XER import | commercial deal evidence |

Every WS independently shippable; nothing here blocks the production-desks branch work
in flight.
