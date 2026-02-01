# Opportunities + Preconstruction Projects + Bid Management (LLM-Optimized Gameplan)

Date: 2026-02-01

This document is a **detailed, implementation-ready plan** for:
1) introducing **Opportunities** as the true pipeline entity (instead of “lead = contact”),
2) creating a **Preconstruction Project** container as soon as estimating starts (so bids + files + drawings have an anchor), and
3) implementing **Subcontractor Bid Management** (ITB/RFQ, addenda, bid intake via link, leveling, award → commitment).

It is written to be executable by an LLM agent: explicit phases, concrete deliverables, DB schema changes, and acceptance checks.

---

## Progress Log

### 2026-02-01
- ✅ Stage A complete: migrations applied (opportunities + bids + opportunity links), RLS enabled, docs updated.
- ✅ Stage B complete: opportunities service + pipeline UI + detail sheet + create flow.
- ✅ Stage C complete: start estimating creates/links precon project and routes estimate creation with project prefilled.
- ✅ Stage D complete: project-scoped bids UI (packages, invites, addenda, attachments) with planning→bidding transition.
- ✅ Stage D polish: invite link refresh + bid detail revalidation.
- ✅ Stage E complete: public bid portal with token validation, pin gate, access tracking, and submission flow.
- ✅ Stage F complete: award action creates commitment, records award, and updates package status.
- ✅ Stage G complete: proposal acceptance hardening, addendum acknowledgements, and DB security fixes.

## 0) Current State (Verified in Repo/DB)

### 0.1 CRM / Pipeline today
- “Prospects” are `contacts` with `contact_type='client'`, and pipeline fields live in `contacts.metadata` (`lead_status`, `lead_owner_user_id`, etc).
  - Code: `lib/services/crm.ts`, `lib/validation/crm.ts`
- Pipeline UI is `/pipeline` (and also `/prospects`), but “Create estimate” is just a deep link to `/estimates?recipient=<contactId>`.
  - Examples: `components/pipeline/prospects-table.tsx`, `components/pipeline/prospect-detail-sheet.tsx`, `components/contacts/contact-detail-sheet.tsx`
- On estimate creation, there’s a best-effort automation that tries to set `contacts.metadata.lead_status = 'estimating'` and records `crm_estimate_created`.
  - Code: `lib/services/estimates.ts` (helper `updateProspectStatusOnEstimateCreation`)

### 0.2 Estimates / Proposals / Contract today
- Estimates are internal worksheets (`estimates` + `estimate_items`) and can be created with `project_id = null`.
- Proposal is the client-facing, signable artifact (`proposals` + `proposal_lines`) with a public link `/proposal/[token]`.
  - Code: `lib/services/proposals.ts`, `app/proposal/[token]/*`
- Acceptance of a proposal:
  - marks proposal accepted,
  - creates a `projects` row **if proposal.project_id is null**,
  - creates a `contracts` row (status `active`),
  - creates a `budgets` row (but currently skips `budget_lines` creation).
  - Code: `lib/services/proposals.ts` (`acceptProposal`)

### 0.3 Key pain points / gaps
- **Bid management doesn’t exist** (no bid tables, no bid portal).
- “Pipeline entity” is a **person**, but construction pipeline is a **job opportunity**.
- Without a precon job container, you can’t cleanly attach bid packages, addenda, and controlled file sharing early.
- Proposal UI allows creating proposals without recipient/project, which creates “orphan-ish” acceptance cases.

---

## 1) Target Model (Normal Builder Workflow)

### 1.1 Terminology (use consistently)
- **Contact**: a person (client contact, subcontractor contact, etc).
- **Company**: a vendor entity (subcontractor/supplier/etc).
- **Opportunity**: a potential job (the pipeline entity).
- **Preconstruction Project**: a `projects` row in status `planning` or `bidding`.
- **Active Project**: a `projects` row in status `active` (execution).
- **Estimate**: internal pricing worksheet (versions, cost codes, subs quotes).
- **Agreement (Proposal)**: client-facing signable snapshot.
- **Contract**: internal operational record created from acceptance.

### 1.2 Lifecycle (high level)
1) Create Opportunity (pipeline)
2) Start Estimating (Opportunity → creates/links Precon Project)
3) Estimate + subcontractor bids happen on that Precon Project
4) Generate Agreement link (Proposal) from an estimate version
5) Client accepts → same project becomes `active` and contract is created/activated

### 1.3 Status semantics (recommended)
**Opportunity status** (pipeline):
- `new` → `contacted` → `qualified` → `estimating` → `proposed` → `won` OR `lost`

