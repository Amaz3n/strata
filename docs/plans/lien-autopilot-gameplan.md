# Lien-Deadline Autopilot Gameplan

> **Status: ACTIVE PLAN — intent, not a description of the system.**
> Nothing in this document is guaranteed to exist. Never infer current app
> behavior from it. Source of truth is the code, `CLAUDE.md`, and the
> reference docs at the `docs/` top level.

**Status:** Awaiting execution. Written 2026-07-31.
**Audience:** an LLM executor. Follow directives literally; STOP means stop and ask
the human. This domain carries LEGAL correctness risk — every STOP in this doc exists
because a wrong deadline is worse than no deadline.

---

## 0. What this is

Mechanics-lien rights are governed by state-by-state statutory deadlines: preliminary
notices (e.g., Florida's Notice to Owner within 45 days of first furnishing;
California's 20-day preliminary notice), lien filing windows (e.g., FL 90 days from
final furnishing), and notice-of-commencement mechanics. Miss a deadline, lose the
lien right. Levelset built a company on exactly this before Procore acquired it.

Arc knows every input: the project's state, when work started (commitments, daily
logs, first bill), payment status, and who the parties are. The autopilot: compute
every deadline per project per party, warn ahead, generate the notice documents, and
(later, via partner) e-file. Two sides:
- **Own-rights side (the builder as claimant):** builder's own notice/lien deadlines
  against owners on custom/commercial jobs.
- **Exposure side (the builder as payer):** which subs/suppliers have live lien
  rights against the builder's projects — feeding payment holds and closing/title
  readiness (a production closing with an outstanding sub lien window is a title
  problem).

## 0.1 Ground truth (verified 2026-07-31)

- **Zero deadline logic exists.** Grep for preliminary-notice/NTO/notice-of-
  commencement/intent-to-lien across the repo returns nothing. What exists is
  waivers only:
  - Payables: `lib/services/lien-waivers.ts`, table `lien_waivers` (waiver_type
    `conditional|unconditional|final`, status, amount_cents, through_date,
    token-signed via sub portal, subtier requirements incl.
    `listMissingSubtierWaiversForBill`).
  - Receivables: `lib/services/invoice-lien-waivers.ts`, table
    `invoice_lien_waivers` (4 statutory types, `released_by_payment_id`).
- **Geography is the gap:** `projects` has NO state column — address lives in
  untyped `location` jsonb; the de-facto shape contract is `formatProjectLocation()`
  in `lib/services/external-portal-auth.ts:132` (`address|formatted` else
  `street1,street2,city,state,postal_code|zip`). `communities` HAVE typed
  `city/state/postal_code`; `lots.address` is text. Production resolver: project →
  lot → community.state.
- **First-furnishing signal:** `commitments.start_date` exists (closest structured
  field); actual first work is derivable from daily logs / first `job_cost_entries`
  row / schedule actuals. No `first_work_date` column anywhere.
- **The sweep pattern to copy:** `compliance-autopilot`
  (`lib/services/compliance-autopilot.ts` + its cron route): `withCronRun`, reminder
  day-sets (30/14/3), deliveries-table dedupe with `weekKey()`, typed metrics,
  triple registration (CRON_JOBS + vercel.json + PUBLIC_API_ROUTES), GET handler.
- **Payment holds shipped:** `lib/services/payment-holds.ts` — derived holds, policy
  table, overrides. The exposure side plugs in here.
- **PDF stack:** `lib/pdfs/lien-waiver.tsx` exists (statutory body + notary block) —
  the pattern for notice documents.

---

## WS-L1 — Geography + party graph prerequisites

Deadlines are functions of (state, dates, party role). Fix the inputs first.

1. **Project state resolver:** `lib/services/lien/geography.ts` —
   `resolveProjectLienState(projectId) -> { state, source: 'project_location' |
   'lot_community' | 'org_default' | 'unknown', confidence }`. Reads
   `projects.location` jsonb via the formatProjectLocation shape, falls back
   lot→community for production, else org address state. `unknown` is a first-class
   result — the UI must show "set the project state to enable lien tracking," never
   guess. Do NOT add a `state` column to projects in v1 (the jsonb is the shape
   contract everywhere); revisit only if resolver misses exceed 5% in practice.
2. **First-furnishing model:** per (project, company) —
   `deriveFirstFurnishing(projectId, companyId) -> { date, source:
   'commitment_start' | 'first_daily_log_presence' | 'first_cost_entry' | 'manual',
   confidence }` with a manual override stored on the tracking row (WS-L2). Show the
   source next to every derived date, always.
3. **Roles:** claimant chains matter (GC vs sub vs sub-tier vs supplier). V1 models
   two perspectives only: builder-as-claimant (vs. the owner) and
   direct-sub-as-claimant (vs. the builder). Sub-tier exposure rides the existing
   subtier-waiver machinery; deeper chains are out of scope.

## WS-L2 — The rules engine + deadline register

### Design principle
Statutes are DATA, not code. The engine is a pure evaluator; rules live in versioned
data files reviewed by a human (and ideally counsel) before activation.

