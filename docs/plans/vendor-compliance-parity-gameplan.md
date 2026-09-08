# Vendor Compliance & Prequalification Gameplan — fix the record, then beat the COI services

> **Status: ACTIVE PLAN — intent, not a description of the system.**
> Nothing here is guaranteed to exist. Never infer current app behavior from it.
> Source of truth is the code, `CLAUDE.md`, and the reference docs at the `docs/`
> top level. **When every workstream below is done, delete this file** and fold
> anything durable into a new reference doc `docs/vendor-compliance.md` (the
> policy-line model, trust tiers, the agent loop, and the resolver contract) and
> into `CLAUDE.md`'s deep-dives list.

**Written:** 2026-09-02, from a code review of the company detail page
(`app/(app)/directory/[id]`), the compliance services
(`lib/services/compliance*.ts`), the prequalification services
(`lib/services/prequalification*.ts`), both vendor-portal sections under
`app/s/[token]/`, and the payment-hold integration. Every finding in Phases A and
B was confirmed in code on that date. File:line references may have drifted —
**re-locate by symbol name before editing.**

**Audience:** an LLM executor with repo access, plus the human who owns STOP gates.

**Companions:** `docs/plans/procore-parity-gameplan.md` WS-02 (payment holds; still
authoritative for the hold engine), `docs/plans/vendor-workspace-gameplan.md`
(vendor-side surfaces), `docs/plans/external-access-gameplan.md` (person-not-token
access, which the agent portal in Phase D builds on).

---

## 0. How to execute this plan

### Rules that override everything below

1. **Local dev points at PRODUCTION Supabase.** Never run INSERT/UPDATE/DELETE/DDL
   through the app, the CLI, or the Supabase MCP. `execute_sql` is SELECT-only.
2. **Never apply a migration.** Write it into `supabase/migrations/` as
   `YYYYMMDDHHMMSS_name.sql`, then STOP and tell the human. Code may assume the
   planned schema; say clearly that the migration is pending.
3. **Never touch `supabase/pending-migrations/`.**
4. **Search before writing.** Assume the helper exists. The compliance resolver,
   the hold engine, the COI extraction pipeline, the portability service, and the
   vendor portal all exist; extend them, never build a parallel one.
5. Follow `CLAUDE.md` exactly: services own logic, every query org-scoped,
   integer cents, `{ success, error }` from actions, Zod on every action input,
   tokens only, radius 0, empty/loading/error/dark for every view, no `-v2`
   names, delete what you replace.
6. **Posture rule.** Nothing here branches on `product_tier` or `property_type`
   inline. Insurance requirements are the same shape for a custom home and a
   $40M commercial job; only the numbers differ, and those live in templates.
7. **The gate and the screen must never disagree.** Every verdict a screen shows
   comes from `buildComplianceStatus` / `resolveEffectiveRequirements`, and the
   payment hold reads the same function. Any workstream that adds a verdict adds
   it there first and renders it second.
8. **A model proposes; a person or a rule decides.** Extraction output is a claim
   (`lib/payments/ap-verification.ts` doctrine). The only automated approval in
   this plan (WS-D4) is an org-configured rule over high-confidence claims, and
   it is recorded as a system decision, never as a person's.
9. A workstream is done only when its **Definition of Done** is fully checked and
   the verification commands pass. Do not report partial completion as completion.
10. Each **STOP** names a human decision. Do not route around it.

### Execution order

```
A  Compliance correctness            (defects from the review; no new concepts)
B  Prequalification correctness      (defects + the missing loop)
C  Policy-line compliance model      (the TrustLayer core: lines, forms, holder)
D  Agent loop and trust tiers        (chase the agent; grade the source; auto-clear)
E  Beyond the COI services           (one-cert-many-requirements, fan-out, exposure, wrap-ups)
F  Prequalification evaluation       (scoring, trade scope, desk)
G  Tests, reference doc, plan deletion
```

A and B are independent of each other and may run in parallel. C depends on A1
(supersede timing) and A4 (dates). D depends on C. E depends on C and D. F depends
on B. G closes everything. Inside a phase, workstreams marked ∥ may run in parallel.

### Verification commands (run exactly these)

```bash
pnpm lint && npx tsc --noEmit
pnpm test:financials      # includes tests/compliance-system.test.js and tests/prequalification-program.test.js
pnpm test:auth
pnpm test:mobile          # lib/mobile/payables.ts reads compliance status
pnpm db:schema:check
```

### What "level with TrustLayer" means, and what "beyond" means

Level: every ACORD 25 policy line is a first-class fact with its own limit, the
endorsement claim is verified from the attached form rather than a checkbox, the
certificate holder is matched to the builder's legal entity, deficiency letters go
to the insurance agent with the exact line or form that is short, and a certificate
submitted by the agent outranks one forwarded by the sub.

Beyond: one certificate upload satisfies every insurance requirement at once; an
agent's renewal lands at every builder the vendor works for; the builder sees
uninsured exposure in dollars per project and per owner; wrap-up programs waive the
right lines automatically; and none of this needs a paid human-review desk because
review is by exception.

---

## Phase A — Compliance correctness

Defects confirmed in the 2026-09-02 review. Each is small, none introduces a new
concept, and A1 must land before anything in Phase C or D generates renewals.

### WS-A1 — Supersede on approval, not on upload  ✅ DONE

**Why.** `uploadComplianceDocument`, `uploadComplianceDocumentFromPortal`
(`lib/services/compliance-documents.ts`) and `shareComplianceDocumentToOrg`
(`lib/services/compliance-portability.ts`) call `supersedePriorDocuments`
unconditionally after insert. A sub who renews early goes from `met` to `pending`
immediately, `is_compliant` flips false, and the block-tier `compliance_docs_approved`
hold stops their payables until a reviewer opens the tab. If the renewal is rejected,
the still-valid certificate stays superseded. The portal's "Replace" button on a met
row invites exactly this.

**Tasks.**
- [x] Remove the `supersedePriorDocuments` call from all three insert paths.
- [x] In `reviewComplianceDocument`, when `decision === "approved"`, supersede prior
      live documents of the same `(company_id, document_type_id)` **before** the
      status update, in that order, so `compliance_documents_live_per_requirement_uidx`
      cannot raise 23505. Same in WS-D4's auto-clear path.
- [x] `buildComplianceStatus`: when a requirement has a live approved non-expired
      document AND a newer live pending document, state stays `met` and
      `ComplianceRequirementStatus` gains `pending_replacement: ComplianceDocument | null`
      so the tab and portal can say "renewal under review" on a met row.
- [x] `listPendingComplianceReviews` and the autopilot's `latestDocumentsByCompanyAndType`
      already skip superseded rows; confirm both still choose the newest live document
      when an approved one and a pending one coexist (the pending one is the review
      item; the approved one is the verdict).