**Project status** (already exists in DB):
- `planning`: precon job shell exists, early intake/design
- `bidding`: active estimating/bid collection phase
- `active`: signed and executing
- (`on_hold`, `completed`, `cancelled` unchanged)

Rule of thumb:
- Opportunity drives precon; Project drives operations.
- Project is always visible in `/projects` but status reflects precon vs active.
- Planning → Bidding transition:
  - Create the precon project in `planning` when estimating starts.
  - Transition the project to `bidding` when bidding actually starts (first bid package is sent/opened), not when a package is merely drafted.

---

## 2) Data Model Changes (Supabase / Postgres)

### 2.1 New tables (Opportunities)

#### 2.1.1 `opportunities`
Purpose: pipeline entity, 1 row per potential job.

Recommended columns:
- `id uuid pk`
- `org_id uuid not null references orgs(id)`
- `client_contact_id uuid not null references contacts(id)` (primary client contact)
- `name text not null` (e.g. “Smith Residence – Naples”)
- `status opportunity_status not null` (enum; see below)
- `owner_user_id uuid references app_users(id)` (internal owner)
- `jobsite_location jsonb` (mirror your CRM `jobsite_location` structure)
- `project_type text` (mirror `lead_project_type` if you keep it)
- `budget_range text` (mirror `lead_budget_range`)
- `timeline_preference text` (mirror `lead_timeline_preference`)
- `source text` (optional)
- `tags text[]` (optional)
- `notes text` (optional)
- `created_at timestamptz default now()`
- `updated_at timestamptz default now()`

Indexes:
- `(org_id, status)`
- `(org_id, client_contact_id)`
- `(org_id, owner_user_id)`

Enum recommendation:
- `opportunity_status` enum values:
  - `new`, `contacted`, `qualified`, `estimating`, `proposed`, `won`, `lost`

#### 2.1.2 Opportunity↔Project linkage
You want the precon project to become the “real project” (same row). That implies **1:1** once estimating starts.

Pick one of these (recommend A for ergonomics):
- **A (recommended): add `opportunity_id` on `projects`**
  - `projects.opportunity_id uuid references opportunities(id) on delete set null`
  - unique index `unique(opportunity_id)` where opportunity_id is not null
  - This makes project → opportunity joins trivial and keeps project as the anchor.
- **B: store `project_id` on `opportunities`**
  - `opportunities.project_id uuid references projects(id) on delete set null`
  - unique index `unique(project_id)` where project_id is not null

Either way, enforce 1:1 once set.

Decision: **use option A** (`projects.opportunity_id`).

#### 2.1.3 Optional “snapshot” columns on estimates/proposals
To make reporting and migration safer (especially while you refactor flows):
- `estimates.opportunity_id uuid null references opportunities(id)`
- `proposals.opportunity_id uuid null references opportunities(id)`

These can be written at creation time even if `project_id` is missing, and help you prevent “orphan acceptance”.

### 2.2 New tables (Bid Management)

Key design principle: **bids are project-scoped**, and everything a subcontractor sees is scoped to a **bid package**.

#### 2.2.1 `bid_packages`
Purpose: “Invite to Bid / RFQ” container for a trade/scope.

Columns:
- `id uuid pk`
- `org_id uuid not null references orgs(id)`
- `project_id uuid not null references projects(id)`
- `title text not null` (e.g. “Electrical – Rough & Trim”)
- `trade text null` (optional for filtering)
- `scope text null` (rich text string)
- `instructions text null`
- `due_at timestamptz null`
- `status text not null default 'draft'` with allowed values:
  - `draft`, `sent`, `open`, `closed`, `awarded`, `cancelled`
- `created_by uuid references app_users(id)`
- `created_at timestamptz default now()`
- `updated_at timestamptz default now()`

Indexes:
- `(org_id, project_id, status)`
- `(project_id, due_at)`

#### 2.2.2 `bid_invites`
Purpose: one row per invited subcontractor (company/contact) for a package.

Columns:
- `id uuid pk`
- `org_id uuid not null references orgs(id)`
- `bid_package_id uuid not null references bid_packages(id) on delete cascade`
- `company_id uuid not null references companies(id)` (bidder of record; required for award→commitment)
- `contact_id uuid references contacts(id)` (optional; specific person at the company)
- `invite_email citext null` (optional; delivery fallback even if no contact record)
- `status text not null default 'draft'` allowed:
  - `draft`, `sent`, `viewed`, `declined`, `submitted`, `withdrawn`
