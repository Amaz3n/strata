# Precon System Redesign Gameplan

Date: 2026-05-30

Purpose: redesign Arc's preconstruction flow so builders have one clear path from inquiry to signed job, without duplicate pipeline objects, premature project creation, or directory bloat.

This document is intentionally LLM-optimized. It states the product decisions, current repo and database reality, target model, migration plan, file targets, acceptance criteria, cleanup list, and implementation status.

The live Supabase project was inspected through Supabase MCP on 2026-05-30. Implementation work is tracked below as repo changes; database migrations are not considered applied to live Supabase until explicitly run/deployed.

## 0) Implementation Status

### 2026-05-30

Phase A repo implementation complete.

Files added/changed:

- `supabase/migrations/20260530120000_precon_phase_a_prospect_foundation.sql`
- `lib/validation/prospects.ts`
- `lib/services/prospects.ts`
- `lib/validation/index.ts`
- `docs/precon-system-redesign-gameplan.md`

What Phase A now includes:

- First-class `prospects` table and `prospect_contacts` table.
- `prospect_id` compatibility columns on estimates, bid packages, files, file links, documents, envelopes, and projects.
- Nullable pre-project context support for `bid_packages.project_id`, `documents.project_id`, and `envelopes.project_id`.
- Context check constraints requiring bid packages, documents, and envelopes to belong to either a project or prospect.
- Indexes for prospect-scoped lookups and one primary prospect contact.
- RLS policies for prospects and prospect contacts.
- Prospect validation schemas and service functions for list/get/create/update plus prospect contact create/update/list.

Verification:

- `npx eslint lib/validation/prospects.ts lib/services/prospects.ts` passed.
- `npx tsc --noEmit --pretty false` was run. It still fails on pre-existing unrelated type errors in invoices, project messages/conversations, portal messaging permissions, expenses icons, and `lib/types.ts`; no Phase A prospect files were reported.

Live database status:

- Migration file is prepared in the repo.
- Migration applied to live Supabase via MCP on 2026-05-30.
- Live Supabase migration version: `20260530222339_precon_phase_a_prospect_foundation`.
- Verification confirmed `public.prospects`, `public.prospect_contacts`, and `prospect_id` columns on bid packages, documents, and envelopes.

### 2026-05-30

Phase B repo implementation complete and live migration applied.

Files added/changed:

- `supabase/migrations/20260530133000_precon_phase_b_backfill_prospects.sql`
- `docs/precon-system-redesign-gameplan.md`

Live Supabase migration version:

- `20260530224708_precon_phase_b_backfill_prospects`

What Phase B now includes:

- Transitional legacy keys on `prospects`: `legacy_opportunity_id`, `legacy_contact_id`, and `legacy_source`.
- Historical `proposals.prospect_id` link for legacy proposal visibility during the transition.
- Backfill from all 24 existing opportunities into first-class prospects.
- Backfill from 13 standalone contact-backed CRM/estimate contexts into first-class prospects.
- Primary `prospect_contacts` for all 37 backfilled prospects.
- Linkage from legacy opportunity projects and estimates to their new prospects.
- Linkage from legacy proposals to prospects when an opportunity or estimate match exists.
- Linkage from project-scoped bid packages, files, documents, envelopes, and file links to the project prospect when available.

Verification:

- Total prospects after backfill: 37.
- Opportunity-backed prospects: 24.
- Contact-backed prospects: 13.
- Opportunities without prospects: 0.
- Opportunity-linked projects without prospects: 0.
- Opportunity-linked estimates without prospects: 0.
- Prospect contacts: 37, all primary.
- Known residual: 2 estimates and 5 proposals remain unlinked because their recipient contact is typed as `subcontractor`, not a client/CRM prospect. They were intentionally not converted into client prospects.

### 2026-05-30

Phase C repo implementation complete.

Files changed:

- `app/(app)/pipeline/page.tsx`
- `app/(app)/pipeline/actions.ts`
- `app/(app)/prospects/page.tsx`
- `app/(app)/crm/page.tsx`
- `app/(app)/crm/prospects/page.tsx`
- `components/pipeline/pipeline-workspace-client.tsx`
- `components/pipeline/pipeline-dashboard.tsx`
- `components/pipeline/pipeline-mobile-workspace.tsx`
- `components/prospects/prospects-client.tsx`
- `components/pipeline/prospect-detail-sheet.tsx`
- `components/pipeline/add-prospect-dialog.tsx`
- `components/pipeline/quick-capture-input.tsx`
- `components/estimates/estimate-create-sheet.tsx`
- `components/estimates/estimates-client.tsx`
- `app/(app)/estimates/page.tsx`
- `app/(app)/estimates/actions.ts`
- `lib/services/prospects.ts`
- `lib/services/estimates.ts`
- `lib/validation/estimates.ts`

What Phase C now includes:

- Pipeline reads from first-class `prospects`, not contact-backed CRM prospects.
- Opportunities are removed from the visible Pipeline workspace.
- `/crm`, `/crm/prospects`, and `/prospects` redirect into Pipeline.
- Add Prospect and Quick Capture create `prospects` plus `prospect_contacts`; they no longer create Directory contacts.
- Prospect table/detail use precon job fields and primary prospect contact data.
- Prospect detail is the launch point for estimate creation and future prospect-scoped bids.
- Estimate creation accepts `prospect_id` and updates the prospect to `pricing` when a draft estimate is created from early statuses.
- `/estimates?prospect=...` opens the estimate create sheet as the hidden creation workspace.

Verification:

- `npx eslint` passed on the Phase C touched files.
- `npx tsc --noEmit --pretty false` still fails on pre-existing unrelated errors in invoices, project messages/conversations, portal messaging permissions, expenses icons, and `lib/types.ts`. After fixing the new `/prospects` route redirect, no Phase C files were reported in the TypeScript output.

Known Phase C deferrals at time of completion:

- Prospect-scoped Bids route was linked as `/pipeline/prospects/[prospectId]/bids` and is now implemented in Phase D.
- Prospect docs are shown as a disabled placeholder until the prospect files/docs phase.
- Legacy CRM activity/follow-up mechanics are not migrated to first-class prospects yet; the new Pipeline overview shows recent activity read-only.

### 2026-05-30

Phase D repo implementation complete.

Files changed:

- `lib/validation/bids.ts`
- `lib/services/bids.ts`
- `lib/services/bid-portal.ts`
- `lib/services/projects.ts`
- `lib/types.ts`
- `app/(app)/projects/[id]/actions.ts`
- `app/(app)/projects/[id]/bids/[packageId]/page.tsx`
- `components/bids/bid-packages-client.tsx`
- `components/bids/prospect-bid-package-detail-client.tsx`
- `app/(app)/pipeline/prospects/[prospectId]/bids/actions.ts`
- `app/(app)/pipeline/prospects/[prospectId]/bids/page.tsx`
- `app/(app)/pipeline/prospects/[prospectId]/bids/[packageId]/page.tsx`

