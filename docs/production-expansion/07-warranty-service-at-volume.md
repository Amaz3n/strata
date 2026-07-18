# Workstream 07 — Warranty & Service at Volume

> **STATUS: NOT STARTED.**
>
> Prereqs (docs 01, 02, 03, 08 are WRITTEN in this folder — read what you consume):
> `00-MASTER-production-expansion.md` (read FIRST, fully — especially §5.5
> "POs are commitments; VPOs are commitment change orders with reason codes", §5.1
> lot/project model, and §9 warranty market facts), workstream **01** (communities/
> lots/divisions), workstream **04** (PO linkage: VPO reason codes on
> `commitment_change_orders`, trade confirm→complete loop in the sub portal),
> workstream **06** (`closings` — the coverage clock starts at
> `closings.actual_date`). The commercial suite's `00-MASTER` and doc 09 rules still
> bind. Phases 1–3 of this doc can start once 01 lands (coverage falls back to a
> manual effective date until 06 ships closings); Phase 4 (backcharges) needs 04's
> reason-code column; Phase 5 (plan analytics) needs 02's plan versions on lots.

## 1. Mission

Today Arc's warranty module is a request log: a buyer or PM files a request, someone
assigns a trade company, an email goes out, someone types a resolution note. That is
fine for a custom builder closing 8 homes a year. A production builder closing 100+
homes carries **hundreds of homes simultaneously under warranty**, staffs a real
**service department** (a service manager + in-house techs + trade dispatch), and
manages warranty as a **P&L line with a benchmark**: ~0.7–1.0% of revenue, "1-2-10"
coverage structure (1yr workmanship / 2yr systems / 10yr structural), and
**backcharge recovery against the originating trade PO** as a sellable ROI wedge
(master §1, §9).

This workstream turns the request log into that service department:

- **(A) Coverage model** — org-configurable warranty term definitions; a coverage
  record per closed home whose clock starts at closing; every request classified
  in/out of warranty (computed, overridable with reason); structural claims flagged
  for insurer handoff (2-10 Home Buyers Warranty / StrucSure style — data fields
  only, no integration).
- **(B) Service operations** — intake (buyer portal + office) → triage queue →
  dispatch to EITHER an in-house tech (assignee user + appointment window) OR the
  responsible trade (`assigned_company_id` — extend the existing dispatch-email
  pattern with an appointment + confirm/complete loop via the sub portal, the same
  loop workstream 04 builds for pay-on-PO); **service visits** with scheduled
  windows, outcomes, photos, and buyer sign-off; **SLAs** with org-configurable
  targets by severity (emergency / 30-day / 60-day lists) and aging/breach surfacing.
- **(C) Trade backcharges** — when a trade's defective work costs money, a backcharge
  record linked to BOTH the warranty request AND the originating commitment/PO,
  posting as a negative adjustment on the trade relationship via the existing
  vendor-credit rails (money mechanics speced precisely in §7), with billed-vs-
  recovered tracking.
- **(D) Analytics** — recurring-defect analysis by plan / plan version / trade /
  cost code / community (feeds purchasing: a plan with chronic HVAC callbacks is a
  price-book/vendor problem for workstream 04); warranty cost as % of revenue per
  community vs the 0.7–1.0% benchmark; a cost-dumping guard flagging late-
  construction costs pushed into warranty.
- **(E) Desk + portal + mobile** — an org **Warranty/Service desk** (passes the
  whole-JOB test: service manager) with SLA-aged queue, dispatch board, tech day
  view, and backcharge queue; buyer-portal warranty (request with photos,
  appointment visibility, sign-off); mobile API additions for techs (day list,
  visit complete with photos).

## 2. Non-goals

- **No insurer integrations.** Structural-warranty administration (2-10, StrucSure,
  Maverick) stays data-fields-only: carrier, policy/enrollment number, claim number,
  submitted date. Filing happens on the insurer's portal.
- **No trade-side scheduling optimization** (route planning, capacity balancing).
  The dispatch board is a manual assignment surface; optimization is future.
- **No warranty reserve accounting** (accrual % at closing posting to the GL). Note
  it as an open question for workstream 08's accounting layer; this doc tracks
  actual cost only.
- **No homeowner-manual / maintenance-schedule content module.** The buyer portal
  shows coverage terms and requests; canned maintenance content is future.
- **No new parallel module.** `lib/services/warranty.ts` is extended in place —
  same file, same `warranty_requests` table at the core. No `service-requests.ts`,
  no `warranty-v2` anything (CLAUDE.md "leave no trash" + constraint from master).

## 3. Read these files first

- `lib/services/warranty.ts` — FULL read (360 lines). Current model documented in §4.
- `lib/services/punch-lists.ts` — the ball-in-court pattern this doc extends:
  `assigned_company_id` + `dispatched_at` + `sub_completed_at` + portal completion
  (`completePunchItemFromPortal` verifies the token's `companyId` matches) +
  `sendPunchDispatchEmail`. Warranty visits reuse this exact loop shape.
- `lib/services/commitments.ts` + `lib/services/commitment-change-orders.ts` —
  the commitments spine and CCO lifecycle (`draft|sent|approved|rejected|voided`,
  `total_cents`, lines with `amount_cents`). Workstream 04 adds `reason_code` for
  VPOs; backcharges reference but do NOT ride CCOs (see §7 for why).
- `lib/services/vendor-bills.ts` — vendor-credit mechanics: a credit is a
  `vendor_bills` row with `metadata.source = 'vendor_credit'`, **negative** line
  amounts (`"Vendor credit lines cannot be positive"` guard at ~L954), no payment
  lifecycle of its own (~L658), and application to a bill records a settlement row
  (`vendor_credit_applied` payment metadata, ~L340). This is the rail backcharges
  ride.
- `app/(app)/projects/[id]/warranty/page.tsx` + `components/warranty/warranty-client.tsx`
  (683 lines) + `app/(app)/warranty/actions.ts` — the current UI surface. Note:
  `app/(app)/warranty/` contains **actions only, no page** — there is no org desk
  today; this doc creates it.
- `app/p/[token]/warranty/` (page + actions + client) — buyer-portal intake, calls
  `createWarrantyRequestFromPortal` / `listWarrantyRequestsForPortal`.
- `app/s/[token]/` + `lib/services/portal-access.ts` — sub portal structure; where
  the trade's warranty appointment queue surfaces (coordinate with workstream 04's
  confirm→complete loop so the sub sees ONE work queue, not two).