- `sent_at timestamptz null`
- `last_viewed_at timestamptz null`
- `submitted_at timestamptz null`
- `declined_at timestamptz null`
- `created_by uuid references app_users(id)`
- `created_at timestamptz default now()`
- `updated_at timestamptz default now()`

Constraints:
- unique: `(bid_package_id, company_id)` where company_id not null
- unique: `(bid_package_id, contact_id)` where contact_id not null
- unique: `(bid_package_id, invite_email)` where invite_email not null

Operational rule (no-code but important):
- If the builder only has an email, require creating/selecting a `companies` row first (“Create subcontractor from invite”) so the bidder can be awarded into a commitment cleanly.

#### 2.2.3 `bid_access_tokens` (public portal access)
Purpose: public link `/b/[token]` scoped to one invite.

Security pattern: store **only a hash** of token (like proposals).

Columns:
- `id uuid pk`
- `org_id uuid not null references orgs(id)`
- `bid_invite_id uuid not null references bid_invites(id) on delete cascade`
- `token_hash text not null unique`
- `expires_at timestamptz null`
- `max_access_count int null`
- `access_count int not null default 0`
- `last_accessed_at timestamptz null`
- `pin_required boolean not null default false`
- `pin_hash text null`
- `pin_attempts int not null default 0`
- `pin_locked_until timestamptz null`
- `revoked_at timestamptz null`
- `created_by uuid references app_users(id)`
- `created_at timestamptz default now()`

Notes:
- Reuse the same PIN gate UX as portals, but keep it bid-only.
- Use a dedicated secret: `BID_PORTAL_SECRET`.

#### 2.2.4 `bid_submissions`
Purpose: the quote itself.

Columns:
- `id uuid pk`
- `org_id uuid not null references orgs(id)`
- `bid_invite_id uuid not null references bid_invites(id) on delete cascade`
- `status text not null default 'submitted'` allowed:
  - `draft`, `submitted`, `revised`, `withdrawn`
- `version int not null default 1`
- `is_current boolean not null default true`
- `total_cents int null`
- `currency text not null default 'usd'`
- `valid_until date null`
- `lead_time_days int null` (luxury custom tends to care)
- `duration_days int null`
- `start_available_on date null`
- `exclusions text null`
- `clarifications text null`
- `notes text null`
- `submitted_by_name text null` (portal user types their name)
- `submitted_by_email citext null`
- `submitted_at timestamptz null`
- `created_at timestamptz default now()`
- `updated_at timestamptz default now()`

Constraints:
- Allow multiple submissions per invite, but enforce exactly one “current”:
  - unique partial index: `(bid_invite_id) where is_current = true`
  - when a sub revises: set prior submissions `is_current=false`, insert a new row with `version = max(version)+1`, `is_current=true`.

#### 2.2.5 `bid_awards` (explicit award audit trail)
Purpose: record the award decision and bridge into procurement reliably.

Columns:
- `id uuid pk`
- `org_id uuid not null references orgs(id)`
- `bid_package_id uuid not null references bid_packages(id) on delete cascade`
- `awarded_submission_id uuid not null references bid_submissions(id)`
- `awarded_commitment_id uuid null references commitments(id)` (filled after award creates commitment)
- `awarded_by uuid references app_users(id)`
- `awarded_at timestamptz not null default now()`
- `notes text null` (why chosen / special terms)

Constraints:
- unique `(bid_package_id)` (one award per package)

#### 2.2.6 Optional v2 tables (line-level leveling)
Only add once you’ve proven demand:
- `bid_scope_items` (the standardized scope lines; ties to cost codes)
- `bid_submission_lines` (responses per scope item; unit cost, qty, etc)

### 2.3 Addenda (minimum viable, strongly recommended)

#### 2.3.1 `bid_addenda`
- `id uuid pk`
- `org_id uuid not null`
- `bid_package_id uuid not null references bid_packages(id) on delete cascade`
- `number int not null` (Addendum 1..N, per package)
- `title text null`
- `message text null`
- `issued_at timestamptz not null default now()`
- `created_by uuid references app_users(id)`

Attachments: use existing `file_links` with `entity_type='bid_addendum'`.

#### 2.3.2 `bid_addendum_acknowledgements`
- `id uuid pk`
- `org_id uuid not null`
- `bid_addendum_id uuid not null references bid_addenda(id) on delete cascade`
- `bid_invite_id uuid not null references bid_invites(id) on delete cascade`
- `acknowledged_at timestamptz not null default now()`

Constraints:
- unique `(bid_addendum_id, bid_invite_id)`

### 2.4 Files & drawings sharing rule (simple and safe)
For bid portal, do **not** expose “project files” broadly.

Only show:
- files linked to `bid_package` and `bid_addendum` via `file_links`.