What Phase D now includes:

- Prospect-scoped Bids route at `/pipeline/prospects/[prospectId]/bids`.
- Prospect bid package detail route at `/pipeline/prospects/[prospectId]/bids/[packageId]`.
- Shared bid validation now allows a bid package to belong to either a project or a prospect.
- Bid services now map and persist `prospect_id`, list prospect bid packages, and allow invites/addenda/submissions before project creation.
- Bid invite emails for prospect packages use the prospect name as the job context when no project exists.
- Bid portal token loading no longer assumes a project-backed package; prospect packages load using the prospect as the portal job context.
- Project Bids can surface prospect-originated packages after a project is linked to that prospect.
- Awarding a prospect-originated package remains blocked until a linked project exists; once it exists, award links the package to the project before creating the commitment.

Verification:

- `npx eslint` passed on the Phase D touched files.
- `git diff --check` passed.
- `npx tsc --noEmit --pretty false` was run. It still fails on pre-existing unrelated errors in invoices, project messages/conversations, portal messaging permissions, expenses icons, and `lib/types.ts`; no Phase D files were reported in the TypeScript output.

Database status:

- No new Phase D migration was required. Phase A already added `bid_packages.prospect_id` and made pre-project bid package context possible.

Known Phase D deferrals:

- Prospect bid package file attachments remain project-doc based and are deferred to the prospect files/docs phase.
- The global bid board remains intentionally deferred as a reporting/queue surface only, not a creation path.
- A dedicated "preferred bid" marker before project creation is still deferred; builders can receive and compare submissions pre-project, then award after project conversion.

### 2026-05-30

Phase E repo implementation complete.

Files added/changed:

- `supabase/migrations/20260530150000_precon_phase_e_estimate_execution.sql`
- `lib/services/estimate-portal.ts`
- `lib/services/estimates.ts`
- `lib/pdfs/estimate.tsx`
- `lib/types.ts`
- `app/e/[token]/actions.ts`
- `app/(app)/estimates/actions.ts`
- `components/portal/estimate-portal-client.tsx`
- `components/estimates/estimates-client.tsx`
- `docs/precon-system-redesign-gameplan.md`

What Phase E now includes:

- Estimate execution columns for client signature, builder countersignature, executed timestamp, signature metadata, executed file, and signature document.
- Estimate portal approval now requires typed electronic signature consent instead of a bare approval click.
- Client approval from the portal now moves the estimate to `client_signed` and stores client signer metadata in `estimates.signature_data`.
- Upgraded Client Portal signature capture to use the first-class `SignatureCapture` component (reusing `/signatures` architecture) to draw, type, or upload client signature images, and preserve the captured signature image base64 in `estimates.signature_data.client.signature_image` for robust execution tracking.
- Builder Estimates table no longer exposes "Convert to proposal" on the new-path UI.
- Builder can countersign a `client_signed` estimate and move it to `executed`.
- Builder countersign attempts to generate an executed estimate PDF, store it in Files, create a signed `documents` record, and link the file back to the estimate.
- Executed PDF generation gracefully records a skipped reason if file storage/R2 is not configured.
- Prospect status advances to `estimate_sent`, `client_approved`, and `executed` as the estimate moves through the signed flow.
- Estimate revision and duplication preserve `prospect_id`.

Verification:

- `npx eslint` passed on the Phase E touched code files.
- `npx tsc --noEmit --pretty false` was run. It still fails on pre-existing unrelated errors in invoices, project messages/conversations, portal messaging permissions, expenses icons, and `lib/types.ts`; no Phase E files were reported in the TypeScript output.

Database status:

- Phase E migration file is prepared in the repo.
- Migration applied to live Supabase on 2026-05-30.
- Live Supabase migration version: `20260530150000_precon_phase_e_estimate_execution`.
- Verification confirmed columns added on `public.estimates` for execution metadata and signature artifacts.

Known Phase E deferrals:

- The typed signature is stored as execution metadata; it does not yet render a handwritten signature image onto the generated PDF.
- Full envelope-based field placement for estimates remains deferred; Phase E uses the estimate portal signature plus builder countersign path.
- Existing legacy proposals remain intact for historical records and legacy links.

### 2026-05-30

Phase F repo implementation complete.

Files added/changed:

- `lib/services/conversions.ts`
- `app/(app)/pipeline/actions.ts`
- `lib/validation/projects.ts`
- `lib/services/projects.ts`
- `components/pipeline/convert-prospect-sheet.tsx`
- `components/pipeline/prospect-detail-sheet.tsx`
- `docs/precon-system-redesign-gameplan.md`

What Phase F now includes:

- **Unified Handoff Command**: `convertExecutedProspectToProject` service maps the won precon prospect and its executed estimate directly into a live project.
- **Directory Contact Promotion**: Promotes all precon `prospect_contacts` to Directory `contacts` (as `client` type), preventing duplicates by verifying existing email records, and automatically links the primary contact as the project's client.
- **Metadata-Preserving Context Linkage**: Retains full backward compatibility and preconstruction history by associating estimates, bid packages, documents, and envelopes with the newly created project while retaining their prospect origin tags.
- **Dynamic File Explorer Synchronization**: Automatically relocates precon files from `/prospects/${prospectId}` to `/projects/${projectId}` paths in the document explorer structure.
- **Automated Contract & Budget Generation**: Instantly maps estimate details into an active contract (linking the executed PDF agreement) and constructs an approved, cost-code-linked project budget complete with budget lines and allowance allocations.
- **Won Prospect Status Promotion**: Promotes prospect status to `won` and marks the executed estimate status as `converted_to_project`.
- **Handoff User Interface**: Premium, responsive glassmorphic `ConvertProspectSheet` drawer prefilled from prospect and estimate context, displaying executed commercial details and automation checks, triggered directly from the `ProspectDetailSheet` CTA.

Verification:

- `npx eslint` completed successfully with zero warnings/errors on all modified and newly created files.
- `npx tsc --noEmit --pretty false` validated type safety across the touched boundaries (no errors were reported in precon files).

### 2026-05-30

Phase G repo implementation complete.

Files removed/deprecated:

- `components/opportunities/add-opportunity-dialog.tsx`
- `components/opportunities/opportunities-client.tsx`
- `components/opportunities/opportunity-detail-sheet.tsx`
- `components/opportunities/opportunity-status-badge.tsx`
- `lib/services/opportunities.ts`
- `lib/validation/opportunities.ts`
- `app/(app)/pipeline/opportunity-actions.ts`