1. **Rule format:** `lib/lien-rules/{STATE}.ts` exporting a typed `LienRuleSet`:
   ```ts
   interface LienRuleSet {
     state: 'FL' | 'TX' | ...
     version: string           // date-stamped; bump on any legal review
     reviewedBy: string        // human name — REQUIRED to activate
     residentialCommercialSplit: boolean
     rules: LienRule[]
   }
   interface LienRule {
     key: string               // 'fl_notice_to_owner'
     appliesTo: 'claimant_direct' | 'claimant_sub' | 'exposure_sub'
     trigger: 'first_furnishing' | 'last_furnishing' | 'notice_of_commencement'
              | 'completion' | 'invoice_unpaid'
     offsetDays: number
     offsetKind: 'calendar' | 'business'
     deadlineKind: 'preliminary_notice' | 'lien_filing' | 'notice_of_intent'
                   | 'suit_filing' | 'noc_expiry'
     documentTemplate?: string // key into the notice-document templates (WS-L3)
     citation: string          // statute reference, displayed in UI
     notes: string
   }
   ```
2. **STOP — rule authoring:** the executor writes the ENGINE and the FORMAT, and may
   draft FL + TX rule sets from public statutory sources as PROPOSALS, but rule sets
   activate only after the human marks `reviewedBy`. Unreviewed sets run in
   shadow mode (compute, display "unverified — informational", never notify).
   The UI must carry a persistent disclaimer: deadline tracking is informational,
   not legal advice. Do not soften or remove this disclaimer.
3. **Register table** (one migration, then STOP):
   `lien_deadlines` — org_id, project_id, company_id nullable (null = builder's own
   right), perspective (`own_right | exposure`), rule_key, rule_version, state,
   trigger_source jsonb (what derived the trigger date + confidence),
   trigger_date, deadline_date, status (`upcoming | urgent | missed | satisfied |
   waived_off | not_applicable`), satisfied_by (`notice_sent | lien_waiver |
   payment | manual`), satisfied_ref jsonb, computed_at, superseded_at.
   Deadlines are RECOMPUTED (derived), not hand-maintained: the sweep recomputes and
   supersedes stale rows rather than mutating history (append + supersede — the
   audit trail matters legally). Indexes on (org_id, deadline_date) and
   (org_id, project_id).
4. **The sweep:** cron `lien-deadline-sweep` (daily; copy the compliance-autopilot
   route + dedupe + metrics shape exactly; triple registration). Per org: resolve
   states → evaluate active rule sets against projects/commitments/bills → upsert
   register → notifications at 21/10/3 days (day-set pattern) for `own_right`,
   and exposure summaries weekly. Email types into `EMAIL_NOTIFICATION_TYPES`.
5. **Satisfaction wiring:** a signed unconditional waiver (existing tables) or a
   recorded payment auto-satisfies matching exposure rows; sending a notice (WS-L3)
   satisfies its notice deadline. Match on (project, company, rule kind, period).

## WS-L3 — Notice documents + surfaces

1. **Documents:** notice templates (FL Notice to Owner first) rendered via the PDF
   stack, following `lib/pdfs/lien-waiver.tsx`'s statutory-body pattern; inputs =
   owner name/address (from project client), legal description (project location /
   lot), claimant details (org), first-furnishing date. Generated notices are
   files (category `permits`? NO — add nothing; use `financials` category) linked
   via `file_links`, and satisfaction rows reference them. Certified-mail/e-file
   dispatch is a PARTNER integration — STOP; v1 output is "print-ready + mailing
   instructions."
2. **Surfaces (bands, not desks):**
   - `financials/waivers` project tab gains a "Lien deadlines" band (both
     perspectives for this project, with citation + source-of-date chips).
   - `/payables` desk: exposure chips on vendor rollups ("lien window open,
     $48k unpaid, 12 days to NTO deadline").
   - Closing readiness (production `closing` + `project-close-readiness` service):
     open exposure rows block the "clear to close" checklist — title companies ask
     exactly this question.
   - Payment holds: add optional hold kind `lien_exposure_review` (warn-level
     default) to `payment-holds.ts` — a bill whose vendor has a live unpaid lien
     window gets a warn chip; org may raise to block. Follow the existing
     PaymentHoldKind extension points (`evaluatePaymentHoldFacts` is pure — extend
     its facts input).
3. **Sub-side (network seeding, later phase):** offer the same deadline tracking TO
   subs through the sub portal for their own rights on Arc projects. Design only;
   do not build in v1.

## Acceptance
- Rule engine: golden tests per rule set — fixture (dates, roles) → expected
  deadlines, incl. business-day arithmetic and month-end edges. 100% of rules
  covered by at least one fixture.
- Shadow mode verified: unreviewed rule sets never notify, never hold, render only
  with the unverified banner.
- Idempotent sweep: unchanged inputs → zero new register rows.
- A signed unconditional waiver in the QA org satisfies its exposure row within one
  sweep.
- `pnpm lint && npx tsc --noEmit`; `pnpm test:financials` extended.

## Sequencing
WS-L1 → WS-L2 (engine + FL shadow) → human review activates FL → WS-L3 documents +
surfaces → TX next, then states on customer demand.

## Non-goals
- Arc is not a law firm: no legal advice, no auto-filing, no suit tracking.
- No deep sub-tier chains in v1.
- No per-county recording-office integrations (partner territory).