- [x] Portal `compliance-client.tsx`: a met row with `pending_replacement` shows
      "Renewal sent" instead of a second Replace button.
- [x] Builder `compliance-workspace.tsx` row note: "Renewal waiting on your review".

**Definition of done.**
- [x] Unit test in `tests/compliance-system.test.js`: uploading over an approved
      document leaves `is_compliant` true; rejecting the replacement leaves the
      prior approval live; approving the replacement supersedes the prior.
- [x] Source-shape test: no insert path references `supersedePriorDocuments`;
      `reviewComplianceDocument` calls it before the status write.
- [x] Portal and tab render the renewal state; dark mode checked.
- [x] `pnpm test:financials` green.

### WS-A2 — Chase deficiencies, not only absence ∥  ✅ DONE

**Why.** `buildReminder` in `lib/services/compliance-autopilot.ts` only looks at
expiry once a document is approved, and the workspace's `outstanding` set excludes
`deficient`. An approved GL certificate at $500k against a $1M requirement, or one
missing an endorsement, blocks payment forever and nobody is told.

**Tasks.**
- [x] Autopilot resolves the same `ComplianceStatusSummary` the tab does (call
      `resolveStatusFromInputs` over the org's vendors rather than re-deriving
      "latest document per type"; export it for this caller). A `deficient` state
      produces a `deficient` reminder kind with the deficiency message in the
      payload, bucketed weekly like `missing`.
- [x] `compliance_autopilot_deliveries.reminder_kind` CHECK gains `deficient`.
      Migration: `YYYYMMDDHHMMSS_compliance_autopilot_deficient_reminders.sql`.
      **STOP — migration pending.**
- [x] `sendComplianceAutopilotEmail` and `buildComplianceAutopilotSubject` render
      the deficiency ("Coverage below required minimum ($1,000,000)") beside the
      document name.
- [x] `ComplianceRequestDialog` `outstanding` includes `deficient` and labels it
      with the deficiency message.
- [x] Builder-side `compliance_document_expiring` event: emit a sibling
      `compliance_document_deficient` on first detection only (bucket on the
      document id), in-app only; do **not** add it to `EMAIL_NOTIFICATION_TYPES`
      without a settings row.

**Definition of done.**
- [x] Test: a requirement with `min_coverage_cents` above the approved document's
      coverage yields one `deficient` reminder and one delivery row; a second run
      the same week yields none.
- [x] Test: the request dialog's outstanding set includes deficient rows.
- [x] Migration written, listed as pending in the PR description.

### WS-A3 — An honest badge and a reachable tab ∥  ✅ DONE

**Why.** `is_compliant` is true with monitoring off or with zero requirements, so
the header badge (`DeferredComplianceBadge`), the directory `ComplianceFlag`, and
every gate read "Compliant" for a sub nobody has enrolled. Since explicit enrollment
shipped (2026-08-26), that is every new sub. The tab is hidden until the vendor
has history, and add-to-directory never offers the template, so the only path to
enrollment is the W-9 card's link.

**Tasks.**
- [x] `ComplianceStatusSummary` gains `enrollment: "unenrolled" | "no_requirements" | "active"`.
      Set in `applyComplianceMonitoring` and `buildComplianceStatus`.
- [x] `DirectoryVendorHeaderSignals.complianceReady` becomes a three-state
      `complianceState: "compliant" | "action_required" | "unenrolled" | null`.
      Badge copy: "Compliant" / "Action required" / "Not enrolled" (muted).
- [x] `ComplianceFlag` in `components/directory/directory-table.tsx` renders the
      same three states; `ComplianceAlert` counts unenrolled trade partners as a
      separate line, never as compliant.
- [x] `layout.tsx` tab rule: the Compliance tab shows for **every** vendor company
      (`isVendorCompany`), not only trade partners with history. The tab's empty
      state is the enrollment step. Keep Prequalification gated as today.
- [x] `add-to-directory-sheet.tsx`: when the chosen opening role is a trade-partner
      key, show a single checkbox "Apply the org compliance template" (default on
      when the org template is non-empty). The company create action calls
      `setCompanyRequirements` + `setCompanyComplianceMonitoring` after insert.
      Business logic stays in `lib/services/directory.ts` / `compliance-documents.ts`.
- [x] Bid-invite and commitment warnings (`getBidInviteComplianceWarnings`,
      `evaluateSubcontractExecutionCompliance`) say "not enrolled in compliance"
      for the unenrolled state rather than passing silently. Warn-only; the hold
      policy decides blocking in WS-C6.

**Definition of done.**
- [x] Test: zero requirements → `enrollment = "no_requirements"`, badge is not
      "Compliant"; monitoring off → `"unenrolled"`.
- [x] Test: creating a subcontractor with the template checkbox on writes
      requirements and enables monitoring; off writes neither.
- [x] Manual: a fresh vendor company shows the Compliance tab with the enrollment
      empty state; header badge reads "Not enrolled".

### WS-A4 — One clock, validated dates ∥  ✅ DONE

**Why.** The status build treats a document as expired from midnight UTC on its
expiry date, autopilot treats that day as day zero, and the portal says "Expires
today" — three answers to "is this current", one of which decides whether a
subcontractor is paid. `isActiveWaiver` compared date strings lexicographically.
Upload and waiver schemas accept `z.string()` for dates.

**Corrected while executing.** The review claimed a malformed expiry would read
as "expires today" indefinitely. It would not: all four columns
(`compliance_documents.effective_date`/`expiry_date`,
`company_compliance_requirement_waivers.expires_at`,
`prequalifications.expires_at`) are Postgres `date`, so a bad string was rejected
at write time and production holds **zero** malformed values (verified by SELECT,
2026-09-02). What the Zod schemas actually buy is a clean validation message
instead of a Postgres 22007 surfacing as a generic action failure. The
three-clocks disagreement was real and is the substance of this workstream.

**Tasks.**
- [x] `effective_date`, `expiry_date`, waiver `expires_at`: `z.string().date()`,
      matching `lib/validation/prequalification.ts`. Portal POST returns the Zod
      message on a bad date.
- [x] One date helper in `lib/services/compliance-dates.ts` (pure): `todayKey()`,
      `daysUntil(dateKey, today)` on UTC date-only math, `isExpired(dateKey, today)`
      defined as `daysUntil < 0`. `compliance-documents.ts`, `compliance-autopilot.ts`,
      `compliance-portability.ts`, `prequalification.ts`, and the portal client all
      import it. Delete the four local copies.
- [x] Backfill check: `SELECT` (read-only) any `compliance_documents.expiry_date` or
      waiver `expires_at` not matching `^\d{4}-\d{2}-\d{2}$`. **STOP** and report
      counts; the human decides on a data fix migration.