- `lib/services/tasks.ts` + `schedule_assignments` usage — reference for assigning
  work to an internal user (tech dispatch mirrors task assignment, not a new
  concept).
- `lib/services/notifications.ts` + `lib/types/notifications.ts` — notification
  rails and the `EMAIL_NOTIFICATION_TYPES` allowlist (only listed types ever email).
- `app/api/mobile/v1/projects/[projectId]/punch-items/` + `tasks/` routes — the
  mobile API pattern for the tech endpoints.
- Workstream 06 doc (when drafted) for `closings` shape; until then master §5:
  `closings` is "the revenue event per project" with an actual/settlement date.
- Style/detail reference: `docs/commercial-expansion/06-field-safety-quality-punch.md`.

## 4. Current-state audit (code-verified 2026-07-16)

**`lib/services/warranty.ts` (360 lines) — everything warranty does today:**

- Table: `warranty_requests` — base columns from the remote-schema snapshot are
  `id, org_id, project_id, title, description, status (default 'open'), priority
  (default 'normal'), requested_by (uuid → contacts), created_at, closed_at`; a
  later migration added `assigned_company_id, scheduled_date, resolution_note,
  dispatched_at, updated_at` (all present in `WARRANTY_SELECT` and prod). **Verify
  the live columns with `list_tables` before writing the migration** — the repo's
  snapshot predates them.
- Statuses: `open | in_progress | resolved | closed`; priorities:
  `low | normal | high | urgent` (`lib/validation/warranty.ts`).
- Service functions: `listWarrantyRequests` (project-scoped, permission
  `warranty.read`), `createWarrantyRequest` (`warranty.write`, event
  `warranty_request_created` + audit), `updateWarrantyRequest` (single mutation for
  everything: assigning a company sets `dispatched_at` and bumps status to
  `in_progress`; resolving/closing sets `closed_at`; fires
  `sendWarrantyDispatchEmail` to ALL contacts of the assigned company via
  `fetchCompanyContacts`, and `sendWarrantyResolvedEmail` to the requesting
  contact), `createWarrantyRequestFromPortal` / `listWarrantyRequestsForPortal`
  (service-role client, token-authenticated upstream).
- Emails are direct `sendEmail` calls (mailer), NOT notification-rail types.
  Event types emitted: `warranty_request_created`, `warranty_request_updated`,
  `warranty_request_dispatched`.
- UI: project tab `app/(app)/projects/[id]/warranty/page.tsx` →
  `components/warranty/warranty-client.tsx` (list + detail sheet + assign company +
  schedule date + resolve). Buyer portal `app/p/[token]/warranty/` (create + list).
  `app/(app)/warranty/actions.ts` exists but there is **no org desk page**.
- **What does NOT exist:** coverage terms/expiry of any kind; severity/service-list
  taxonomy; SLA targets or due dates; in-house tech assignment (no user assignee —
  only `assigned_company_id`); appointment windows or visit records; photos on
  requests (portal intake is text-only); buyer sign-off; trade confirm/complete for
  warranty (the dispatch email says "please coordinate" and the loop ends);
  backcharges (the word does not appear in `lib/`); any warranty analytics; mobile
  API warranty routes; `cost_code_id` or category on requests; `closings` (ws 06);
  `reason_code` on `commitment_change_orders` (ws 04 adds it — grep confirms only
  unrelated tables have reason codes today).
