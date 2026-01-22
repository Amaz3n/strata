# CRM / Pre-Construction Lead Management (MVP-First) Gameplan

> **Purpose**: Add a lightweight, construction-native pre-con CRM that prevents lead leakage and converts prospects into **estimates** (and then into **projects**) with minimal new surface area.
>
> **Target**: First 2–10 customers (custom home builders, remodelers), 1–20 employees.
>
> **Core outcome**: “We never forget to follow up” + “No double entry” from lead → estimate → proposal → contract → project.

---

## Progress Log (2026-01-16)
- Planning rewrite: MVP-first, aligned to current DB + navigation model
- **Phase 1 (MVP) COMPLETE**:
  - `/crm` dashboard with stats (follow-ups due, new inquiries, won/lost)
  - `/crm/prospects` list with filters (status, priority, owner, search)
  - Prospect detail sheet with activity timeline
  - Add prospect, set follow-up, record activity (note/call/meeting/site visit)
  - Change lead status with lost reason tracking
  - CRM fields stored in `contacts.metadata` (no schema migration needed)
  - Events recorded via existing `events` table
  - "Track in CRM" button added to contact detail sheet
  - "Create estimate" link from prospect (pre-fills recipient)
  - CRM added to global navigation
- **Phase 2 (Pipeline + Timeline) COMPLETE**:
  - `/crm/pipeline` kanban view grouped by lead status (new, contacted, qualified, estimating, won, lost)
  - Pipeline cards show: owner, next follow-up (with overdue/today indicators), last touched, has estimate badge
  - Move prospects between columns via dropdown menu (writes status change event)
  - Quick templates added to AddTouchDialog: Left voicemail, Phone call - no answer, Sent intake form, Sent follow-up email, Initial consultation, Site visit scheduled, Completed site visit, Discussed project scope
  - Light automation in `lib/services/estimates.ts`: When estimate is created for a prospect, auto-set `lead_status = 'estimating'` and record `crm_estimate_created` event
  - Pipeline links added to CRM dashboard and prospects table header
  - **Acceptance criteria met**:
    - ✅ Team can open `/crm/pipeline` and understand "where the work is" in <10 seconds
    - ✅ Moving a card updates `lead_status` and writes an event
    - ✅ Prospects show last touched + next follow-up clearly

---

## Executive Summary (Integration-first, MVP-first)

### Product thesis (the differentiator)
Strata wins for builders because it’s **one connected system** across the full lifecycle:

**inquiry → follow-up → estimate → proposal → contract → project execution → closeout**

No separate CRM subscription, no “pay for Procore + Salesforce + integrations”, no duplicate data entry.

**This gameplan optimizes for that**: small, high-leverage CRM features that reuse your existing core objects so the experience feels like *one app*, not two.

### The key decision: **CRM is pre-project**
Your app is currently organized around two modes:

- **Org-scoped (pre-project)**: Projects list, Estimates, Proposals, Directory, Compliance
- **Project-scoped**: Once a project is selected, the sidebar becomes project-specific (drawings/files/rfis/submittals/financials/etc.)

✅ CRM belongs in the **org-scoped** mode because leads exist *before* a project exists.

### MVP-first approach: reuse what you already have
Your DB already has:
- `contacts` and `companies` with a working Directory UI
- `contacts.contact_type` with strong app assumptions (e.g. `client`, `subcontractor`, `vendor`, etc.)
- `estimates.project_id` is nullable (pre-project estimates already supported)
- `events` table + `recordEvent()` service for activity feeds

So the MVP plan is:
- **Do not introduce separate `leads` and `opportunities` tables yet**
- Treat “leads/prospects” as **client contacts** (`contacts.contact_type = 'client'`) plus a small set of **lead fields in `contacts.metadata`** for status/ownership/follow-up
- Use `events` for “timeline / touches” instead of inventing new activity tables
- Conversion path uses existing objects: **Contact → Estimate → Proposal → Contract → Project**

---

## Integration contract (to avoid a “CRM island”)

CRM is not a standalone subsystem. It is a **lens over existing data**. These rules make the experience feel integrated:

### 1) Single source of truth
- **Prospect/person** = `contacts` (contact_type = `"client"`)
- **Work-in-progress commercial artifacts** = `estimates`, `proposals`, `contracts`
- **Activity trail** = `events`
- **Once selected/created** = `projects` becomes the project-scoped home

### 2) Bidirectional navigation
Every relevant screen should link both ways:
- From **CRM prospect** → open related estimate(s)/proposal(s)/project (when they exist)
- From **Estimate / Proposal / Contract** → open the related prospect (contact) “CRM context” (owner, next follow-up, last touch)

### 3) Minimal automatic synchronization (MVP-safe)
We keep automation tiny but meaningful, so CRM always reflects reality without heavy rules:
- **When an estimate is created from a prospect**:
  - set `lead_status = 'estimating'` (stored in `contacts.metadata`)
  - write an event: `crm_estimate_created` with `entity_type='contact'` and `entity_id=<contact_id>`
- **When a proposal is created/sent/accepted**:
  - write events: `crm_proposal_created`, `crm_proposal_sent`, `crm_proposal_accepted`
- **When a project is created/linked for that client**:
  - set `lead_status = 'won'`
  - write event: `crm_project_created`

These are “write once” hooks that keep everything connected. Avoid complex stage-rule engines until real usage demands it.

### 4) Shared UX primitives (so it feels like Strata)
Reuse existing patterns/components wherever possible:
- Contact sheets and directory search → become the entry point into CRM
- Activity feed patterns → CRM timeline uses `events`
- The “Create estimate” flow remains the same; CRM just pre-fills context

---

## Current DB / App Reality (what we must harmonize with)

### Contacts are already structured for CRM-lite
`contacts` includes:
- `contact_type` (validated in app; cannot casually add new values like `"lead"` without ripple)
- `crm_source` and `external_crm_id`
- `metadata` already stores app-level fields like:
  - `notes`
  - `preferred_contact_method`
  - `has_portal_access`
  - `archived_at` (used as a soft-delete/archive)

**Implication**: “Prospect” should be modeled as a `client` contact, not a new contact type.

#### Live DB shape (confirmed)
From the live Supabase schema:
- `contacts.full_name` is **NOT NULL**
- `contacts.org_id` is **NOT NULL**
- `contacts.email` and `contacts.phone` are **nullable**
- `contacts.contact_type` is **nullable at the DB level** (your app should continue to enforce allowed values)
- RLS is enforced via a broad policy: `contacts_access` = `(service_role OR is_org_member(org_id))`
  - this strongly supports keeping CRM **org-scoped** (pre-project) for access control

### Pre-project estimating is already supported
`estimates.project_id` is nullable and `estimates.recipient_contact_id` exists.

**Implication**: Converting a prospect to “estimating” should be literally “create an estimate for this contact”.

#### Live DB shape (confirmed)
- `estimates.project_id` is **nullable** (pre-project estimate supported)
- `estimates.recipient_contact_id` is **nullable** (CRM should set it, but not assume it exists historically)
- `estimates.title` is **NOT NULL**
- RLS exists as `estimates_access` = `(service_role OR is_org_member(org_id))`

### Activity logging already exists
You already have an `events` table and a `recordEvent()` service. For MVP, we can log lead “touches” (notes, calls, meetings) as events tied to the **contact** (entity_type = `"contact"`) instead of creating new CRM activity tables.

**Implication**: You can ship a useful “timeline” with near-zero new schema.

#### Live DB shape (confirmed)
- `events.event_type` is **NOT NULL**
- `events.entity_type` / `events.entity_id` are **nullable** (CRM must populate them consistently for timelines)
- RLS exists as `events_access` = `(service_role OR is_org_member(org_id))`

---

## Information Architecture (where CRM lives)

### Navigation principle
- CRM is **org-scoped** (pre-project), so it should appear alongside:
  - Projects
  - Estimates
  - Proposals
  - Directory
  - Compliance

### Recommended route structure (MVP)
Keep it simple and construction-native:

```
/crm
  - dashboard: “Follow-ups due”, “New inquiries”, “In estimating”
/crm/prospects
  - list view of client contacts with lead status + next action
/crm/pipeline
  - light kanban by lead status (optional in MVP)
```

**Why `/crm` vs `/leads`?** Because you’re not introducing a `leads` table in MVP; this is a workflow layer on top of existing `contacts`.

---

## Data Model (MVP: minimal schema changes)

### Source of truth
- **Person / homeowner / decision-maker**: `contacts` (contact_type = `"client"`)
- **Company (architect/designer/vendor/etc.)**: `companies`
- **Pre-project commercial artifact**: `estimates` (project_id nullable)
- **Activity / timeline**: `events`

### MVP “lead fields” stored in `contacts.metadata`
This avoids new tables, avoids contact type changes, and matches your existing pattern (`notes`, `preferred_contact_method`, etc.).

Suggested keys (all optional):
- `lead_status`: `"new" | "contacted" | "qualified" | "estimating" | "proposal" | "contract" | "won" | "lost"`
- `lead_priority`: `"low" | "normal" | "high" | "urgent"`
- `lead_owner_user_id`: `uuid` (as a string)
- `next_follow_up_at`: ISO timestamp string
- `last_contacted_at`: ISO timestamp string
- `lead_lost_reason`: string
- `lead_project_type`: `"new_construction" | "remodel" | "addition" | "other"`
- `lead_budget_range`: `"under_100k" | "100k_250k" | "250k_500k" | "500k_1m" | "over_1m" | "undecided"`
- `lead_timeline_preference`: `"asap" | "3_months" | "6_months" | "1_year" | "flexible"`
- `lead_tags`: string[]
- `jobsite_location`: json (or string; whatever matches how you model locations elsewhere)

**Lead source**:
- Use existing `contacts.crm_source` first (free-form text is fine for MVP).
- If you later need standardization/ROI: add a proper `lead_sources` table post-validation.

### Avoid duplicating company compliance data
Your live `companies` table already contains compliance/vendor-management fields (license, insurance, W-9, notes, etc.). Any CRM work should **reuse `companies`** and not introduce parallel “CRM company” tables/columns.

### Optional (post-MVP) performance hardening
If you see slow filtering at scale, add expression indexes on the most-used keys, e.g.:
- `contacts (org_id, contact_type)`
- expression indexes on `metadata->>'lead_status'` and `metadata->>'next_follow_up_at'`

---

## The MVP workflow (what the first customers actually need)

### The “one loop” to nail
1. Capture inquiry (phone/text/email/referral) into a **client contact**
2. Assign an owner + set a **next follow-up**
3. Record touches (note/call/site visit)
4. When ready: **create estimate** for the contact (no project required)
5. As the estimate/proposal/contract progresses, the CRM status updates (mostly manual in MVP)

---

## Phase 1 (MVP): Prospect tracking + follow-ups + estimate conversion (1–2 weeks)

### Goal
Ship the smallest set of CRM behaviors that a custom home builder will use daily:
- capture inquiry
- assign owner
- set next follow-up
- record a quick note
- convert to an estimate without creating a project

### What we build (MVP scope)
- **Org-scoped pages**
  - `/crm` dashboard: follow-ups due today/overdue + “new inquiries”
  - `/crm/prospects`: list view (filters + quick actions)
- **Prospect detail (sheet or page)**
  - show contact info (phone/email/address), notes
  - set/update: `lead_status`, `lead_priority`, `lead_owner_user_id`, `next_follow_up_at`
  - record “touch” events: note/call/meeting/site visit (stored in `events`)
  - CTA: **Create estimate** (pre-filled recipient_contact_id)
- **Entry points**
  - From Directory / Contact detail: “Track in CRM” / “Set follow-up”
  - From CRM list: “Add prospect” (creates a `contacts` record with `contact_type = 'client'`)

### Minimal lead statuses (start here)
Use a small set that maps to how builders talk:
- `new`
- `contacted`
- `qualified`
- `estimating`
- `won`
- `lost`

You can add `proposal` / `contract` later, but MVP should not depend on them.