This matches “builder allows them to see” without inventing complex ACL.

### 2.5 RLS policies (internal tables)
For opportunities + bids tables:
- Enable RLS.
- Use the same baseline pattern as your other tenant tables:
  - allow `service_role` or `is_org_member(org_id)` for internal operations.
- Do NOT rely on RLS for public bid portal reads; use service role + token verification server-side.

---

## 3) UX / IA Changes

### 3.1 Global navigation
- Replace/rename current `/pipeline` to **Opportunities** pipeline.
  - “Prospects” remains a contact list (clients), not the pipeline object.
  - Multiple opportunities per client becomes natural.

### 3.2 Opportunity screens (minimum)
1) Opportunity list (pipeline board/table)
2) Opportunity detail sheet/page:
   - client contact
   - address/jobsite
   - status, owner, budget range, timeline
   - CTA: **Start Estimating**
   - linked artifacts:
     - precon project (if exists)
     - estimates
     - agreement/proposal(s)

### 3.3 Start Estimating (critical workflow)
When user clicks **Start Estimating**:
1) Create a precon `projects` row if missing:
   - status: `bidding` (recommended) or `planning` (if you want a softer stage)
   - `client_id` from opportunity’s client contact
   - location from opportunity.jobsite_location
   - set `projects.opportunity_id`
2) Create first estimate (or route user to estimate create with project prefilled).

Acceptance criteria:
- Bid packages and shared drawings/files can attach immediately to the precon project.
- Precon project appears in `/projects` with status “Bidding” (or “Planning”).

### 3.4 Project module: Bids
Add `Project → Bids` section in sidebar (project-scoped nav).

Pages:
- `/projects/[id]/bids` list of packages
- `/projects/[id]/bids/[packageId]` package detail:
  - scope/instructions
  - invite list + statuses + “copy link / resend”
  - attached files + addenda
  - submissions list (and simple compare table)
  - award action (creates draft commitment)

### 3.5 Public bid portal
Route: `/b/[token]`

What the subcontractor sees:
- package title, due date, scope/instructions
- included files (package + addenda)
- addenda acknowledgement
- submission form:
  - total, notes/exclusions/clarifications, lead time/start date, upload quote

Security requirements:
- token hash lookup
- expiry, max views, optional PIN
- record access counts
- no project-wide navigation or other project resources

---

## 4) System Integrations (Critical)

### 4.1 Award → Commitment (your “money loop” bridge)
When awarding a bid submission (internal approval/award flow):
1) Builder selects the winning **current** submission.
2) System writes:
   - a `bid_awards` row (authoritative record),
   - a draft `commitments` row for the awarded vendor,
   - optional `commitment_lines`:
     - v1: one line “<package title>” for total (fast, demo-friendly)
     - v2: map to cost codes if line-level leveling exists
3) System updates statuses:
   - `bid_packages.status = 'awarded'`
   - winner `bid_invites.status` stays `submitted` (or introduce `awarded` later if you want)
   - non-winners remain `submitted` (avoid rejection messaging in v1)
4) System emits `events` + `audit_log`.

Also:
- Add vendor to `project_vendors` if not present.
- Emit `events` + `audit_log`.

### 4.2 Estimate coupling (“gold standard”)
In luxury custom, most users need:
- bid package is derived from estimate cost codes/trades **when convenient**, not mandatory.

Recommended v1:
- Let user create bid package from scratch (title/scope).
- Add an optional “Attach estimate lines / cost codes” action later.

Recommended v1.1:
- “Create bid package from estimate” that groups estimate items by:
  - cost code, or
  - “trade” (if you introduce trade tagging on cost codes / estimate items)

### 4.3 Notifications / email (outbox)
Add outbox jobs:
- `send_bid_invite_email` (includes bid portal link)
- `send_bid_reminder_email` (scheduled reminders)
- `send_bid_addendum_email` (when addendum issued)

Use existing outbox processing pattern.

---

## 5) Migration Strategy (from “contacts as leads” → opportunities)

### 5.1 Phase 1: introduce opportunities without breaking pipeline
1) Create opportunities table + RLS.
2) Update `/pipeline` to read from opportunities.
3) Keep contacts metadata lead fields temporarily for backward compatibility and UI continuity.

### 5.2 Backfill initial opportunities
For each `contacts` row that is a client and looks like it’s in the pipeline:
- create one opportunity:
  - name: default to **last name** (e.g. “Smith Residence”), optionally suffixed with city if needed
  - status: derived from `contacts.metadata.lead_status` if present else `new`
  - jobsite_location from `contacts.metadata.jobsite_location`
  - owner_user_id from `contacts.metadata.lead_owner_user_id`