**Definition of done.**
- [x] Test: a document expiring today is `expiring` with `days_until_expiry = 0`
      everywhere, `expired` tomorrow everywhere.
- [x] Test: the upload schema rejects `"next year"` and `"2026-13-40"`.
- [x] Grep: no remaining `new Date(document.expiry_date)` in the compliance slice.

### WS-A5 — Mount the review queue or delete it ∥  ✅ DONE

**Why.** `listPendingComplianceReviews` (ranked by held dollars) has no caller.
Control Tower counts with its own query in `lib/services/dashboard.ts` and links to
`/directory?compliance=pending`, which opens `ComplianceAlert` — a per-vendor score
list. Reviewing means opening vendors one at a time.

**Decision (taken here, no STOP):** mount it. Reviewing certificates is a whole job
for the office admin / bookkeeper on a 60-sub builder, and it passes the desk rule.

**Tasks.**
- [x] `ComplianceAlert`'s sheet body becomes the queue: rows from
      `listPendingComplianceReviews`, one per pending document, ordered by
      `heldCents` desc, showing vendor, document, submitted via portal or builder,
      days waiting, held amount, and a "Review" action that opens the existing
      `ComplianceReviewDialog` in place (mirror `review-detail-overlays.tsx`'s
      in-place pattern). `truncated` / `heldCentsTruncated` rendered as floors.
- [x] Delete `scoreComplianceIssue` and the watch-list shape if nothing else reads
      it; keep the "not enrolled" and "expiring" counts from WS-A3 as a second
      section below the queue.
- [x] `dashboard.ts` uses `listPendingComplianceReviews(...).totalPending` and
      `heldCents` instead of its own count, so the tile and the sheet agree.

**Definition of done.**
- [x] Clicking the Control Tower review count lands on a queue whose count equals
      the tile.
- [x] Reviewing from the queue records the decision with `compliance.review`
      enforced server-side, and the row leaves the queue on refresh.
- [x] No unused export remains in `compliance-documents.ts` (`pnpm lint` and a
      grep for each exported symbol).

### WS-A6 — Reach vendors through links, not the legacy column ∥  ✅ DONE

**Why.** Four recipient lookups filter `contacts` by `primary_company_id`
(autopilot `contactsResult`, `notifyVendorOfComplianceDecision`,
`requestComplianceDocuments`, `resolveRecipientContact` in
`prequalification-invite.ts`). The directory doctrine says `contact_company_links`
is the only linkage and the hygiene migration names the column as one of two
disagreeing sources. A contact linked from the company side is unreachable.

**Tasks.**
- [x] One helper `resolveCompanyRecipients(supabase, orgId, companyIds)` in
      `lib/services/directory.ts` (or the existing contacts service if a sibling
      exists — search first): company email first, then contacts via
      `contact_company_links` ordered `is_primary desc, created_at asc`, then the
      WS-D1 insurance agent when the caller asks for it. Returns
      `{ email, name, contactId, kind: "company" | "contact" | "agent" }[]`.
- [x] All four call sites use it. Delete the inline lookups.
- [x] The compliance tab's contacts note (test "the contacts roster says who can
      actually reach the portal") uses the same helper.

**Definition of done.**
- [x] Test: a contact linked only through `contact_company_links` is chosen as
      the recipient when the company has no email.
- [x] Grep: no `primary_company_id` reference remains in `compliance*.ts` or
      `prequalification*.ts`.

### WS-A7 — Portal decides insurance by kind ∥  ✅ DONE

**Why.** `app/s/[token]/compliance/upload-dialog.tsx` `isInsuranceType` matches
code substrings (`gl`, `wc`, …). The builder side and the 2026-08-19 hardening
migration use `kind`. A custom insurance type with an unmatched code shows the
vendor no carrier, coverage, or endorsement fields, so an endorsement requirement
can never be met from the portal.

**Tasks.**
- [x] Replace `isInsuranceType` with `documentType.kind === "insurance"`; render
      license fields for `kind === "license"` exactly as `FactFields` does on the
      builder side. Extract `FactFields` into `components/compliance/document-fact-fields.tsx`
      and use it from both dialogs so the two forms cannot drift again.
- [x] Delete `INSURANCE_CODES`.

**Definition of done.**
- [x] Source-shape test: neither dialog references a code list; both import the
      shared fields.
- [x] Manual: a custom type with `kind = insurance` and code `builders_risk`
      shows endorsements in the portal.

### WS-A8 — Small items ∥  ✅ DONE

- [x] Held-money banner in `compliance-workspace.tsx` links to
      `/payables?q=<company name>` (what the header uses) or the payables page
      learns a `company=` param; pick one, delete the other.
- [x] Autopilot loads only delivery keys from the last 120 days
      (`created_at >= now() - interval '120 days'`), which covers every bucket
      the reminder schedule can produce.
- [x] Portal upload and share paths call `revalidateTag('directory-party:<id>')`
      through a server-side helper so the builder's private tab cache is not
      stale when the notification email is clicked.
- [x] `loadDirectoryPartyHeader` builds capabilities through
      `resolvePartyCapabilities` from `entry.roles` instead of re-deriving from
      the view's arrays; the trade-partner key list lives once, in
      `lib/directory/roles.ts`, and is exported.

**Definition of done.**
- [x] Each item has either a test or a one-line manual check recorded in the PR.

---

## Phase B — Prequalification correctness

### WS-B1 — A dialogue, not a verdict

**Why.** The vendor cannot amend after submitting (`submitPrequalificationFromPortal`
refuses `under_review`), the reviewer cannot return a package, and a new request is
a blank row so the vendor retypes everything. Renewal has the same problem.

**Tasks.**
- [ ] New status `returned` with `returned_at`, `return_notes` on `prequalifications`
      (CHECK constraint update). Migration
      `YYYYMMDDHHMMSS_prequalification_returned_status.sql`. **STOP — migration pending.**
- [ ] `returnPrequalification(prequalificationId, { notes })` service: requires
      `prequal.review`, only from `under_review`, records audit + event
      `prequalification.returned` (notification channel), emails the vendor via a
      new `prequalification-returned-email.tsx` through `sendPrequalificationDecisionEmail`'s
      sibling. Portal accepts submission from `requested | returned`; a resubmit
      keeps the row, bumps `submitted_at`, and appends the prior answers to a
      `submission_history jsonb[]` column (same migration) so the reviewer can see
      what changed.
- [ ] Portal `prequalification-client.tsx`: `returned` renders the form pre-filled
      from the row (not from localStorage) with the builder's notes at the top.