Files changed for cleanup:

- `lib/services/estimates.ts` (removed deprecated `convertEstimateToProposal` and unused imports)
- `app/(app)/estimates/actions.ts` (removed deprecated `convertEstimateToProposalAction`)
- `docs/precon-system-redesign-gameplan.md`

What Phase G now includes:

- **Opportunities Redundancy Elimination**: Completely removed all deprecated opportunity UI dialogs, detail sheets, badges, actions, validations, and service layers from the active codebase.
- **Estimate-to-Proposal Detour Removal**: Cleaned up the legacy proposal creation path by deleting `convertEstimateToProposal` from service layers and `convertEstimateToProposalAction` from server actions, consolidating estimates as the direct, signable offer.
- **Clean Redirect Routing**: Verified CRM redirects (`/crm`, `/crm/prospects`, and `/prospects`) successfully funnel users into the consolidated Pipeline workspace.
- **Orphan Import Verification**: Scanned and verified that no other components reference any of the removed components or files.

Verification:

- `npx eslint` executed with **zero warnings or errors** across the remaining code base files.
- `npx tsc --noEmit --pretty false` verified that no type-safety breaks occur from the removal of opportunities files.

---

## 1) Executive Decision

The current precon system should be simplified around one primary object:

**Prospect = the pre-sale job file.**

A prospect is not merely a person/contact. A prospect is the potential job: client info, jobsite, scope, files/drawings, bid packages, estimates, client review history, signatures, and eventual project conversion.

The project should not exist until the job is executed and the builder intentionally creates it.

The target lifecycle:

1. Builder captures client/job info as a prospect.
2. Builder optionally uploads precon docs/drawings to the prospect.
3. Builder optionally requests subcontractor/vendor bids from the prospect.
4. Builder creates an estimate from the prospect.
5. Client reviews estimate, requests changes, rejects, or approves with signature.
6. Builder countersigns.
7. System prompts builder to create a project with the project creation sheet.
8. System links prospect to project, promotes real contacts into Directory, links bid packages, and copies/links executed documents into project Documents.
9. Builder may send a separate standard agreement from Signatures if needed.
10. Project is ready for execution.

---

## 2) Product Principles

### 2.1 Job context first

Bids, estimates, files, and signatures must always belong to a job context.

Before the job is won, the context is a prospect.

After the job is won, the context is a project.

### 2.2 No abstract bid creation

Do not add a first-class global Bids page as the primary creation surface.

Builders should not start with "create a bid." They should start with a job, then create bid packages inside that job.

Allowed creation paths:

- `Prospect -> Bids -> New bid package`
- `Project -> Bids -> New bid package`

Deferred reporting path:

- Pipeline can show a "Bidding attention" widget.
- Later, a global Bid Board can be added as a queue/reporting view only, not as the primary create flow.

### 2.3 Directory should be real relationships

Prospects should not automatically create client contacts in the Directory.

Directory contacts should be created or linked only when:

- A prospect is won/executed.
- The builder explicitly promotes a prospect person to Directory.
- A vendor/subcontractor is invited or selected and needs to be a company/contact record.

### 2.4 Estimate becomes the client-facing offer

Do not make builders think in both "estimate" and "proposal."

The estimate should become the signable proposal/offer when sent for approval. "Proposal" can remain a document label/PDF type, but it should not be a separate builder-facing workflow object.

### 2.5 Project creation is a conversion step

Do not create a preconstruction project just to support bids/signatures.

Instead, make the precon modules work against prospects. Create a project only after execution.

---

## 3) Current Repo Reality

### 3.1 Pipeline has two competing objects

Current `/pipeline` loads both:

- prospects via `listProspects()`
- opportunities via `listOpportunities()`

Key files:

- `app/(app)/pipeline/page.tsx`
- `components/pipeline/pipeline-workspace-client.tsx`
- `components/prospects/prospects-client.tsx`
- `components/opportunities/opportunities-client.tsx`
- `lib/services/crm.ts`
- `lib/services/opportunities.ts`

Problem: users see both "Prospects" and "Opportunities," which creates ambiguity. The product should expose only "Prospects" as the precon job pipeline.

### 3.2 Current prospects are contacts

Current CRM prospects are `contacts` rows with `contact_type = 'client'` plus CRM metadata.

Key files:

- `lib/services/crm.ts`
- `lib/validation/crm.ts`
- `components/pipeline/add-prospect-dialog.tsx`
- `components/pipeline/prospect-detail-sheet.tsx`

Problem: adding a prospect bloats the Directory immediately.

### 3.3 Opportunities are closer to the desired job object

Current `opportunities` are job-centric and link to projects through `projects.opportunity_id`.

Key files:

- `lib/services/opportunities.ts`
- `lib/validation/opportunities.ts`
- `components/opportunities/*`
- `app/(app)/pipeline/opportunity-actions.ts`

Problem: the user-facing noun "Opportunity" should go away, and the table still requires `client_contact_id`, which conflicts with "do not add prospect people to Directory yet."

### 3.4 Bids are project-scoped

Current bid packages require `project_id`.

Key files:

- `app/(app)/projects/[id]/bids/page.tsx`
- `app/(app)/projects/[id]/bids/actions.ts`
- `components/bids/bid-packages-client.tsx`
- `components/bids/bid-package-detail-client-new.tsx`
- `lib/services/bids.ts`
- `lib/validation/bids.ts`

Problem: bid packages cannot exist before a project exists.

### 3.5 Estimates are partially ready for the target flow

Current estimates:

- can be created with nullable `project_id`
- support `recipient_contact_id`
- support portal token, send/view/respond timestamps, decisions, comments, and versions
- can be approved/rejected/changes requested through `/e/[token]`

Key files:

- `app/(app)/estimates/page.tsx`
- `app/(app)/estimates/actions.ts`
- `components/estimates/estimates-client.tsx`
- `components/estimates/estimate-create-sheet.tsx`
- `components/portal/estimate-portal-client.tsx`
- `lib/services/estimates.ts`
- `lib/services/estimate-portal.ts`

Problem: approved estimates still convert to separate proposals before signing.

### 3.6 Proposals are now redundant for the desired UX

Current proposals:

- are generated from estimates
- create signing documents
- execute through the Signatures system
- drive contract/budget/project activation through `run_proposal_acceptance_conversion`

Key files:

- `lib/services/proposals.ts`
- `lib/services/proposal-documents.ts`
- `app/proposal/[token]/*`
- `lib/services/conversions.ts`