### Acceptance criteria (MVP)
- ✅ A user can add a prospect in under 60 seconds (name + phone is enough).
- ✅ A user can assign an owner and set a next follow-up date/time.
- ✅ CRM dashboard shows “follow-ups due” reliably (sorted, overdue highlighted).
- ✅ A user can record a note/call and see it in a timeline (via `events`).
- ✅ A user can create an estimate from a prospect without creating a project.
- ✅ No duplication of contact data between CRM and Directory.

### Explicit non-goals (defer)
- No outbound email/SMS sending
- No nurture sequences
- No scoring
- No marketing ROI dashboards
- No “opportunity” object separate from contact

---

## Phase 2: Pipeline view + better timeline (optional, 1 week)

### Goal
Add visibility and speed for small teams without expanding scope into “full CRM platform” territory.

### What we build
- `/crm/pipeline`: simple kanban grouped by `lead_status`
  - move cards between columns (drag/drop optional; a menu action is fine)
  - show: owner, next follow-up, last touched, and “has estimate?”
- “Timeline improvements” on prospect detail:
  - structured touch types (note/call/meeting/site visit)
  - quick templates (“Left VM”, “Sent intake form”, “Booked site visit”)

### Light automation (safe + low support burden)
When the user creates an estimate from a prospect:
- set `lead_status = 'estimating'`
- record an event `crm_estimate_created`

Avoid rules like “if proposal sent then…” until you’ve observed real workflows.

### Acceptance criteria
- ✅ The team can open `/crm/pipeline` and understand “where the work is” in <10 seconds.
- ✅ Moving a card updates `lead_status` and writes an event.
- ✅ Prospects show last touched + next follow-up clearly.

---

## Phase 3: Normalize + attribution (post first customers, 1–2 weeks)

### Goal
Only after real usage data: reduce technical debt and enable reporting without breaking workflows.

### When to do this
Do Phase 3 only if:
- You need filtering/sorting that becomes expensive with metadata, or
- You need multi-contact deals, or
- You need standardized lead sources / ROI.

### What we build (option set)
- **Option A (still lightweight)**: add a few real columns to `contacts` for the high-value fields
  - `lead_status`, `next_follow_up_at`, `lead_owner_user_id` (org-scoped)
- **Option B (clean separation)**: introduce a dedicated `crm_prospects` table that references `contacts`
  - keeps Directory “contacts” clean
  - makes analytics easier
- Standardized lead sources (optional):
  - `lead_sources` table if you outgrow free-form `contacts.crm_source`

### Acceptance criteria
- ✅ Reporting queries are fast and stable.
- ✅ No data duplication (contact info remains in `contacts`).
- ✅ Migration path is clear (metadata → columns/table) with backfill.

---

## Phase 4: Communications automation (defer until you must)

### Why we defer
Email/SMS automation is a support and compliance magnet (deliverability, opt-in, “why didn’t it send?”).

### If/when you do it
- start with **internal reminders** first (in-app)
- then outbound email (simpler than SMS)
- SMS last, with explicit consent tracking and auditing

---

## Security & permissions (MVP)

### Guiding principle
Keep CRM access aligned with your existing org-scoped permission model.

Recommended starting point:
- Anyone with existing org access can view prospects
- Only users with “write” permissions (or equivalent) can edit lead fields / create estimates

(This can later become dedicated permission keys like `crm.read` / `crm.write`.)

---

## Testing strategy (MVP focus)
- **Workflow tests**
  - Add prospect → set follow-up → record note → create estimate
  - Filter prospects by status/owner/due follow-up
- **Edge cases**
  - Archived contacts don’t show in CRM
  - Contacts without phone/email still work
  - Multiple users editing ownership/follow-up safely

---

## Launch plan
- **Demo / first customers**: Phase 1 only
- **Beta expansion**: add Phase 2 if teams ask for “pipeline view”
- **Mature CRM**: only after real usage proves you need Phase 3/4

---

## Success metrics (early)
- **Operational**
  - % of prospects with a next follow-up set
  - average time from new inquiry → first touch
  - number of overdue follow-ups per week
- **Commercial**
  - prospects converted to estimates
  - estimates converted to projects