- [ ] Renewal carry-forward: `requestPrequalification` accepts `carryForwardFrom`
      (the prior row id, default the latest decided row). Copies answers, trades,
      references into the new row as `prefill jsonb`; the portal seeds the form
      from it. Answers are re-submitted, never silently reused.
- [ ] Workspace: "Return for more information" in the decision dialog as a fourth
      option; `returned` chip; history rows show returns.
- [ ] `OPEN_STATUSES` / `REVIEWABLE_STATUSES` include `returned`; the directory
      flag and `prequalificationStatusMeta` render it.

**Definition of done.**
- [ ] Tests in `tests/prequalification-program.test.js`: return → resubmit → decide
      moves through the states; a resubmit from `under_review` is refused; renewal
      prefill equals the prior row's answers.
- [ ] Email allowlist unchanged unless a settings row is added in the same change.
- [ ] Migration written, pending.

### WS-B2 — Expiry has a run-up and the allowlisted email actually sends ∥

**Why.** `prequalification_expiring` is in `EMAIL_NOTIFICATION_TYPES` and nothing
emits it. The nightly job flips to `expired` and stops.

**Tasks.**
- [ ] `expirePrequalificationsWithClient` gains a sibling
      `remindExpiringPrequalificationsWithClient` run from the same autopilot loop:
      at 60, 30, and 7 days before `expires_at` for `CURRENT_STATUSES`, emit
      `prequalification_expiring` (notification channel, to `requested_by` and to
      holders of `prequal.review` — reuse whatever fan-out `compliance_document_expiring`
      uses) and email the vendor via `sendPrequalificationRequestEmail` with a
      "renew" framing and a carry-forward request created with WS-B1's prefill
      only when the org rule `auto_request_prequalification_renewal` is on
      (new key in `ComplianceRules`, default off).
- [ ] Idempotency through `compliance_autopilot_deliveries` with
      `reminder_kind = 'prequal_expiring'` and bucket `prequal:<days>:<expires_at>`.
      Same migration as WS-A2 extends the CHECK.

**Definition of done.**
- [ ] Test: a package expiring in 30 days produces one event and one delivery;
      the next day produces none.
- [ ] Test: `prequalification_expiring` has at least one emitter (source-shape
      test over `lib/services`), mirroring the allowlist test pattern already in
      `tests/payment-notification-coverage.test.js`.

### WS-B3 — Delete the dead flag and the dead status ∥

- [ ] Drop writes to `companies.prequalified` / `prequalified_at` in
      `reviewPrequalification` and `expirePrequalificationsWithClient`; remove the
      mapper field in `lib/services/companies.ts`. Column drop goes to
      `supabase/pending-migrations/` as a gated cutover (the CLAUDE.md rule);
      write it, do not apply. **STOP — gated migration written.**
- [ ] Remove `submitted` from `PrequalificationStatus`, the CHECK, `OPEN_STATUSES`,
      `REVIEWABLE_STATUSES`, and the two UI switches, in the WS-B1 migration.

**Definition of done.**
- [ ] Grep: no reader or writer of `prequalified` outside the pending migration.
- [ ] `pnpm db:schema:check` passes with the WS-B1 migration written.

### WS-B4 — Financials are visible to the prequal role, not the org ∥

**Why.** Revenue, bonding, EMR, and uploaded financial statements are readable by
anyone with `org.member` through `getPrequalificationPackage`.

**Tasks.**
- [ ] New permission `prequal.read_financials`, seeded in the catalog-as-code
      migration (`20260708120500_rbac_catalog_seed.sql` pattern — add to the
      canonical list, not only here) to `org_owner`, `org_admin`, `org_office_admin`,
      `org_estimator`, `org_purchasing_manager`. **STOP — migration pending.**
- [ ] `getPrequalificationPackage` and `getPrequalificationRegisterReport` redact
      `annual_revenue_cents`, `largest_project_cents`, `bonding_*`, `emr` to null
      and set `financials_redacted: true` when the caller lacks it. The workspace
      renders "Restricted" rows.
- [ ] Prequal document slots whose document type `kind` is `other` and whose name
      matches the org's configured "financial" types (a `sensitive: boolean` on
      `compliance_document_types`, same migration) are hidden from the compliance
      tab for callers without the permission, and their files are not in
      `viewerFiles`.

**Definition of done.**
- [ ] `pnpm test:auth` covers the redaction with and without the permission.
- [ ] `TEAM_PERMISSION_OPTIONS` in `lib/services/team.ts` lists the key.

### WS-B5 — Small items ∥

- [ ] `PrequalificationWorkspace` shows Request / Send invitation for
      `canReviewPrequal || canEdit` (the service already permits both).
- [ ] `prequalification_submitted` notification fans out to every holder of
      `prequal.review`, not only `requested_by` (dedupe on user).
- [ ] The register report gains `status`-grouped totals and a `returned` column
      after WS-B1.

---

## Phase C — Policy-line compliance model

The core of parity. Everything in D and E stands on this.

### WS-C1 — Coverage lines and endorsement forms on requirements

**Why.** One `coverage_amount_cents` per document and one `min_coverage_cents`
per requirement cannot express "GL $1M each occurrence / $2M aggregate /
$2M products-completed ops, auto $1M CSL, umbrella $5M, WC statutory with EL
$1M/$1M/$1M". Every COI service evaluates per line.

**Model.**
- Coverage line keys (code enum in `lib/compliance/coverage-lines.ts`, pure, with
  labels and the ACORD 25 box each maps to):
  `gl_each_occurrence, gl_general_aggregate, gl_products_completed_ops,
  gl_personal_adv_injury, gl_damage_to_rented, gl_medical_expense,
  auto_combined_single_limit, umbrella_each_occurrence, umbrella_aggregate,
  wc_statutory, el_each_accident, el_disease_each_employee, el_disease_policy_limit,
  professional_each_claim, professional_aggregate, pollution_each_occurrence,
  builders_risk_limit, cyber_each_claim`.
- Endorsement kinds stay the three booleans the model has (`additional_insured`,
  `primary_noncontributory`, `waiver_of_subrogation`) plus `notice_of_cancellation`.
  Each kind maps to accepted ISO form numbers in the same pure module
  (`CG 20 10`, `CG 20 37`, `CG 20 33`, `CG 20 38` for AI on GL; `CA 20 48` auto AI;
  `CG 20 01` P&NC; `CG 24 04` WOS; `WC 00 03 13` WC waiver; `CG 02 05` /
  `IL 70 xx` notice). Orgs may extend the accepted list per kind.
- Requirements gain `coverage_lines jsonb` — `[{ line, min_cents }]`, validated by
  `coverageLinesSchema` — on `company_compliance_requirements`,
  `project_compliance_requirements`, and each item of
  `orgs.default_compliance_requirements`. `min_coverage_cents` becomes derived
  (the `gl_each_occurrence` entry) for one release, then is dropped by a gated
  migration.