- Vendor-credit rails (verified in `vendor-bills.ts`): `PayableKind = "bill" |
  "vendor_credit"`; credits are negative-line `vendor_bills` rows
  (`metadata.source='vendor_credit'`), cannot receive payments, and are applied to
  bills via a settlement row so credit-paid bills reach `paid`. QBO import/export of
  vendor credits already works (memory: "vendor credits import as negative
  vendor_bills"). Commitment rollups already net credits ("Sum of all bills (net of
  credits) recorded against the same commitment", ~L51).

## 5. Data model

All money integer cents. All tables org-scoped with RLS on the standard pattern
(`(SELECT auth.uid())` initplan, org membership check — copy the policy shape from
`20260711021000_inspections.sql`). Additive only; no column drops or renames on
`warranty_requests`.

### 5.1 Migration `<ts>_warranty_coverage.sql` — programs, terms, per-home coverage

```sql
-- Org-configurable warranty program (an org usually has one; allow several for
-- e.g. a different program per division or a legacy program on older communities).
create table public.warranty_programs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  name text not null,                          -- "Standard 1-2-10"
  description text,
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index warranty_programs_one_default
  on public.warranty_programs (org_id) where is_default;

-- The term rows ARE the 1-2-10 structure, org-configurable (a builder may run
-- 1-2-6, add an appliance term, etc.). key is a stable slug used in classification.
create table public.warranty_coverage_terms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  program_id uuid not null references public.warranty_programs(id) on delete cascade,
  key text not null,                           -- 'workmanship' | 'systems' | 'structural' | custom
  label text not null,                         -- "Workmanship & materials"
  duration_months integer not null check (duration_months > 0),
  is_structural boolean not null default false, -- flags insurer-handoff path
  description text,                            -- what's covered, shown to buyer
  sort_order integer not null default 0,
  unique (program_id, key)
);

-- One coverage record per closed home. terms_snapshot freezes the program's terms
-- at enrollment so later program edits never move an existing home's expiries.
create table public.project_warranty_coverage (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id) unique,
  program_id uuid not null references public.warranty_programs(id),
  effective_date date not null,                -- = closings.actual_date; manual for pre-06 / custom homes
  effective_source text not null default 'closing'
    check (effective_source in ('closing','manual')),
  -- [{ key, label, duration_months, is_structural, expires_on }] computed at enrollment
  terms_snapshot jsonb not null,
  -- Structural insurer enrollment (data only, no integration):
  structural_carrier text,                     -- '2-10 HBW', 'StrucSure', ...
  structural_policy_number text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index project_warranty_coverage_org_effective
  on public.project_warranty_coverage (org_id, effective_date desc);
```

Seeding: the service seeds a default "Standard 1-2-10" program (workmanship 12mo /
systems 24mo / structural 120mo) the first time an org opens warranty settings or
enrolls a home — mirror the checklist-template seed hookup pattern from commercial
ws 06 (seed in the service, not the migration).

### 5.2 Migration `<ts>_warranty_service_ops.sql` — request extensions, visits, SLAs

```sql
-- ===== warranty_requests: additive columns =====
alter table public.warranty_requests
  add column if not exists request_number integer,          -- per-PROJECT sequence (RPC pattern)
  add column if not exists severity text not null default 'routine_30'
    check (severity in ('emergency','routine_30','routine_60')),
  add column if not exists category text,                   -- free/org-list: 'HVAC','Plumbing','Drywall',...
  add column if not exists cost_code_id uuid references public.cost_codes(id),
  add column if not exists coverage_term_key text,          -- classified against terms_snapshot
  add column if not exists coverage_status text not null default 'unclassified'
    check (coverage_status in ('unclassified','in_warranty','out_of_warranty','goodwill')),
  add column if not exists coverage_override_reason text,   -- required when human overrides computed status
  add column if not exists assigned_user_id uuid,           -- in-house tech (app_users)
  add column if not exists first_response_due_at timestamptz,
  add column if not exists resolution_due_at timestamptz,
  add column if not exists first_responded_at timestamptz,  -- first visit scheduled OR trade dispatched
  add column if not exists source text not null default 'office'
    check (source in ('office','buyer_portal','mobile')),
  add column if not exists cost_dump_flag boolean not null default false, -- §9 guard
  -- structural insurer claim handoff (data only):
  add column if not exists structural_claim boolean not null default false,
  add column if not exists structural_claim_number text,
  add column if not exists structural_claim_submitted_at timestamptz,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

-- Backfill request_number per project by created_at, then enforce:
-- (do the backfill UPDATE here; unique index after)
create unique index warranty_requests_project_number
  on public.warranty_requests (project_id, request_number);
-- Desk queue hot paths:
create index warranty_requests_org_open
  on public.warranty_requests (org_id, status, resolution_due_at)
  where status in ('open','in_progress');
create index warranty_requests_assigned_user
  on public.warranty_requests (assigned_user_id) where assigned_user_id is not null;

-- ===== photos on requests (portal + office intake) =====
create table public.warranty_request_photos (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  request_id uuid not null references public.warranty_requests(id) on delete cascade,
  file_id uuid not null references public.files(id),
  caption text,
  created_by uuid,                              -- null when portal-created
  created_at timestamptz not null default now()
);
create index warranty_request_photos_request on public.warranty_request_photos (request_id);

-- ===== service visits: the appointment + outcome record =====
create table public.warranty_service_visits (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  request_id uuid not null references public.warranty_requests(id) on delete cascade,
  project_id uuid not null references public.projects(id),
  visit_number integer not null,                -- per request, 1..n
  assignee_kind text not null check (assignee_kind in ('tech','trade')),
  assigned_user_id uuid,                        -- when tech
  assigned_company_id uuid references public.companies(id),  -- when trade
  window_start timestamptz not null,
  window_end timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled','confirmed','in_progress','completed','no_access','canceled')),
  outcome text
    check (outcome in ('resolved','needs_followup','needs_parts','not_warrantable')),
  outcome_note text,
  confirmed_at timestamptz,                     -- trade confirmed via sub portal
  completed_at timestamptz,
  completed_by uuid,                            -- user (tech) or null (portal completion)
  buyer_signoff_name text,
  buyer_signoff_at timestamptz,
  buyer_signature_file_id uuid references public.files(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (request_id, visit_number),
  check (window_end > window_start),
  check ((assignee_kind = 'tech' and assigned_user_id is not null)
      or (assignee_kind = 'trade' and assigned_company_id is not null))
);
create index warranty_visits_org_window
  on public.warranty_service_visits (org_id, window_start);
create index warranty_visits_tech_day
  on public.warranty_service_visits (assigned_user_id, window_start)
  where assignee_kind = 'tech';
create index warranty_visits_company
  on public.warranty_service_visits (assigned_company_id, status)
  where assignee_kind = 'trade';

create table public.warranty_visit_photos (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  visit_id uuid not null references public.warranty_service_visits(id) on delete cascade,
  file_id uuid not null references public.files(id),
  caption text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index warranty_visit_photos_visit on public.warranty_visit_photos (visit_id);

-- ===== SLA targets: org-configurable per severity =====
create table public.warranty_sla_targets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  severity text not null check (severity in ('emergency','routine_30','routine_60')),
  first_response_hours integer not null check (first_response_hours > 0),
  resolution_days integer not null check (resolution_days > 0),
  unique (org_id, severity)
);
```

Defaults seeded with the program: emergency 24h/3d, routine_30 72h/30d,
routine_60 120h/60d. Sub-portal RLS: visits are read/mutated through the
service-role client behind token auth (same pattern as punch portal functions), so
no anon policies — RLS stays org-membership-only.

### 5.3 Migration `<ts>_warranty_backcharges.sql`

```sql
create table public.warranty_backcharges (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  warranty_request_id uuid not null references public.warranty_requests(id),
  company_id uuid not null references public.companies(id),        -- the trade charged
  commitment_id uuid references public.commitments(id),            -- ORIGINATING PO (master §5.5); nullable: legacy/imported homes may lack one
  cost_code_id uuid references public.cost_codes(id),
  backcharge_number integer not null,                              -- per-org sequence
  status text not null default 'draft'
    check (status in ('draft','issued','disputed','recovered','written_off','waived')),
  amount_cents bigint not null check (amount_cents > 0),           -- positive; sign lives on the credit
  recovered_cents bigint not null default 0 check (recovered_cents >= 0),
  reason text not null,                                            -- narrative: what failed, why the trade owes
  cost_basis jsonb not null default '[]'::jsonb,                   -- [{label, amount_cents, ref_type?, ref_id?}] remediation costs backing the amount
  vendor_credit_bill_id uuid references public.vendor_bills(id),   -- the negative vendor_bills row (set on issue)
  issued_at timestamptz,
  issued_by uuid,
  disputed_at timestamptz,
  dispute_note text,
  resolved_at timestamptz,                                         -- recovered / written_off / waived timestamp
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, backcharge_number)
);
create index warranty_backcharges_org_status on public.warranty_backcharges (org_id, status);
create index warranty_backcharges_company on public.warranty_backcharges (company_id);
create index warranty_backcharges_commitment on public.warranty_backcharges (commitment_id)
  where commitment_id is not null;
create index warranty_backcharges_request on public.warranty_backcharges (warranty_request_id);
```

## 6. Service layer — extend `lib/services/warranty.ts`

One module, sectioned (coverage / requests / visits / backcharges / analytics). If
the file passes ~1,200 lines, split into `lib/services/warranty/` directory with an
`index.ts` re-export **keeping every existing import path working** — never a second
parallel module. All functions follow `requireOrgContext()` → `requirePermission()`
→ logic → `recordEvent()`/`recordAudit()` → mapped DTO; portal/tech-mobile variants
use the service-role client behind token/session auth like the existing
`*FromPortal` functions.

```ts
// ===== Coverage =====
export interface WarrantyProgramDTO { id: string; name: string; is_default: boolean;
  is_active: boolean; terms: WarrantyCoverageTermDTO[] }
export interface WarrantyCoverageTermDTO { key: string; label: string;
  duration_months: number; is_structural: boolean; description: string | null }
export interface ProjectWarrantyCoverageDTO { project_id: string; program_id: string;
  effective_date: string; effective_source: "closing" | "manual";
  terms: Array<WarrantyCoverageTermDTO & { expires_on: string; expired: boolean }>;
  structural_carrier: string | null; structural_policy_number: string | null }

export async function listWarrantyPrograms(orgId?: string): Promise<WarrantyProgramDTO[]>
export async function upsertWarrantyProgram(input: WarrantyProgramInput, orgId?: string): Promise<WarrantyProgramDTO> // perm warranty.manage; editing terms NEVER rewrites existing snapshots
export async function enrollProjectWarrantyCoverage(input: { projectId: string;
  programId?: string; effectiveDate?: string }, orgId?: string): Promise<ProjectWarrantyCoverageDTO>
  // computes terms_snapshot (per-term expires_on = effective_date + duration_months).
  // Called automatically by ws06's closing settlement (outbox job or direct call —
  // coordinate; effective_source='closing') and manually from the desk for
  // pre-existing/custom homes (effective_source='manual').
export async function getProjectWarrantyCoverage(projectId: string, orgId?: string): Promise<ProjectWarrantyCoverageDTO | null>
export function classifyCoverage(coverage: ProjectWarrantyCoverageDTO | null,
  termKey: string | null, asOf: Date): "in_warranty" | "out_of_warranty" | "unclassified"
  // pure function, unit-testable: no coverage/term → unclassified; expired term → out_of_warranty

// ===== Requests (existing functions extended, same names) =====
// createWarrantyRequest / createWarrantyRequestFromPortal gain: severity, category,
// cost_code_id, coverage_term_key, photos (file ids), request_number via project
// sequence RPC, SLA stamping (first_response_due_at / resolution_due_at from
// warranty_sla_targets by severity), coverage_status = classifyCoverage(...),
// cost-dump guard evaluation (§9), source.
// updateWarrantyRequest gains: severity/category/cost_code/coverage overrides
// (override requires coverage_override_reason — reject otherwise), assigned_user_id,
// structural claim fields. Re-stamps SLA dues when severity changes.
export async function listWarrantyRequestsForOrg(params: { orgId?: string;
  status?: string[]; severity?: string[]; communityId?: string; assignedUserId?: string;
  companyId?: string; coverageStatus?: string[]; slaState?: "breached" | "due_soon";
  search?: string; page?: number; pageSize?: number }): Promise<{ rows: WarrantyRequestListRow[]; total: number }>
  // THE desk query. Server-paginated (default 50, cap 200 — hundreds of homes under
  // warranty is the design case). Joins project→lot→community for community filter
  // (post-01); sla_state computed in SQL against now().

// ===== Visits =====
export interface WarrantyServiceVisitDTO { id: string; request_id: string; visit_number: number;
  assignee_kind: "tech" | "trade"; assigned_user_id: string | null; assigned_user_name: string | null;
  assigned_company_id: string | null; assigned_company_name: string | null;
  window_start: string; window_end: string; status: string; outcome: string | null;
  outcome_note: string | null; confirmed_at: string | null; completed_at: string | null;
  buyer_signoff_name: string | null; buyer_signoff_at: string | null; photos: WarrantyPhotoDTO[] }

export async function scheduleWarrantyVisit(input: { requestId: string;
  assigneeKind: "tech" | "trade"; assignedUserId?: string; assignedCompanyId?: string;
  windowStart: string; windowEnd: string; note?: string }, orgId?: string): Promise<WarrantyServiceVisitDTO>
  // perm warranty.write. Sets request first_responded_at if null; request status → in_progress.
  // trade: sets request.assigned_company_id + dispatched_at, sends dispatch email
  //   (EXTEND sendWarrantyDispatchEmail: appointment window + sub-portal confirm link)
  // tech: notification 'warranty_visit_assigned' to the tech (in-app; email via allowlist)
  // buyer: notification of the appointment window (email 'warranty_appointment_scheduled')
export async function rescheduleWarrantyVisit(...): Promise<WarrantyServiceVisitDTO>   // re-notifies
export async function cancelWarrantyVisit(...): Promise<WarrantyServiceVisitDTO>
export async function completeWarrantyVisit(input: { visitId: string;
  outcome: "resolved" | "needs_followup" | "needs_parts" | "not_warrantable";
  outcomeNote?: string; photoFileIds?: string[]; buyerSignoffName?: string;
  buyerSignatureFileId?: string }, orgId?: string): Promise<WarrantyServiceVisitDTO>
  // outcome 'resolved' → request status 'resolved' (fires existing resolved email);
  // 'needs_followup'/'needs_parts' → request stays in_progress (desk prompts next visit);
  // 'not_warrantable' → surfaces coverage-override prompt on the request.
// Sub-portal (service-role, token-auth upstream; mirror completePunchItemFromPortal
// including the assigned_company_id ownership check):
export async function listWarrantyVisitsForCompanyPortal({ orgId, companyId }): Promise<WarrantyServiceVisitDTO[]>
export async function confirmWarrantyVisitFromPortal({ orgId, companyId, visitId }): Promise<WarrantyServiceVisitDTO>   // status → confirmed
export async function completeWarrantyVisitFromPortal({ orgId, companyId, visitId, outcomeNote, photoFileIds }): Promise<WarrantyServiceVisitDTO>
  // portal completion → visit 'completed' but request needs OFFICE verification to
  // resolve (mirror punch verify): request gets metadata.pending_verification=true;
  // desk queue shows "verify" state.

// ===== Backcharges (§7 for money mechanics) =====
export async function createWarrantyBackcharge(input: WarrantyBackchargeInput, orgId?: string): Promise<WarrantyBackchargeDTO> // draft
export async function issueWarrantyBackcharge({ backchargeId }, orgId?: string): Promise<WarrantyBackchargeDTO>
export async function disputeWarrantyBackcharge({ backchargeId, note }, orgId?: string): Promise<WarrantyBackchargeDTO>
export async function resolveWarrantyBackcharge({ backchargeId,
  resolution: "recovered" | "written_off" | "waived", recoveredCents? }, orgId?: string): Promise<WarrantyBackchargeDTO>
export async function findOriginatingCommitments({ projectId, costCodeId?, companyId? },
  orgId?: string): Promise<CommitmentMatchDTO[]>
  // the "find it via cost code + lot's PO set" helper: commitments on the project,
  // ranked — exact cost-code match on commitment_lines first, then same company,
  // then the rest. Powers the backcharge form's PO picker.

// ===== Analytics (§9) =====
export async function getWarrantyDefectAnalysis(params: { orgId?: string;
  groupBy: "plan" | "plan_version" | "company" | "cost_code" | "community";
  from?: string; to?: string }): Promise<DefectAnalysisRow[]>
export async function getWarrantyCostSummary(params: { orgId?: string;
  communityId?: string }): Promise<WarrantyCostRow[]>   // per community: cost, revenue, pct, benchmark flag
```

Aggregates use SQL aggregate RPCs, not row-fetch-and-sum (platform-ops memory:
aggregate RPCs for >1000-row sums).

## 7. Backcharge money-mechanics spec (the load-bearing decision)

**Question:** does a backcharge post as a negative `commitment_change_orders` row
(VCO with `reason_code='warranty_backcharge'`) or as a vendor-bill credit?

**Decision: the vendor-credit rail is the money artifact; the commitment link is
attribution metadata.** Reasoning, in order:

1. **The originating PO is closed by the time warranty hits.** A workmanship
   backcharge lands months-to-years after the trade's PO was fully billed and paid.
   A negative CCO would retroactively shrink committed cost on a closed, reconciled
   house — corrupting historical community P&L and VPO variance reporting (which
   workstream 04 builds ON commitment_change_orders; polluting it with warranty
   entries breaks the ≤1–2% variance benchmark math).
2. **A vendor credit is a real AP artifact with rails that already work end to
   end:** negative-line `vendor_bills` row (`metadata.source='vendor_credit'`,
   enforced negative lines ~L954), application-to-bill settlement rows so the
   trade's NEXT bill on any project is short-paid, commitment rollups already net
   credits, and QBO sync already round-trips vendor credits. Recovery is literally
   "the credit got applied" — no new money concepts.
3. **Master §5.5 is satisfied by the FK, not by the posting.**
   `warranty_backcharges.commitment_id` ties the charge to the originating PO for
   per-trade/per-plan analytics and for the trade-scorecard feed into workstream
   04's purchasing decisions. Attribution and cash mechanics are different jobs.

**Lifecycle:**

- **Draft:** service manager builds the backcharge from the warranty request —
  picks the trade, picks the originating commitment via
  `findOriginatingCommitments` (cost-code-ranked picker over the lot's PO set),
  itemizes `cost_basis` (tech hours × loaded rate, the fixing trade's bill — by
  reference where the remediation cost is already a `vendor_bills`/expense row on
  the lot's project, flagged `metadata.warranty_request_id`).
- **Issue** (`issueWarrantyBackcharge`, perms `warranty.write` AND
  `payables.write` since it writes AP): creates the vendor credit through the
  EXISTING vendor-bill creation path in `vendor-bills.ts` (do not hand-insert):
  negative line(s) mirroring `cost_basis`, `vendor/company = company_id`,
  `project_id` = the lot's project (so community P&L nets the recovery),
  `cost_code_id` carried onto the line, metadata
  `{ source: 'vendor_credit', origin: 'warranty_backcharge', warranty_backcharge_id,
  warranty_request_id, commitment_id }`. Stores `vendor_credit_bill_id`; status →
  `issued`; emails the trade a backcharge notice (dispatch-email pattern: itemized
  basis, request reference, dispute instructions). Accounting sync picks the credit
  up via the existing rails untouched — doc 08's `AccountingProvider.pushVendorBill`
  explicitly handles "negative totals = vendor credit", so backcharges cross the
  accounting seam with **zero provider-specific code and zero new `qbo_*` columns**
  (doc 08's standing rule; metadata keys above are the only linkage).
- **Recovery tracking:** `recovered_cents` updates when the credit is applied to a
  bill (hook the existing apply-credit settlement path in `vendor-bills.ts` to
  check credit metadata for `warranty_backcharge_id` and update the backcharge —
  one small, well-marked addition) or manually via `resolveWarrantyBackcharge`
  (trade sent a check). Full application → status `recovered`. Desk shows
  billed-vs-recovered aging; `written_off`/`waived` require a note and VOID the
  unapplied credit through the existing vendor-bill delete/void path so AP doesn't
  carry a phantom credit.
- **Dispute:** status flag + note + timestamp; the credit stays unapplied while
  disputed (the apply-credit hook must skip disputed backcharges' credits —
  surface this in the payables UI as a badge on the credit row).
- **Guards:** no issuing against a company with zero AP history without a
  confirmation (the credit may never be recoverable); `amount_cents` must equal
  the sum of `cost_basis`; one backcharge may be partially recovered then written
  off for the remainder (`resolveWarrantyBackcharge` accepts final
  `recoveredCents`).

## 8. Actions

Extend `app/(app)/warranty/actions.ts` (org desk + settings) and
`app/(app)/projects/[id]/actions.ts` or the project warranty tab's actions for
project-scoped mutations; portal actions in `app/p/[token]/warranty/actions.ts` and
`app/s/[token]/` warranty actions. Every action: Zod schema in
`lib/validation/warranty.ts` (extend), thin call into the service, returns
`ActionResult<T>` via `actionError` (existing pattern in the file), `revalidatePath`
on the touched surfaces. New schemas: program/terms upsert, coverage enroll,
request create/update (extended fields; `coverage_override_reason` required iff
`coverage_status` differs from computed), visit schedule/reschedule/complete
(window sanity), backcharge create/issue/dispute/resolve (positive cents,
cost-basis sum check), SLA-target upsert. Portal visit-confirm/complete actions
authenticate via the sub-portal token exactly like punch completion.

## 9. Analytics & guards spec

- **Recurring-defect analysis** (`getWarrantyDefectAnalysis`): request counts +
  remediation cost + backcharge recovery, grouped by community / cost code /
  company (trade = dispatched company or backcharged company), and — once ws02
  lands plan pins on lots — house_plan / plan_version (join
  project → lot → plan_version). Each row: request count, % of that group's closed
  homes with ≥1 request, avg cost, top categories. Surface: desk Analytics tab +
  a "warranty signal" feed into ws04's vendor scorecard (export a
  `getCompanyWarrantySignal(companyId)` helper for ws04 to call — count, cost,
  open backcharges; do NOT build purchasing UI here).
- **Cost vs benchmark** (`getWarrantyCostSummary`): per community — warranty cost
  (sum of warranty-flagged bills/expenses on that community's projects + tech-visit
  cost basis, minus recovered backcharges) ÷ closed revenue (from ws06 closings) as
  %, colored against the 0.7–1.0% band (master §9). Until ws06 ships revenue, show
  absolute cost only (no fake denominators).
- **Cost-dumping guard:** at request creation, if the request lands within N days
  of the coverage `effective_date` (org setting, default 60) AND the project had
  open punch items at closing (or still open), set `cost_dump_flag=true` and
  record why in metadata. Desk queue shows a quiet flag column; Analytics tab
  totals flagged cost per community/super. This is a review signal, never a block.

## 10. UI spec

Design rules bind (CLAUDE.md): tokens only, radius 0, no heroes/marquees, shadcn
primitives, dense editorial tables, tabular-nums for money, color = state only.
Every view: empty / loading / error states + dark mode. Match sibling page density.

- **Org Warranty/Service desk — `app/(app)/warranty/page.tsx` (new page next to the
  existing actions.ts).** Passes the whole-JOB test: the service manager's entire
  job. Title row + tabs (pattern: the financials review queue / org desks — no
  billboard stats):
  - **Queue** (default): server-paginated table over `listWarrantyRequestsForOrg` —
    #, home (project → community), title, category, severity, coverage badge
    (in/out/goodwill), assignee (tech avatar or trade name), next visit window,
    **SLA age** (time to breach or time since breach — text color state only:
    destructive past due), cost-dump flag, status. Filters: status, severity,
    community, assignee, coverage, SLA breached. Row opens the request detail sheet
    IN PLACE (review-detail-overlays pattern) — no navigation. Sheet: full request,
    coverage panel (terms + expiries for that home), photos, visit timeline,
    classify/override controls, schedule-visit form, backcharge launcher.
  - **Dispatch board:** week grid, one row per tech + a "Trades" section; visits as
    blocks in their windows (dense schedule-like grid — reuse gantt/schedule CSS
    vocabulary, not a new calendar framework). Unscheduled triaged requests in a
    left rail; assign via the row's schedule control (form, not drag, in v1).
  - **Backcharges:** table — #, trade, home, originating PO (link to commitment),
    amount, recovered, aging since issue, status; row sheet with cost basis, credit
    link, dispute/resolve controls. Footer sums billed vs recovered.
  - **Analytics:** two dense tables (defect analysis with groupBy switcher; cost vs
    benchmark per community). Tables, not chart walls.
  - Desk is org-scoped read + one-click-complete only via the same server actions
    the workbench uses (desk doctrine); the mutation home is the request sheet
    (shared component between desk and project tab — extend
    `components/warranty/warranty-client.tsx`'s detail sheet rather than forking).
- **Project warranty tab** (exists): gains coverage panel, visit timeline, photos,
  and the same detail sheet. No layout rebuild.
- **Settings:** warranty program + terms editor and SLA targets under org settings
  (SettingsWindow tab or `/settings/warranty` mirroring `/settings/checklists`).
- **Buyer portal `app/p/[token]/warranty/`** (exists — extend): coverage summary
  ("Your warranty" — terms with expiry dates, quiet expired styling), request form
  gains category picker, severity hint, and **photo upload** (reuse the portal file
  upload used elsewhere in `app/p`), request list gains appointment visibility
  (next visit window, tech/trade name only — no internal notes) and post-visit
  **sign-off** (name + signature capture on a completed visit awaiting sign-off).
  Terminology: production posture says "Buyer portal" (master §2) — use
  `terminology(posture)` for all nouns.
- **Sub portal `app/s/[token]/`:** warranty appointments section beside the punch
  queue (coordinate with ws04's confirm→complete loop — same visual list pattern,
  ONE work surface for the trade): visit rows with window, address, scope; Confirm
  button; Complete with note + photos. Backcharge notices are email-only in v1.
- **Tech mobile (`/api/mobile/v1`):**
  - `GET /api/mobile/v1/service/visits?date=YYYY-MM-DD` — the tech's day list
    (own visits; service manager may pass `userId` with `warranty.read`).
  - `GET /api/mobile/v1/service/visits/[visitId]` — detail (request, home address,
    photos, buyer contact).
  - `POST /api/mobile/v1/service/visits/[visitId]/complete` — outcome + note +
    photo file ids (upload via the existing mobile files flow) + optional buyer
    sign-off fields.
  - Follow the punch-items route pattern (session auth, org resolution, mapped
    DTOs). iOS UI itself is follow-up work in the ios/ repo — record as debt.

## 11. RBAC, events, notifications, search, cron

- **RBAC (catalog-as-code seed migration, `*rbac_catalog_seed*` pattern):**
  permissions `warranty.manage` (programs, SLA targets, coverage enrollment
  overrides) and `warranty.backcharge` (create/issue/resolve — issue additionally
  requires `payables.write` in the service); keep `warranty.read`/`warranty.write`.
  New assignable role **`org_warranty_manager`** (catalog role keys are
  `org_`-prefixed per the existing seed; bookkeeper/estimator pattern):
  warranty.* + payables read/write + projects read. Techs = members with
  `warranty.write` scoped by assignment (respect `membership_project_scope`).
- **Events:** keep existing three; add `warranty_coverage_enrolled`,
  `warranty_visit_scheduled`, `warranty_visit_confirmed`,
  `warranty_visit_completed`, `warranty_request_signoff`,
  `warranty_backcharge_issued`, `warranty_backcharge_disputed`,
  `warranty_backcharge_resolved`, `warranty_sla_breached`. Every mutation records
  audit.
- **Notifications:** in-app for tech assignment, visit confirmed/completed,
  backcharge disputed, SLA breach (to warranty managers). EMAIL allowlist additions
  (`EMAIL_NOTIFICATION_TYPES` — keep the list tight): `warranty_visit_assigned`
  (tech), `warranty_sla_breached` (managers). Buyer/trade emails (dispatch,
  appointment scheduled, resolved, backcharge notice) remain direct mailer sends to
  external contacts like today — they are not user notifications.
- **Search:** register `warranty_request` (and `warranty_backcharge`) entity types
  in the search index write-through (recordAudit+outbox pattern per the search
  overhaul), titled `WR-{number} {title}` deep-linking to the desk sheet.
- **Cron:** `warranty-sla-sweep` — hourly GET route marking newly-breached
  requests (event + notification, idempotent via a `metadata.sla_breached_at`
  stamp). Add to `vercel.json`, `PUBLIC_API_ROUTES` in `proxy.ts`, AND the
  `CRON_JOBS` registry (all three or it silently never runs — cron-GET memory).

## 12. Migration plan

Order (all additive; apply via `supabase/migrations/` + Supabase MCP with the
human watching — local env is PRODUCTION):

1. `<ts>_warranty_coverage.sql` (§5.1) — after verifying live `warranty_requests`
   columns with `list_tables`.
2. `<ts>_warranty_service_ops.sql` (§5.2) — includes the `request_number` backfill
   (per-project, ordered by created_at) before its unique index.
3. `<ts>_warranty_backcharges.sql` (§5.3).
4. `<ts>_warranty_rbac_catalog_seed.sql` — permissions + role.

No data migration beyond the number backfill: existing `warranty_requests` rows get
defaults (`severity='routine_30'`, `coverage_status='unclassified'`) and keep
working in the existing UI untouched between phases. Coverage enrollment for
already-closed homes is manual (desk action) — never fabricate effective dates.

## 13. Phases + acceptance criteria

**Phase 1 — Coverage model.** Migrations 1+4; program/terms/SLA settings UI; enroll
(manual + hook point for ws06 closings); classification at intake with override;
structural claim fields; coverage panel on project tab + buyer portal.
*Accept:* org configures a 1-2-10 program; enrolling a home snapshots terms with
correct expiries; a request against an expired term auto-classifies
`out_of_warranty` and overriding demands a reason; program edits don't move existing
homes' expiries; buyer portal shows coverage; `pnpm lint` + `pnpm test:financials`
clean.

**Phase 2 — Service operations.** Migration 2; extended intake (photos, severity,
category, cost code, SLA stamping); visits (tech + trade) with schedule/reschedule/
complete; trade confirm/complete via sub portal with office verification; buyer
sign-off; dispatch email extended with window + portal link; SLA sweep cron.
*Accept:* office schedules a tech visit → tech notified, buyer emailed the window;
trade visit → dispatch email → sub confirms and completes with photos in the portal
→ desk verifies → request resolves and buyer sign-off is captured; breached
emergency request flags within the hour; every state change events + audits.

**Phase 3 — Desk + mobile.** Org desk page (queue/dispatch board tabs), shared
detail sheet refactor, mobile tech endpoints.
*Accept:* desk lists 500 open requests paginated without a full-table fetch; SLA
aging sorts/filters server-side; dispatch board shows a tech's week; mobile day
list + complete round-trips with photos; empty/loading/error + dark verified on
every new view.

**Phase 4 — Backcharges.** Migration 3; backcharge lifecycle; vendor-credit
issuance through existing rails; apply-credit recovery hook; desk backcharge tab;
trade notice email.
*Accept:* issuing creates a negative vendor_bills credit visible in payables and
QBO-syncable with zero qbo-code changes; applying the credit to the trade's next
bill updates `recovered_cents` and flips status at full recovery; disputed credits
can't be applied; the originating-PO picker ranks the lot's cost-code-matching
commitment first; `pnpm test:financials` green.

**Phase 5 — Analytics + guards.** Defect analysis, cost-vs-benchmark, cost-dump
guard, `getCompanyWarrantySignal` export for ws04.
*Accept:* groupBy community/cost_code/company correct against a seeded fixture set
(plan grouping behind a graceful "needs plan data" empty state until ws02 data
exists); a request 30 days post-closing on a home with open punch items gets
flagged; benchmark table shows % only where closing revenue exists.

## 14. Test plan

- **Unit:** `classifyCoverage` (boundary dates, missing coverage, structural),
  terms_snapshot expiry math (month arithmetic across year ends), SLA stamping and
  re-stamping on severity change, cost-basis sum guard, backcharge status machine
  (illegal transitions rejected), cost-dump predicate.
- **Financials (`pnpm test:financials`):** backcharge → credit line signs and
  totals; commitment rollup nets the warranty credit; apply-credit hook updates
  `recovered_cents` exactly once (idempotency on settlement replay); partial
  recovery then write-off arithmetic.
- **Service/integration:** visit lifecycle including portal confirm/complete with
  wrong-company token rejected (mirror the punch test shape); office verification
  gate; enrollment idempotency (re-enroll same project errors, unique constraint).
- **Manual QA script:** the Phase 2 acceptance flow end-to-end on a staging org
  (NOT real customer data — local env is production; use the internal test org),
  dark mode + empty states pass, emails land with correct sender/branding.

## 15. Open questions

1. **Closing hook shape (ws06):** does closing settlement call
   `enrollProjectWarrantyCoverage` directly or via an outbox job? Default: outbox
   (`warranty.enroll_coverage`) so closing never fails on warranty errors. Confirm
   when 06 is drafted.
2. **Warranty reserve accrual** (X% of revenue at closing posting to GL) — wanted
   by controllers; belongs to ws08's accounting layer. Deferred; record where.
3. **Tech capacity/labor cost:** loaded hourly rate per tech for cost-basis math —
   org setting now (single org-wide rate) or per-user later? Default: single org
   rate in warranty settings, per-user is future.
4. **Buyer sign-off legality:** typed-name sign-off vs the existing e-sign rail.
   Default: typed name + timestamp + optional signature image (visit sign-off is a
   service receipt, not a contract). Revisit if a customer needs e-sign.
5. **Severity taxonomy vs existing `priority`:** both remain (priority = triage
   urgency, severity = SLA class)? Default here keeps both but the desk surfaces
   only severity; if that reads as duplication in practice, deprecate priority in a
   follow-up (never silently repurpose it — existing UI reads it).
6. **Trade backcharge consent flow:** some builders get a signed backcharge
   acknowledgment before deducting. V1 is notify + dispute window; an e-sign
   acknowledgment is future.