### 5.3 Cutover and cleanup (later)
- Stop writing lead pipeline fields into `contacts.metadata` except purely contact-related CRM notes.
- Make opportunity the only source of truth for pipeline status.
- Keep contacts metadata fields only if still needed for contact-only UX.

---

## 6) Phased Implementation Plan (LLM-Executable)

### Stage A — DB foundations (opportunities + bids)
Deliverables:
- Migrations for:
  - `opportunities`
  - `projects.opportunity_id` (or `opportunities.project_id`)
  - bid tables (`bid_packages`, `bid_invites`, `bid_access_tokens`, `bid_submissions`, `bid_awards`, `bid_addenda`, `bid_addendum_acknowledgements`)
  - RLS policies for new tables
- Update `docs/database-overview.md` (or add a new schema section) describing new tables.

Acceptance checks:
- Tables exist in Supabase, RLS enabled, basic policies in place.

### Stage B — Opportunities UX + services
Deliverables:
- `lib/services/opportunities.ts` (CRUD, status transitions, list by status, etc.)
- `app/(app)/pipeline` becomes opportunities pipeline (board/table)
- Opportunity detail: Start Estimating CTA

Acceptance checks:
- Can create multiple opportunities for one client contact.
- Can move opportunity through statuses.

### Stage C — Start Estimating creates/links precon project
Deliverables:
- A single service function: `startEstimating(opportunityId)`:
  - idempotent: if precon project exists, return it
  - else create project with status `planning` (precon shell) and link it
  - optionally create an initial estimate
- Update estimate creation to default to `project_id` from linked precon project.

Acceptance checks:
- One click from opportunity → lands in estimate creation with project set.
- New precon projects show in `/projects` with status `planning` (not active).

### Stage D — Internal bid management UI (project-scoped)
Deliverables:
- Add project nav item “Bids”
- Bid package list + package detail
- Invite creation (select from companies/project_vendors + email fallback)
- File attachments using `file_links` (package + addenda)
- When a bid package is first moved to `sent/open`, transition the project from `planning → bidding` (idempotent).

Acceptance checks:
- Can create package, invite a sub, attach drawings/specs, generate a portal link.

### Stage E — Public bid portal `/b/[token]`
Deliverables:
- Server-side token validation (hash with `BID_PORTAL_SECRET`)
- Portal pages to view scope/files/addenda and submit quote
- Writes submission and marks invite status accordingly
- Access tracking + expiry + optional PIN

Acceptance checks:
- Sub can open link, see only allowed files, submit quote, and builder sees it on package.
- Sub can revise a quote; builder sees version history and a single “current” submission.

### Stage F — Award → Commitment
Deliverables:
- Award action on submission:
  - writes `bid_awards` row
  - creates draft commitment (+ optional lines) and links it back to the award
  - updates bid package status to `awarded`
  - emits events/audit

Acceptance checks:
- Award produces a commitment visible under project financials/commitments.

### Stage G — Hardening for demo / production
Deliverables:
- Ensure proposal acceptance does **not** create “Proposal N” projects anymore once opportunities/precon are live:
  - proposal should always have `project_id` (or at least `opportunity_id` resolvable to a project)
- Add minimal addenda acknowledgement (already modeled).
- Review DB security lints and fix:
  - enable RLS on any public tables currently missing it (per Supabase advisor)
  - set immutable search_path on security-sensitive functions

Acceptance checks:
- No public link can enumerate anything outside its scope.
- Demo data looks like real builder workflow (no placeholder “Proposal 1” projects).

---

## 7) Decisions Locked In (as of 2026-02-01)
- Opportunity naming default: **Last name** (e.g. “Smith Residence”).
- Precon project lifecycle: create in **`planning`**, transition to **`bidding`** once bidding actually starts (package is sent/open).
- Bid portal: allow **revised quotes** (versioned submissions; one “current”).
- Bid Q&A: **out of v1** (keep scope small).
- Opportunity↔Project linkage: **`projects.opportunity_id`** (1:1 once set).
- Opportunity status type: **enum** (`opportunity_status`).
- Bid invite targeting: **`company_id` required**, `contact_id`/`invite_email` optional for delivery.

---

## 8) Success Criteria (SWFL luxury custom builder fit)
- Multiple opportunities per client works naturally.
- Precon jobs are first-class projects with correct status (not “active” too early).
- Bid portal supports the real workflow: drawings + addenda + quote upload + lead time notes.
- Award bridges into commitments so the feature isn’t “just intake”; it drives operations.