- Requirements gain `endorsements jsonb` — `{ kind: { required: boolean,
  accepted_forms: string[] } }`. The three booleans become derived the same way.

**Tasks.**
- [ ] Migration `YYYYMMDDHHMMSS_compliance_coverage_lines.sql`: the two JSONB
      columns on both requirement tables with a CHECK that the value is an array
      / object; backfill `coverage_lines` from `min_coverage_cents` as a single
      `gl_each_occurrence` entry and `endorsements` from the three booleans;
      seed system document types' default lines (GL, Auto, Umbrella, WC,
      Professional, Pollution) in a `default_coverage_lines jsonb` on
      `compliance_document_types`. **STOP — migration pending.**
- [ ] `lib/validation/compliance-documents.ts`: `coverageLinesSchema`,
      `endorsementRequirementsSchema`; requirement input schemas accept both and
      still accept the legacy scalar/booleans, normalizing to the new shape.
- [ ] `mapRequirement` reads the new shape; `resolveEffectiveRequirements` merges
      layers per line with `Math.max` per line key and OR per endorsement kind
      (the same strictest-wins rule it applies today, now per line).
- [ ] `ComplianceRequirementsEditor`, `ProjectVendorRequirements`, and
      `ComplianceSettings` edit lines in a compact table per insurance type:
      line, minimum (money input), with the type's defaults pre-filled, and an
      endorsement row with accepted forms shown as chips. No new visual language;
      reuse the requirement editor's rows.
- [ ] `docs/database-overview.md` updated in the same change.

**Definition of done.**
- [ ] Test: the resolver merges a vendor rule of `{gl_each_occurrence: 1M}` with a
      project overlay of `{gl_general_aggregate: 2M}` into both lines, and a
      weaker overlay never lowers a line.
- [ ] Test: legacy inputs normalize to lines; the editor round-trips.
- [ ] Migration written, pending; schema doc updated.

### WS-C2 — Policy lines and endorsement forms on documents

**Why.** The document side must carry the same shape the requirement side asks for.

**Model.**
- `compliance_policy_lines` table: `id, org_id, document_id, line, limit_cents,
  policy_number, carrier_name, effective_date, expiry_date, source
  ('extracted' | 'reviewer' | 'vendor' | 'agent'), confidence, created_at`.
  Unique `(document_id, line, source)`. The **reviewer** row wins, then agent,
  then vendor, then extracted; `effectiveLinesFor(document)` (pure) picks one
  value per line.
- `compliance_document_endorsements` table: `id, org_id, document_id, kind,
  form_number, page_number, source, confidence, created_at`.
- `compliance_documents` gains `certificate_holder_text`, `producer_name`,
  `producer_email`, `producer_phone` (from the ACORD producer box; WS-D1 reads
  them), and `source_tier` (WS-D3).

**Tasks.**
- [ ] Migration `YYYYMMDDHHMMSS_compliance_policy_lines.sql` with RLS copied from
      `compliance_documents` (every `auth.uid()` as `(select auth.uid())`), indexes
      on `(org_id, document_id)`, `updated_at` trigger where applicable, and a
      backfill of one `gl_each_occurrence` reviewer row from each approved
      document's `coverage_amount_cents` plus endorsement rows from the three
      booleans (`form_number` null, `source = 'reviewer'`). **STOP — migration pending.**
- [ ] `coiExtractionSchema` (`lib/payments/ap-verification.ts`) gains
      `policies: [{ line, limit_cents, policy_number, carrier_name, effective_date,
      expiry_date }]`, `endorsement_forms: [{ kind, form_number, page }]`,
      `certificate_holder: { name, address }`, `producer: { name, email, phone }`.
      Old readings still parse (defaults), as the schema already does for the
      two newer endorsements.
- [ ] `extractCoiFacts` (`lib/services/...` — locate by symbol) writes rows into
      the two tables with `source = 'extracted'` and the reading's confidence,
      replacing prior extracted rows for the same document. The attempt record
      and input-key dedupe are unchanged.
- [ ] Upload paths write `vendor` rows from the form (the portal's coverage field
      becomes per-line inputs for the lines the requirement asks for; the builder
      dialog the same). `reviewComplianceDocument` corrections write `reviewer` rows.
- [ ] `mapDocument` exposes `lines: EffectiveLine[]` and `endorsements`; keep
      `coverage_amount_cents` and the three booleans as derived getters for one
      release with a `@deprecated` note, then drop by gated migration.
- [ ] Search index: `compliance_document` entity type registered in
      `lib/services/search-index.ts` (carrier, policy numbers searchable).

**Definition of done.**
- [ ] Test: precedence reviewer > agent > vendor > extracted per line, and an
      extracted low-confidence line never beats a vendor-stated one.
- [ ] Test: a legacy extraction payload without `policies` still parses.
- [ ] Migration written, pending; schema doc updated; `pnpm test:financials` green.

### WS-C3 — Line-by-line deficiency engine