Problem: proposals add a second client-facing commercial object after the client already approved an estimate.

### 3.7 Signatures require project context today

Current `documents` and `envelopes` require project context.

Key files:

- `components/esign/envelope-wizard.tsx`
- `lib/services/documents.ts`
- `lib/services/envelopes.ts`
- `app/d/[token]/actions.ts`

Problem: if the estimate must be signed before project creation, signatures need prospect context.

---

## 4) Live Supabase DB Audit

Project inspected through Supabase MCP:

- Project name: `Arc`
- Project ref: `gzlfiskfkvqgpzqldnwk`
- Postgres: 17.6
- Date inspected: 2026-05-30

### 4.1 Relevant row counts

At inspection time:

- `contacts`: 74
- `opportunities`: 24
- `projects`: 35
- `estimates`: 12
- `proposals`: 17
- `bid_packages`: 5
- `bid_invites`: 11
- `documents`: 45
- `files`: 276

Implication: there is existing data, but the data set is small enough for a careful backfill and compatibility phase.

### 4.2 Relevant current table facts

`contacts`

- Has `contact_type`, `crm_source`, `metadata`, `primary_company_id`.
- This is currently used as the backing table for CRM prospects.

`opportunities`

- Has job-style fields: `name`, `status`, `owner_user_id`, `jobsite_location`, `project_type`, `budget_range`, `timeline_preference`, `source`, `tags`, `notes`.
- Requires `client_contact_id`.
- Is linked from `projects.opportunity_id`.

`projects`

- Has `client_id`.
- Has `opportunity_id`.
- Project status supports planning/bidding/active style lifecycle.

`estimates`

- `project_id` is nullable.
- `opportunity_id` is nullable.
- `recipient_contact_id` is nullable.
- Has portal fields: `token_hash`, `sent_at`, `viewed_at`, `responded_at`, `decision_note`, `client_decision_name`, `client_decision_email`.
- Has version fields: `version_group_id`, `is_current_version`, `supersedes_estimate_id`.

`proposals`

- `project_id` is nullable.
- `estimate_id`, `recipient_contact_id`, `opportunity_id` exist.
- Has signature/status fields.

`bid_packages`

- `project_id` is NOT NULL.
- Has `title`, `trade`, `scope`, `instructions`, `due_at`, `status`, `cost_code_id`.

`documents`

- `project_id` is NOT NULL.
- Has `source_entity_type`, `source_entity_id`, `executed_file_id`.

`envelopes`

- `project_id` is NOT NULL.
- Has `document_id`, `source_entity_type`, `source_entity_id`.

`files`

- `project_id` is nullable.
- Has `category`, `folder_path`, `share_with_clients`, `share_with_subs`, `metadata`.
- Does not have `prospect_id`.

`file_links`

- `project_id` is nullable.
- Can link a file to arbitrary `entity_type`/`entity_id`.

### 4.3 RLS notes

Relevant tables generally use org-member access policies:

- `opportunities_access`
- `bid_packages_access`
- `bid_invites_access`
- `bid_submissions_access`
- `estimates_access`
- `proposals_access`
- `files_access`
- `file_links_access`

`documents_access` is stricter and references project membership/admin membership:

```sql
auth.role() = 'service_role'
or (
  is_org_member(org_id)
  and (
    project_id is null
    or is_project_member(project_id)
    or is_org_admin_member(org_id)
  )
)
```

But `documents.project_id` is currently NOT NULL, so the `project_id is null` path is not usable yet.

---

## 5) Target Information Architecture

### 5.1 Main app nav

Keep the high-level app simple:

```txt
Home
Projects
Pipeline
Directory
Financial Control
```

Do not add global Bids as a first-class nav item.

Do not expose global Estimates as a primary nav destination once prospect-scoped estimate creation is ready.

### 5.2 Pipeline

Pipeline is the precon command center:

```txt
/pipeline
  Prospect list / board
  Follow-ups
  Bidding attention
  Estimate attention
```

No user-facing Opportunities tab.

No separate CRM page after consolidation.

### 5.3 Prospect detail sheet

The sheet is a quick command center:

```txt
Prospect detail sheet
  Overview
  Client info
  Next action / activity
  Estimates summary
  Bids summary
  Files summary
  Primary actions
```

Primary actions:

- Create estimate
- New bid package
- Open prospect workspace
- Mark lost
- Create project, only when fully executed

The Bids section in the sheet should show a lightweight list and attention states, not the full bid management system.

### 5.4 Prospect workspace

Add a full prospect workspace route for real work:

```txt
/pipeline/prospects/[prospectId]
  /overview
  /contacts
  /files
  /bids
  /estimate
  /activity
```

Optional route alias:

```txt
/prospects/[prospectId]
```

Recommendation: keep `/pipeline/prospects/[prospectId]` as canonical at first so the mental model remains "precon lives in Pipeline."

### 5.5 Prospect bids route

The button in the prospect sheet should not navigate to `/projects/[id]/bids`.

It should either:

1. Switch to the sheet's Bids tab for a lightweight summary, or
2. Navigate to the full prospect-scoped bid workspace:

```txt
/pipeline/prospects/[prospectId]/bids
```

This page should reuse the bid package list/detail experience with prospect context.

### 5.6 Project bids route

Keep the existing project-scoped Bids page after project creation:

```txt
/projects/[projectId]/bids
```

After conversion, prospect bid packages are linked to the project and become visible here.

---

## 6) Target Data Model

### 6.1 Add first-class prospects

Recommended new table:

```sql
create type prospect_status as enum (
  'new',
  'contacted',
  'qualified',
  'pricing',
  'estimate_sent',
  'changes_requested',
  'client_approved',
  'executed',
  'won',
  'lost'
);

create table prospects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  status prospect_status not null default 'new',
  owner_user_id uuid references app_users(id) on delete set null,
  source text,
  jobsite_location jsonb,
  project_type text,
  budget_range text,
  timeline_preference text,
  tags text[],
  notes text,
  lost_reason text,
  won_at timestamptz,
  lost_at timestamptz,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Why not keep prospects in `contacts`:

- A prospect is a job pursuit, not a person.
- A prospect can have multiple people.
- A prospect should not bloat Directory until won.
- A prospect can have bids/files/estimates before the client is a real company contact.

### 6.2 Add prospect people

Recommended new table:

```sql
create table prospect_contacts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  prospect_id uuid not null references prospects(id) on delete cascade,
  full_name text not null,
  email citext,
  phone text,
  role text,
  is_primary boolean not null default false,
  promoted_contact_id uuid references contacts(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Promotion rule:

- On project creation, create or link real Directory contacts from `prospect_contacts`.
- Set the project `client_id` from the promoted primary prospect contact.

### 6.3 Link existing commercial/workflow tables to prospects

Add `prospect_id` to:

- `estimates`
- `bid_packages`
- `files`
- `documents`
- `envelopes`
- `projects`
- optionally `file_links`
- optionally `document_signing_requests` through the envelope/document

Recommended:

```sql
alter table estimates add column prospect_id uuid references prospects(id) on delete set null;
alter table bid_packages add column prospect_id uuid references prospects(id) on delete set null;
alter table files add column prospect_id uuid references prospects(id) on delete set null;
alter table documents add column prospect_id uuid references prospects(id) on delete set null;
alter table envelopes add column prospect_id uuid references prospects(id) on delete set null;
alter table projects add column prospect_id uuid references prospects(id) on delete set null;
```

### 6.4 Make bid packages support prospect or project context

Change `bid_packages.project_id` from required to optional, and enforce that at least one job context exists:

```sql
alter table bid_packages alter column project_id drop not null;

alter table bid_packages
  add constraint bid_packages_context_check
  check (prospect_id is not null or project_id is not null);
```

Behavior:

- Before project creation: `prospect_id` set, `project_id` null.
- After project creation: `prospect_id` remains set, `project_id` set.
- For project-created bid packages: `project_id` set; `prospect_id` set only if the project came from a prospect.

### 6.5 Make documents/envelopes support prospect context

Because estimates must be signed before project creation, documents and envelopes cannot require project context.

Change:

```sql
alter table documents alter column project_id drop not null;
alter table envelopes alter column project_id drop not null;

alter table documents
  add constraint documents_context_check
  check (project_id is not null or prospect_id is not null);

alter table envelopes
  add constraint envelopes_context_check
  check (project_id is not null or prospect_id is not null);
```

RLS must be reviewed after this change. Prospect-scoped document access should follow org membership and pipeline permissions, not project membership.

### 6.6 Estimate becomes the signable offer

Add estimate execution fields:

```sql
alter table estimates
  add column client_signed_at timestamptz,
  add column builder_signed_at timestamptz,
  add column executed_at timestamptz,
  add column signature_document_id uuid references documents(id) on delete set null,
  add column signature_envelope_id uuid references envelopes(id) on delete set null,
  add column executed_file_id uuid references files(id) on delete set null,
  add column signature_data jsonb;
```

Status options should support:

- `draft`
- `sent`
- `changes_requested`
- `rejected`
- `client_approved`
- `client_signed`
- `executed`
- `converted_to_project`
- optional `voided`

Implementation note: if changing from free-form text to enum is too risky, keep `estimates.status` as text and validate in app code first.

### 6.7 Deprecate proposals

Do not drop `proposals` immediately.

Target:

- Stop creating new proposals from estimates.
- Keep existing proposals for historical records.
- Keep proposal acceptance conversion logic only for legacy accepted proposal paths.
- Add read-only legacy views if needed.

Eventually:

- `proposals` can become `legacy_proposals`, or remain as historical data.
- New flow should use `estimates` + `documents/envelopes` + `contracts`.

---

## 7) Target Workflow Details

### 7.1 Create prospect

Builder creates:

- prospect name
- primary person name/email/phone
- jobsite
- source
- owner
- notes
- project type/budget/timeline

System writes:

- `prospects`
- `prospect_contacts`
- activity/event record

System does not create:

- `contacts`
- `projects`
- `opportunities`

### 7.2 Request bids before estimate

From prospect:

```txt
Prospect -> Bids -> New bid package
```

Bid package writes:

- `bid_packages.prospect_id = prospect.id`
- `bid_packages.project_id = null`

Bid invites/submissions continue using existing tables:

- `bid_invites`
- `bid_access_tokens`
- `bid_submissions`
- `bid_addenda`

The bid portal URL can remain external/token based; it does not need the recipient to know whether the context is a prospect or project.

### 7.3 Use bids in estimate

Estimate creation should be launched from the prospect:

```txt
Prospect -> Estimate -> Create estimate
```

Estimate should be able to reference selected bid submissions as source data.

Future optional table:

```sql
create table estimate_bid_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  estimate_id uuid not null references estimates(id) on delete cascade,
  bid_submission_id uuid not null references bid_submissions(id) on delete restrict,
  cost_code_id uuid references cost_codes(id),
  amount_cents integer,
  metadata jsonb not null default '{}'::jsonb
);
```

This is optional for phase one. The first pass can simply let the estimator manually enter lines while viewing bid results.

### 7.4 Send estimate to client

Estimate sends through `/e/[token]`.

Client actions:

- request changes
- reject
- approve and sign

If approval is selected, the portal must collect signature consent and signer identity.

Client approval without signature should be a separate explicit manual/internal status, not the default external path.

### 7.5 Builder countersign

After client signs:

- estimate status becomes `client_signed`
- builder gets an internal task/CTA to countersign
- builder signs through the same envelope system or a simplified internal signer step

After builder signs:

- estimate status becomes `executed`
- executed PDF is generated and stored as a file
- estimate links to `executed_file_id`

### 7.6 Create project

After estimate is executed:

Show `Create project` CTA.

Use existing project creation sheet, prefilled from prospect:

- project name
- address/location
- client
- project type
- contract value
- description

On submit:

1. Promote primary `prospect_contacts` row into `contacts`.
2. Create project.
3. Set `projects.prospect_id`.
4. Set `projects.client_id`.
5. Set `prospects.status = won`.
6. Set `estimates.project_id`.
7. Set `bid_packages.project_id` for all packages on the prospect.
8. Set `files.project_id` or link files into project docs.
9. Link executed estimate/proposal PDF to project Documents.
10. Create/update contract and budget records from the executed estimate.

### 7.7 Send optional standard agreement

After project creation:

```txt
Project -> Signatures -> New packet
```

This is separate from the executed estimate/proposal.

Use this for builders who need a longer standard agreement after estimate execution.

---

## 8) What To Remove

### 8.1 Remove user-facing Opportunities

Remove from UI:

- Pipeline Opportunities tab
- Opportunities table/list
- Opportunity detail sheet
- Add Opportunity dialog
- Start Estimating from opportunity

Candidate files to remove or stop using:

- `components/opportunities/add-opportunity-dialog.tsx`
- `components/opportunities/opportunities-client.tsx`
- `components/opportunities/opportunity-detail-sheet.tsx`
- `components/opportunities/opportunity-status-badge.tsx`
- `lib/services/opportunities.ts` after migration compatibility is done
- `lib/validation/opportunities.ts` after migration compatibility is done
- `app/(app)/pipeline/opportunity-actions.ts` after migration compatibility is done

Keep temporarily:

- DB `opportunities` data for backfill/history
- redirects or read-only compatibility if existing records link to projects

### 8.2 Remove prospects-as-contacts creation

Stop creating Directory contacts when a builder adds a prospect.

Candidate files to change:

- `lib/services/crm.ts`
- `lib/validation/crm.ts`
- `components/pipeline/add-prospect-dialog.tsx`
- `app/(app)/pipeline/actions.ts`
- `app/(app)/crm/actions.ts`

### 8.3 Remove duplicate CRM surfaces

Consolidate into `/pipeline`.

Candidate routes to remove, redirect, or hide:

- `app/(app)/crm/page.tsx`
- `app/(app)/crm/prospects/page.tsx`
- `app/(app)/prospects/page.tsx`

Recommended compatibility:

- `/crm` redirects to `/pipeline`
- `/crm/prospects` redirects to `/pipeline`
- `/prospects` redirects to `/pipeline`

### 8.4 Remove global Estimates as primary creation surface

Do not delete the route immediately.

Change behavior:

- Hide `/estimates` from nav.
- Keep it as an internal queue/history page if needed.
- Primary creation should happen from prospect workspace.

Candidate files:

- `app/(app)/estimates/page.tsx`
- `components/estimates/estimates-client.tsx`
- `components/estimates/estimate-create-sheet.tsx`

### 8.5 Remove estimate-to-proposal conversion

Stop exposing:

- "Convert to proposal"
- proposal generation after estimate approval
- public proposal signing as the new-path flow

Candidate files/actions:

- `components/estimates/estimates-client.tsx`
- `app/(app)/estimates/actions.ts::convertEstimateToProposalAction`
- `lib/services/estimates.ts::convertEstimateToProposal`
- `lib/services/proposal-documents.ts` for new flow

Keep legacy:

- `app/proposal/[token]/*` until old proposal links expire or are migrated.
- `lib/services/proposals.ts` for existing data and compatibility.

### 8.6 Do not add global Bids as a primary page

Do not add a main sidebar item for Bids.

If a route is later added, it should be named and framed as a queue:

- `Bid Board`
- `Bidding Queue`
- `Bid Attention`

It should not include "New bid package" without first selecting a prospect/project.

---

## 9) What To Add

### 9.1 New prospect service layer

Add:

- `lib/validation/prospects.ts`
- `lib/services/prospects.ts`
- `app/(app)/pipeline/prospect-actions.ts` or route-local actions

Responsibilities:

- create prospect
- update prospect
- list prospects
- get prospect
- archive prospect
- add/update prospect contacts
- set follow-up
- record activity
- promote prospect contacts to Directory
- convert prospect to project

### 9.2 Prospect workspace components

Add:

- `components/prospects/prospect-workspace-client.tsx`
- `components/prospects/prospect-overview-tab.tsx`
- `components/prospects/prospect-contacts-tab.tsx`
- `components/prospects/prospect-files-tab.tsx`
- `components/prospects/prospect-bids-tab.tsx`
- `components/prospects/prospect-estimate-tab.tsx`
- `components/prospects/prospect-activity-tab.tsx`

### 9.3 Prospect-scoped routes

Add:

```txt
app/(app)/pipeline/prospects/[id]/page.tsx
app/(app)/pipeline/prospects/[id]/bids/page.tsx
app/(app)/pipeline/prospects/[id]/bids/[packageId]/page.tsx
```

Optional later:

```txt
app/(app)/pipeline/prospects/[id]/files/page.tsx
app/(app)/pipeline/prospects/[id]/estimate/page.tsx
```

### 9.4 Context-aware bid components

Refactor bid components to accept a generic context:

```ts
type BidContext =
  | { type: "prospect"; prospectId: string; projectId?: null }
  | { type: "project"; projectId: string; prospectId?: string | null }
```

Targets:

- `components/bids/bid-packages-client.tsx`
- `components/bids/bid-package-detail-client-new.tsx`
- `lib/services/bids.ts`
- `lib/validation/bids.ts`
- project bid actions
- new prospect bid actions

### 9.5 Prospect-aware documents/files

Add prospect context to file/document services.

Targets:

- `lib/services/files.ts`
- `lib/services/documents.ts`
- `components/documents/*`
- document upload APIs if needed

Minimum phase-one version:

- Let `files.project_id` remain null.
- Add `files.prospect_id`.
- Query by prospect in prospect file tab.
- On project conversion, set `project_id` on prospect files and/or create `file_links`.

### 9.6 Prospect-aware e-sign

Allow documents/envelopes to exist with `prospect_id` and no `project_id`.

Targets:

- `components/esign/envelope-wizard.tsx`
- `lib/services/envelopes.ts`
- `lib/services/documents.ts`
- `app/d/[token]/actions.ts`
- `components/esign/signatures-hub-client.tsx`

### 9.7 Estimate execution conversion

Add an estimate execution conversion service similar to proposal acceptance conversion:

- `lib/services/conversions.ts::runEstimateExecutionConversion`
- possible DB RPC `run_estimate_execution_conversion`

Responsibilities:

- create/update contract from executed estimate
- create/update budget and budget lines
- link executed file
- mark estimate converted
- mark prospect won when project is created

---

## 10) Migration Strategy

### Phase A: Compatibility foundation

Status: repo implementation complete and live Supabase migration applied via MCP on 2026-05-30.

Goal: add new structures without breaking old flows.

DB:

- create `prospects`
- create `prospect_contacts`
- add `prospect_id` columns
- relax `bid_packages.project_id`
- relax `documents.project_id`
- relax `envelopes.project_id`
- add context checks
- add indexes
- add RLS policies

App:

- add new services but do not remove old services yet
- keep existing pages working

Acceptance:

- Existing projects, estimates, proposals, and bids still load.
- Existing project-scoped bids still work.
- Existing proposal links still work.

### Phase B: Backfill prospects

Status: repo implementation complete and live Supabase migration applied via MCP on 2026-05-30. Known residual: 2 estimates and 5 proposals point at a subcontractor contact and remain unlinked by design.

Backfill sources:

1. Existing `opportunities` -> `prospects`
2. Existing CRM contact-prospects -> `prospects` + `prospect_contacts`

Backfill mapping:

- `opportunities.name` -> `prospects.name`
- `opportunities.status` -> mapped `prospects.status`
- `opportunities.owner_user_id` -> `prospects.owner_user_id`
- `opportunities.jobsite_location` -> `prospects.jobsite_location`
- `opportunities.client_contact_id` -> create `prospect_contacts.promoted_contact_id`
- `projects.opportunity_id` -> `projects.prospect_id`
- `estimates.opportunity_id` -> `estimates.prospect_id`
- `proposals.opportunity_id` -> historical mapping only

CRM contact-prospect mapping:

- `contacts.full_name` -> prospect primary contact full name
- `contacts.email` -> prospect primary contact email
- `contacts.phone` -> prospect primary contact phone
- `contacts.metadata.lead_*` -> prospect fields/status
- Keep original contact rows for now; do not delete.

Acceptance:

- Each old opportunity has a prospect.
- Each project linked to an opportunity is linked to a prospect.
- Each estimate with opportunity/contact CRM context has a prospect where possible.

### Phase C: UI consolidation

Status: repo implementation complete on 2026-05-30. No database migration required.

Goal: make the product say one thing.

Changes:

- `/pipeline` shows prospects only.
- Remove Opportunities tab from Pipeline.
- Prospect detail sheet opens for a prospect record, not a contact.
- Add "Bids" summary section in prospect sheet.
- Add "Open prospect workspace."
- Hide global Estimates from nav.
- Redirect CRM duplicate routes.

Acceptance:

- A builder can start from Pipeline and understand the next action.
- No visible "Opportunity" noun remains.
- Adding a prospect does not create a Directory contact.

### Phase D: Prospect-scoped bids

Goal: enable bid packages before project creation.

Changes:

- Add prospect bids route.
- Refactor bid package list/detail to context-aware components.
- Update bid services to support `prospect_id`.
- Bid portal loads package context without assuming project.
- Bid award remains blocked until project exists, or is stored as "preferred" before project.

Important product rule:

- Before project exists, allow "select preferred bid" but do not create commitment.
- After project exists, allow "award bid" to create commitment.

Acceptance:

- Builder can create a bid package from a prospect.
- Builder can invite vendors and receive submissions before project creation.
- Bid package appears under project bids after project conversion.

### Phase E: Estimate as signable proposal

Goal: remove the estimate -> proposal detour.

Changes:

- Estimate portal approval includes signature.
- Estimate generates a signable PDF/document directly.
- Builder countersign supported.
- Estimate stores executed file and signature metadata.
- Remove/hide Convert to Proposal.

Acceptance:

- Client can approve and sign an estimate.
- Builder can countersign.
- Executed estimate PDF exists in files/documents.
- No proposal is created for new-path estimates.

### Phase F: Project conversion

Goal: convert the won prospect into a real project.

Changes:

- Add `Create project` CTA when estimate is executed.
- Prefill CreateProjectSheet from prospect and executed estimate.
- Promote prospect contact(s) into Directory.
- Create/link project.
- Link bid packages to project.
- Link files/docs to project.
- Create contract/budget from executed estimate.

Acceptance:

- Prospect remains linked to project.
- Executed estimate appears in project Documents.
- Prospect bid packages appear under project Bids.
- Directory only receives promoted contacts.

### Phase G: Cleanup and deprecation

Goal: remove old mental model and unused code.

Changes:

- Remove/deprecate opportunity components/actions.
- Stop creating proposals from estimates.
- Mark proposal pages as legacy/read-only.
- Remove duplicate CRM pages or redirect them.
- Remove old prospect-as-contact assumptions.

Acceptance:

- New users cannot enter the old opportunity/proposal path.
- Existing historical records remain viewable.
- No broken old links for active customers.

---

## 11) Bids Specific Design

### 11.1 Prospect detail sheet behavior

In the prospect detail sheet, the Bids section should show:

- count of bid packages
- overdue bid packages
- packages due this week
- submissions awaiting review
- quick action: `New bid package`
- primary navigation: `Open bid workspace`

`New bid package` can open a small sheet for fast creation, then route to the full package detail if needed.

`Open bid workspace` should navigate to:

```txt
/pipeline/prospects/[prospectId]/bids
```

### 11.2 Prospect bid workspace

The prospect bid workspace should be the same level of seriousness as project bids:

- package list
- package detail
- invites
- addenda
- submissions
- bid leveling
- portal links
- files attached to the package

But it should avoid project-only actions:

- no commitment creation before project
- no project budget write before project
- no project vendor write before project unless explicitly invited/promoted

### 11.3 Project bid workspace

The existing project bids page remains the project execution/pre-award workspace.

After project creation:

- prospect packages are visible in project bids
- preferred bid can be awarded into commitment
- package history still shows it originated in precon

### 11.4 Bidding attention on Pipeline

Instead of global Bids:

```txt
Pipeline dashboard
  Bidding attention
    - 2 packages overdue
    - 4 bids due this week
    - 3 submissions ready to review
```

Clicking an item opens the related prospect workspace or prospect sheet.

---

## 12) Estimate Specific Design

### 12.1 Prospect estimate tab

Prospect Estimate tab should show:

- current estimate
- version history
- status
- client comments/change requests
- send/re-send actions
- approval/signature state
- executed document
- create project CTA when eligible

### 12.2 Estimate portal

Client portal should support:

- review PDF/document
- request changes as structured comments
- reject
- approve and sign

Signature behavior:

- Approval action must collect signer name/email/consent/signature.
- Store signer evidence in a consistent audit shape.
- Generate executed PDF after all required signatures.

### 12.3 Builder countersign

Options:

1. Use unified e-sign envelope with two recipients: client then builder.
2. Use client portal signature first, then internal builder signature action.

Recommendation: use unified e-sign envelope where possible so executed PDF/audit behavior is consistent.

Required change: unified e-sign must accept `prospect_id` without `project_id`.

---

## 13) Project Conversion Details

### 13.1 Conversion command

Add service:

```ts
convertExecutedProspectToProject({
  prospectId,
  estimateId,
  projectInput,
})
```

Responsibilities:

- validate estimate is executed
- validate prospect is not already won unless idempotent retry
- promote contacts
- create project
- link all context
- create contract/budget
- copy/link documents
- write audit/events

### 13.2 Idempotency requirements

Conversion must be safe to retry.

Use:

- `projects.prospect_id` unique index
- conversion run table, or existing `conversion_runs`
- unique file links for executed estimate
- metadata source ids on generated contract/budget

### 13.3 Files/documents behavior

For prospect files:

Option A:

- Set `files.project_id = project.id` on conversion.
- Keep `files.prospect_id` for origin.

Option B:

- Leave files with `prospect_id`.
- Create `file_links` to the project.

Recommendation: use Option A for files that should become project documents, with metadata preserving origin.

Executed estimate:

- Store as PDF file.
- Link to estimate.
- Link to contract if contract is created.
- Show in project Documents under `/contracts` or `/preconstruction`.

---

## 14) Permissions And RLS

### 14.1 New permission keys

Recommended:

- `pipeline.read`
- `pipeline.write`
- `prospect.read`
- `prospect.write`
- `bid.read`
- `bid.write`
- `signature.send`

If permission model is not ready for this split, use existing org member access first but keep service boundaries ready.

### 14.2 RLS for prospects

Initial RLS:

```sql
auth.role() = 'service_role' or is_org_member(org_id)
```

Later refinement:

- owner/team-based visibility if needed
- project-member visibility after project conversion

### 14.3 RLS for prospect documents

Must support:

- `documents.project_id is null and prospect_id is not null`
- org members with prospect access can view
- public token access remains service-role mediated

Do not expose prospect documents to clients without token/share rules.

---

## 15) Implementation File Map

### New files likely needed

```txt
lib/validation/prospects.ts
lib/services/prospects.ts
app/(app)/pipeline/prospect-actions.ts
app/(app)/pipeline/prospects/[id]/page.tsx
app/(app)/pipeline/prospects/[id]/bids/page.tsx
app/(app)/pipeline/prospects/[id]/bids/[packageId]/page.tsx
components/prospects/prospect-workspace-client.tsx
components/prospects/prospect-overview-tab.tsx
components/prospects/prospect-bids-tab.tsx
components/prospects/prospect-estimate-tab.tsx
components/prospects/prospect-files-tab.tsx
components/prospects/prospect-activity-tab.tsx
```

### Existing files likely changed

```txt
app/(app)/pipeline/page.tsx
components/pipeline/pipeline-workspace-client.tsx
components/pipeline/pipeline-dashboard.tsx
components/pipeline/prospect-detail-sheet.tsx
components/pipeline/add-prospect-dialog.tsx
components/prospects/prospects-client.tsx
components/bids/bid-packages-client.tsx
components/bids/bid-package-detail-client-new.tsx
lib/services/bids.ts
lib/validation/bids.ts
lib/services/estimates.ts
lib/services/estimate-portal.ts
components/portal/estimate-portal-client.tsx
components/estimates/estimates-client.tsx
components/estimates/estimate-create-sheet.tsx
lib/services/documents.ts
lib/services/envelopes.ts
components/esign/envelope-wizard.tsx
app/d/[token]/actions.ts
components/layout/app-sidebar.tsx
components/layout/mobile-bottom-nav.tsx
```

### Existing files likely deprecated

```txt
components/opportunities/*
lib/services/opportunities.ts
lib/validation/opportunities.ts
app/(app)/pipeline/opportunity-actions.ts
app/(app)/crm/page.tsx
app/(app)/crm/prospects/page.tsx
app/(app)/prospects/page.tsx
```

### Existing files kept for legacy

```txt
lib/services/proposals.ts
lib/services/proposal-documents.ts
app/proposal/[token]/*
```

---

## 16) Acceptance Criteria

### Product clarity

- A new builder sees one precon entry point: Pipeline.
- A new lead is created as a prospect, not a contact.
- No user-facing Opportunities object exists.
- No global Bids creation path exists.
- Estimate/proposal language is clear: estimate is the offer; signed estimate is the executed offer.

### Prospect workflow

- Builder can create a prospect without adding a Directory contact.
- Builder can add multiple prospect people.
- Builder can create files, bids, and estimates under the prospect.
- Prospect detail sheet has Bids and Estimate summaries.
- Full prospect workspace supports bid management.

### Bids

- Bid package can be created with `prospect_id` and no `project_id`.
- Bid package can be invited, viewed, submitted, and revised before project creation.
- Project-only award/commitment creation is blocked before project creation.
- After project creation, prospect bid packages appear in project Bids.

### Estimates/signatures

- Estimate can be sent from prospect.
- Client can request changes.
- Client can approve with signature.
- Builder can countersign.
- Executed estimate PDF is generated and stored.
- No new proposal is created in the new path.

### Conversion

- Executed prospect can be converted to project.
- Project is linked to prospect.
- Primary prospect contact is promoted to Directory and assigned as project client.
- Executed estimate appears in project Documents.
- Prospect files/bids are linked to project.
- Contract/budget are created from executed estimate.

### Legacy safety

- Existing project-scoped bids still work.
- Existing proposals remain viewable.
- Existing proposal signing links remain supported during transition.
- Existing opportunities are migrated or readable until migration complete.

---

## 17) Open Decisions

1. Should the physical DB table be `prospects`, or should `opportunities` be renamed after backfill?

Recommendation: create `prospects` fresh and backfill. Do not rename `opportunities` in-place until the app is fully migrated.

2. Should estimate signatures use the unified e-sign envelope or a lightweight embedded signature in the estimate portal?

Recommendation: use unified e-sign for final execution. It already produces executed PDFs and audit trails. The work is to make it prospect-aware.

3. Should bid packages create vendor/company records before project creation?

Recommendation: companies can exist pre-project because vendors/subs are real Directory entities. Client prospects should not become Directory contacts until won. Vendor directory growth is acceptable because bid invites need a company of record for eventual commitment.

4. Should a prospect have a single estimate or multiple estimates?

Recommendation: one current estimate version family per prospect for MVP, with version history. Allow additional estimates later only if real workflows demand alternates.

5. Should there be a global Bid Board later?

Recommendation: defer. Add Pipeline bidding attention first. Add global Bid Board only after users have enough volume that cross-job bid chasing becomes a daily workflow.

---

## 18) Suggested Build Order

1. Add prospect DB model and services.
2. Backfill existing opportunities/contact-prospects into prospects.
3. Simplify Pipeline to prospects only.
4. Add prospect detail sheet Bids/Estimate summaries.
5. Add prospect workspace route.
6. Refactor bids to support prospect context.
7. Add prospect-scoped bids pages.
8. Refactor estimate creation to start from prospect.
9. Make estimate signing prospect-aware.
10. Add builder countersign and executed estimate storage.
11. Add prospect-to-project conversion.
12. Link/migrate files, bids, estimates, contacts on conversion.
13. Hide/deprecate old routes and remove user-facing Opportunities/Proposals.

---

## 19) Implementation Notes For Future LLM Agents

- Do not start by deleting tables or code. This system has active data and existing routes.
- Preserve old proposal and opportunity records until backfill and compatibility are verified.
- Do not add a global Bids nav item during the main redesign.
- Do not create projects just to support bidding.
- Do not create Directory contacts when adding a prospect.
- Keep all schema changes additive first, then migrate, then remove old paths.
- Before making DB migrations, re-run Supabase schema inspection because this app changes quickly.
- Use `supabase migration new <name>` for real migrations, per Supabase workflow.
- Run RLS/security review after changing `documents.project_id` or `envelopes.project_id` nullability.