**Tasks.**
- [ ] `buildComplianceStatus` compares `effectiveLinesFor(bestDocument)` against
      `requirement.coverage_lines`: each short or absent line is a deficiency
      code `line:<key>` with a message "GL each occurrence $500,000, requires
      $1,000,000". Endorsements: required kind with neither a reviewer-confirmed
      row nor a detected accepted form is `endorsement:<kind>`; a detected form
      not in the accepted list is `endorsement_form:<kind>` ("CG 20 10 04/13
      attached; this builder accepts CG 20 10 04/13 or CG 20 33").
- [ ] `ComplianceRequirementDeficiency.codes` type widens accordingly;
      `deficiencyMessage` renders per line. The old four codes are removed.
- [ ] Expiry per line: if the earliest expiring line among required lines is
      past, the requirement is `expired`, and `days_until_expiry` is the earliest.
      A certificate whose auto policy lapses while GL is current is expired for
      the auto requirement only (WS-E1 makes the two requirements share the file).
- [ ] Portal `compliance-client.tsx` renders lines as a small table: required,
      on file, short-by, per line; endorsements as detected form / missing.
- [ ] Builder row note shows the first deficiency and "+n more"; the review dialog
      lists all.

**Definition of done.**
- [ ] Tests: each deficiency code fires from a fixture certificate; the hold
      engine's `complianceCurrent` flips with them (existing hold test extended).
- [ ] Both screens render the line table; dark mode checked.

### WS-C4 — Certificate holder and additional-insured entity match

**Tasks.**
- [ ] `orgs.certificate_holder jsonb` `{ name, address_lines[] , aliases[] }` and
      `projects.certificate_holder_overrides jsonb` (owner entity for overlays).
      Migration `YYYYMMDDHHMMSS_certificate_holder_entities.sql`. **STOP — migration pending.**
      Settings → Compliance gains the editor (name, address, aliases such as a DBA).
- [ ] Pure matcher `lib/compliance/entity-match.ts`: normalized token overlap on
      name (with alias list) and address; returns `match | partial | mismatch |
      unknown` with the diff. Tested on a fixture set including punctuation and
      "LLC" / "L.L.C." variants.
- [ ] `buildComplianceStatus` adds deficiency `holder:mismatch` (blocking) and
      `holder:unknown` (warn-only, rendered but not counted in `is_compliant`)
      for insurance-kind requirements when the org has configured a holder. When
      a project overlay carries an owner entity, the AI endorsement must name the
      owner too (`holder:owner_missing`).
- [ ] The review dialog shows "Certificate holder: <read> vs <expected>" with the
      one-click Use pattern already in `ComplianceReviewDialog`.

**Definition of done.**
- [ ] Matcher tests; deficiency tests; an org with no holder configured raises
      nothing (fail-open by design, stated in the reference doc).

### WS-C5 — Trade-based requirement templates and automatic enrollment

**Why.** Explicit enrollment is right, but "every sub is unenrolled until someone
clicks" is why the badge lies. TrustLayer assigns requirement tiers by vendor
type and contract size.

**Tasks.**
- [ ] `orgs.compliance_requirement_templates jsonb`: named templates
      `{ key, label, applies_to: { role_keys[], trades[], contract_max_cents? },
      requirements: [...items] }`. `default_compliance_requirements` becomes the
      template with key `default`. Normalizer in `lib/services/compliance.ts`
      replaces `normalizeComplianceRequirementDefaults`. Migration converts the
      existing array into the default template. **STOP — migration pending.**
- [ ] `resolveTemplateForCompany(company, roles, trade)` pure; the most specific
      template wins (trade over role over default).
- [ ] Enrollment triggers, all through `setCompanyRequirements` +
      `setCompanyComplianceMonitoring`: gaining a trade-partner role
      (`party-roles` service, after insert), `ensureVendorRoleWithClient` on the
      commitment path, and the WS-A3 add-to-directory checkbox. Never on a plain
      vendor role.
- [ ] Settings → Compliance: templates list, one editor, "Applies to" picker from
      the org's relationship-type vocabulary and trade list.
- [ ] Commitment creation with a contract value above `contract_max_cents` of the
      vendor's current template raises a warn-only signal "this contract exceeds
      the tier this vendor was enrolled under" on the commitment sheet.

**Definition of done.**
- [ ] Tests: template resolution order; enrolling on role grant; no enrollment on
      a generic vendor role.
- [ ] `tests/compliance-system.test.js` "new vendors are not automatically
      enrolled" is rewritten to "new **generic** vendors are not automatically
      enrolled; trade partners are enrolled under the matching template".

### WS-C6 — Hold policy learns the new states

- [ ] `PaymentHoldFacts` gains `complianceEnrolled: boolean`; a new hold kind
      `compliance_enrolled` (default `warn`) fires for an unenrolled trade
      partner. `payment_hold_overrides` CHECK and `payment_hold_policies` default
      extended in the WS-C1 migration. `tests/compliance-system.test.js` "an
      override exists in the database for every hold the UI can raise" covers it.
- [ ] `insurance_current` reads per-line expiry from `effectiveLinesFor` through
      `evaluateInsuranceCurrency` (stored expiry becomes the earliest required
      line's expiry). The AI-claim clamp is unchanged.

**Definition of done.**
- [ ] Hold tests updated; `payable-holds.tsx` labels the new kind.

---

## Phase D — Agent loop and trust tiers

### WS-D1 — Insurance agent of record

**Tasks.**
- [ ] Seed relationship type `insurance_agent` (category `other`, applies_to
      `contact`) in the org provisioning seed and a backfill migration for
      existing orgs (`party_roles` doctrine: a role, never a type column).
      `companies.insurance_agent_contact_id uuid` FK. Migration
      `YYYYMMDDHHMMSS_insurance_agent_of_record.sql`. **STOP — migration pending.**
- [ ] After extraction (`extractCoiFacts`), if `producer.email` is present and the
      company has no agent: create the agency company if the producer name is
      new (role `other`), the contact with role `insurance_agent`, link through
      `contact_company_links`, set `insurance_agent_contact_id`, and record event
      `compliance_agent_detected`. If an agent exists and the producer differs,
      raise a review note ("certificate produced by a different agent") — never
      overwrite silently.
- [ ] Compliance tab header: "Agent: <name> · <email>" with Edit (picker over
      contacts holding the role; create inline through the existing contact form).
- [ ] Portal: the vendor sees their agent and can correct it (writes to the same
      column through the portal route with `can_upload_compliance_docs`).

**Definition of done.**
- [ ] Test: a producer block on a fixture reading creates the agent once and
      never twice; a differing producer raises a note.
- [ ] Directory list shows the agency company with its contact; `/directory/[id]`
      renders a contact holding only the agent role without vendor tabs.

### WS-D2 — Deficiency letters go to the agent

**Tasks.**
- [ ] `resolveCompanyRecipients` (WS-A6) returns the agent for `purpose:
      "insurance"` reminders: `missing | expiring | expired | deficient |
      rejected` on insurance-kind types go **to the agent, cc the vendor**;
      non-insurance kinds go to the vendor only.
- [ ] New email `lib/emails/compliance-agent-request-email.tsx`: the builder's
      certificate-holder block verbatim (WS-C4), the required lines and forms as
      a table, the exact shortfall per line, and an upload link that lands the
      agent on the portal compliance section (WS-D3 token). Copy is written for
      an insurance professional, not a sub.
- [ ] `requestComplianceDocuments` dialog gains "Send to agent" (default when an
      agent exists) and shows the recipient.
- [ ] `compliance_autopilot_deliveries.recipient_kind` (`vendor | agent`), same
      migration as WS-D1.

**Definition of done.**
- [ ] Test: an insurance deficiency with an agent on file produces one agent
      delivery with cc; a W-9 chase never goes to the agent.
- [ ] Email renders in the preview harness used by `lib/emails/` siblings.

### WS-D3 — Trust tiers and the agent submission path

**Tasks.**
- [ ] `compliance_documents.source_tier` `('vendor' | 'agent' | 'builder' |
      'carrier')` NOT NULL default `vendor`; backfill `builder` where
      `submitted_via_portal = false`. In the WS-D1 migration.
- [ ] Agent link: `ensureVendorAccountPortalToken` variant bound to the agent
      contact with permissions `{ can_upload_compliance_docs: true }` and nothing
      else; the portal shell's nav for a token whose bound contact holds only
      `insurance_agent` shows Compliance alone (`buildSubPortalNav`). Uploads
      through such a token write `source_tier = 'agent'`.
- [ ] Org rule `minimum_source_tier_for_release: 'vendor' | 'agent'` in
      `ComplianceRules` (default `vendor`). The hold engine treats an approved
      document below the tier as `pending` for `compliance_docs_approved`; the
      tab says "approved, awaiting agent-issued copy".
- [ ] `carrier` tier is reserved. **STOP — product decision:** carrier-direct
      verification (Certificial-style live policy data) is a partnership, not a
      workstream. Leave the enum value and a `carrier_verification jsonb null`
      column; do not build an integration.

**Definition of done.**
- [ ] `pnpm test:auth` covers the agent token's permission surface (cannot read
      bids, payments, prequal).
- [ ] Tests: tier precedence in `effectiveLinesFor`; the release rule.

### WS-D4 — Exception-only review (auto-clear)

**Why.** TrustLayer sells human review hours to reach "only exceptions reach you".
Arc's extraction plus the line engine can produce the same outcome as a rule.

**Tasks.**
- [ ] Org rule `auto_clear_verified_certificates: boolean` (default off) with the
      conditions stated in Settings copy: extraction confidence `high`; every
      required line present and at or above minimum from **extracted** rows (not
      vendor-stated); every required endorsement has a detected accepted form;
      holder match is `match`; expiry at least 30 days out; `source_tier` meets
      the release rule; no open review note.
- [ ] `autoClearComplianceDocument(documentId)` runs from `extractCoiFacts`'s job
      after rows are written, with the service client. It calls the same
      supersede-then-approve sequence as WS-A1, sets `reviewed_by = null`,
      `decided_by_system = true` (new column, WS-D1 migration), `review_notes =
      "Auto-cleared: <rule summary>"`, records audit with source
      `compliance.autoclear` and event `compliance_document_auto_cleared`.
- [ ] Anything failing a condition stays `pending_review` with the failing
      condition in a `review_hint` (jsonb, same migration) that the review dialog
      shows first.
- [ ] `revokeComplianceDecision` works on system decisions; the tab shows
      "Auto-cleared" as the decider.

**Definition of done.**
- [ ] Tests: each condition individually blocks auto-clear; a passing fixture
      clears and supersedes the prior; the audit row names the system.
- [ ] Rule copy in Settings lists every condition verbatim.

### WS-D5 — Renewals as a first-class flow

**Tasks.**
- [ ] Autopilot's `expiring` chase for insurance kinds goes to the agent at the
      type's warning window (WS-D2) and says "renewal certificate", linking the
      upload as a **renewal** (`renews_document_id` on the new row, WS-D1
      migration).
- [ ] A renewal that auto-clears (WS-D4) or is approved supersedes the prior;
      until then the prior remains the verdict (WS-A1).
- [ ] A renewal whose lines are weaker than the prior raises `review_hint`
      "renewal reduces GL aggregate from $2M to $1M" even when it still meets
      the requirement.

**Definition of done.**
- [ ] Test: a 30-day-out expiry produces one agent chase; the renewal upload
      keeps `is_compliant` true; approval supersedes.

---

## Phase E — Beyond the COI services

### WS-E1 — One certificate satisfies every insurance requirement

**Why.** A sub uploads the same ACORD 25 to four document types today.

**Tasks.**
- [ ] `compliance_documents.certificate_group_id uuid` (WS-D1 migration). On an
      insurance-kind upload, after extraction, for every **other** active
      insurance-kind document type whose `default_coverage_lines` are present in
      the reading, create a sibling document row sharing `file_id`, the group id,
      and the extracted lines, status `pending_review`. The vendor uploaded once;
      the record has one row per requirement, which is what the unique index and
      the resolver expect.
- [ ] Review and auto-clear act on the **group**: approving one approves the
      siblings whose lines pass, and leaves the rest pending with a hint.
      `ComplianceReviewDialog` shows the group as one screen with per-type verdicts.
- [ ] Portal: one "Send your certificate of insurance" action at the top of the
      insurance group; per-type Upload buttons remain for a certificate that
      covers one policy.
- [ ] Portability (`shareComplianceDocumentToOrg`) shares the group.

**Definition of done.**
- [ ] Test: a fixture reading with GL, auto, umbrella, WC creates four rows, one
      file; approving the group with a short umbrella line approves three and
      leaves umbrella pending with the shortfall hint.
- [ ] Storage: one object per upload (assert no duplicate `storage_path`).

### WS-E2 — Standing consent: the agent's renewal lands everywhere

**Why.** Portability is per document, per builder, per click. The vendor's agent
renews once a year; every builder should receive it.

**Tasks.**
- [ ] `vendor_document_share_consents (external_identity_id, source_company_id,
      source_org_id, target_org_id, target_company_id, document_kinds[],
      revoked_at)`, RLS service-role write, both orgs read. Migration
      `YYYYMMDDHHMMSS_vendor_document_share_consents.sql`. **STOP — migration pending.**
- [ ] Portal `PortableDocuments` gains "Always send my <kind> to this builder"
      (signed-in external identity only, the same guard as
      `shareComplianceDocumentAction`).
- [ ] After a document is approved or auto-cleared in the source org, an outbox
      job `fan_out_shared_certificate` calls `shareComplianceDocumentToOrg` for
      every live consent; the receiving org reviews as today. Registered in
      `process-outbox` and `accounting-job-types` if that registry is the one
      used (search first).
- [ ] The vendor's account home (`vendor-account-home.tsx`) lists consents with
      revoke.

**Definition of done.**
- [ ] Test: approval in org A creates a pending document in org B under consent
      and nothing without; a revoked consent stops the fan-out.
- [ ] `tests/compliance-system.test.js` "a shared document is scoped to a
      verified identity" extended to consents.

### WS-E3 — Uninsured exposure in dollars ∥

**Tasks.**
- [ ] `getUninsuredExposure(orgId, { projectIds? })` in
      `compliance-documents.ts`: for each open commitment (approved, remaining =
      total − billed, read from the commitment position helper that exists), the
      vendor's per-project verdict from `resolveStatusFromInputs`; sum remaining
      where not compliant, grouped by project and by deficiency kind. Bounded
      like `getComplianceHeldPayablesByCompanyWithClient`, reports `truncated`.
- [ ] Project compliance page (`app/(app)/projects/[id]/compliance`) leads with
      the number; Control Tower "Held by compliance" gains "Uninsured exposure"
      beside held payables; the org report catalog gains `vendor-insurance-exposure`
      (registry pattern in `docs/` reports rebuild) with csv export.
- [ ] Owner entity from WS-C4 is a grouping when overlays exist.

**Definition of done.**
- [ ] Test: two commitments, one vendor deficient for that project, exposure
      equals that commitment's remaining and nothing else.
- [ ] Report registered with `ambientScope` honesty; skeleton, empty, error, dark.

### WS-E4 — Wrap-up programs (OCIP / CCIP) ∥

**Tasks.**
- [ ] `project_wrap_up_programs (id, org_id, project_id, kind 'ocip' | 'ccip',
      name, waived_lines text[], enrollment_document_type_id, starts_on, ends_on)`
      and `project_wrap_up_enrollments (program_id, company_id, enrolled_at,
      document_id, ended_at)`. RLS as neighbors. Migration
      `YYYYMMDDHHMMSS_wrap_up_programs.sql`. **STOP — migration pending.**
- [ ] `resolveEffectiveRequirements` accepts `wrapUpEnrollments`; for an enrolled
      vendor on that project, waived lines are dropped from the effective
      requirement with `source: "wrap_up"` recorded on the requirement so the tab
      can say "GL covered by OCIP". Only the project-scoped verdict changes; the
      standing verdict is untouched.
- [ ] Project compliance page: program editor and enrollment list; enrolling
      requires the enrollment certificate as an ordinary compliance document.

**Definition of done.**
- [ ] Test: an enrolled vendor with no GL certificate is compliant for that
      project and non-compliant org-wide; the hold engine (project-scoped) releases.

### WS-E5 — Audit pack ∥

- [ ] `lib/services/reports/compliance-audit-pack.ts`: per vendor or per project,
      a PDF (mirror `lib/services/reports/pay-application.ts`) with the
      requirement matrix, every live document's lines and forms, holder match,
      decisions with decider (person or system) and dates, waivers with reasons.
      This is what an insurer's auditor asks for and what TrustLayer sells as
      "audit-ready".

**Definition of done.**
- [ ] Renders for a fixture vendor; registered in the report catalog with export.

---

## Phase F — Prequalification evaluation

### WS-F1 — Scoring rubric and derived limits

**Tasks.**
- [ ] `orgs.prequalification_template.rubric`: `{ thresholds: { emr_max: 1.0,
      years_min: 3, single_limit_pct_of_largest: 150, aggregate_pct_of_revenue: 50,
      bonding_required_above_cents: ... }, weights: { ... } }` validated in
      `lib/validation/prequalification.ts`, editable in Settings beside the program.
- [ ] Pure `scorePrequalification(template, submission, complianceStatus)` in
      `lib/prequalification/score.ts`: per-criterion pass / flag / fail with
      the reason, an overall band, and **suggested limits** (single = ×1.5 largest
      completed, aggregate = ×0.5 revenue, capped by bonding when present).
- [ ] Decision dialog shows the rubric result, pre-fills suggested limits
      (editable), and lists flags as the review checklist. The package summary
      shows the band chip.
- [ ] Register report gains band and flags.

**Definition of done.**
- [ ] Tests: each threshold; suggested limits; a submission with no financials
      returns "insufficient data", never a pass.

### WS-F2 — Reference checks ∥

- [ ] `prequalification_reference_checks (prequalification_id, reference_index,
      checked_by, checked_at, outcome 'positive' | 'neutral' | 'negative' |
      'unreachable', notes)`. Migration with WS-B1's. Workspace references list
      gains "Record call" per reference; the rubric counts verified references.

**Definition of done.**
- [ ] Test: rubric reference criterion uses checks, not submitted count.

### WS-F3 — Trade-scoped approval ∥

- [ ] `prequalifications.approved_trades text[]` (reviewer picks from submitted
      trades, default all). `getCompanyPrequalificationWarning` and
      `getBidInvitePrequalificationWarnings` accept `trade` / CSI division from
      the commitment's cost code or the bid package and warn "prequalified for
      concrete, not electrical". Directory flag already shows trades.

**Definition of done.**
- [ ] Tests: a commitment outside approved trades warns; inside passes.

### WS-F4 — Prequalification desk

**Why.** Purchasing managers own prequalification across projects; the desk rule
passes. Today the only cross-vendor views are the register report and directory flags.

- [ ] `/prequalifications` desk (mirror `app/(app)/sales/page.tsx`): ambient
      scope, row cap, tabs `Requested · Returned · Awaiting review · Expiring ·
      Approved`, deep-links to the workbench tab; one-click "Send reminder" only
      by calling the workbench action. Registered in the org nav under Purchasing.
- [ ] Control Tower tile for awaiting review.

**Definition of done.**
- [ ] Empty, loading, error, dark; cap visible when truncating; `pnpm test:auth`
      for `prequal.review` gating of the decide action from the desk.

---

## Phase G — Tests, reference doc, plan deletion

- [ ] `tests/compliance-system.test.js` and `tests/prequalification-program.test.js`
      cover every DoD test above; add `tests/compliance-lines.test.js` for the
      pure modules (`coverage-lines`, `entity-match`, `effectiveLinesFor`,
      `score`). All in `pnpm test:financials`.
- [ ] pgTAP: RLS on `compliance_policy_lines`, `compliance_document_endorsements`,
      `vendor_document_share_consents`, wrap-up tables, following
      `supabase/tests/payment_lifecycle.test.sql`.
- [ ] `docs/vendor-compliance.md` reference: the resolver contract, the line and
      endorsement model, precedence, trust tiers, auto-clear conditions, the agent
      loop, wrap-ups, and the gate-and-screen rule. `CLAUDE.md` deep-dives list
      gains a three-line pointer.
- [ ] `docs/database-overview.md` current for every table above.
- [ ] Grandfathered token-debt files touched in this plan are cleaned and removed
      from `.eslintrc.js`.
- [ ] Delete this file.

---

## Appendix — findings this plan resolves, by workstream

| Finding (2026-09-02 review) | Workstream |
|---|---|
| Replacement upload supersedes the approved certificate | A1 |
| Deficient certificates never chased | A2 |
| "Compliant" asserted with no requirements / monitoring off; tab hidden; no enrollment on create | A3, C5 |
| Unvalidated dates, three clocks | A4 |
| Review queue dead code | A5 |
| Recipients through `primary_company_id` | A6 |
| Portal infers insurance by code substring | A7 |
| Payables link param, unbounded delivery load, stale tab cache, duplicated capability math | A8 |
| Prequal has no dialogue loop, blank renewals | B1 |
| `prequalification_expiring` never emitted | B2 |
| `companies.prequalified` written, never read; dead `submitted` status | B3 |
| Prequal financials visible org-wide | B4 |
| Reviewer without directory edit cannot request; single-recipient notification | B5 |
| No scoring, no derived limits, no reference checks | F1, F2 |
| Approval not trade-scoped | F3 |
| No cross-vendor prequal surface | F4 |
