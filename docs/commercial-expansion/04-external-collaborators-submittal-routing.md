# Workstream 04 — External Collaborator Seats + Submittal Review Routing + Ball-in-Court

> **STATUS (2026-07-10): CODE COMPLETE + MIGRATIONS APPLIED; MANUAL QA PENDING.**
> All five phases implemented (`pnpm lint` clean). All three migrations applied to
> production 2026-07-10 via Supabase MCP and verified (schema, RLS policies,
> `submittal.route` role grants): `20260710233000_reviewer_portal.sql`,
> `20260710234500_submittal_workflow.sql`, `20260710235500_distribution_lists.sql`.
> Deviations from this doc: stamped-copy pointer lives on
> `submittals.stamped_file_id` (not the final step) so every surface can link it;
> the reviewer's markup upload stays on `submittal_review_steps.markup_file_id`.
> Remaining gate: run the acceptance checklist below manually in the internal QA
> org before merge.

> Prereq: 00 master, 01. Commercial jobs are multi-party: architect, engineers,
> owner's rep. Arc's only external personas today are "client" and "sub" tokens with a
> single-contact assumption. This workstream adds a third persona — the **reviewer
> seat** — and uses it to build the commercial submittal routing flow (sub → GC →
> architect → returned) plus explicit ball-in-court on RFIs and submittals.

## Goal

1. A **`reviewer` portal type** on the existing token/portal infrastructure: scoped,
   per-project access for architects/engineers/owner's reps — view drawings/RFIs/
   submittals, respond to RFIs, and act as the design-review step on submittals.
   No full org membership, no license seat.
2. **Multi-step submittal review routing**: an ordered workflow (GC review →
   architect review → optional consultants) as a state machine with per-step decisions
   and an audit trail.
3. **Ball-in-court** as a first-class, displayed field on RFIs and submittals, derived
   from workflow state (not manually set).
4. **Review stamp imprint** on returned submittal documents (PDF stamp with decision,
   reviewer, date).
5. Managed **distribution lists** per project (who gets copied on RFIs/submittals).

## Non-goals

- No real `auth.users` accounts for externals (that's the deferred SSO/enterprise
  track, workstream 09). Reviewer seats ride `portal_access_tokens` +
  `external_portal_accounts` exactly like clients/subs.
- No cross-org federation.
- Decisions module untouched (it stays residential; commercial-posture project
  sidebars de-emphasize it via workstream 01's `postures` nav field).

## Read these files first

- `lib/services/portal-access.ts` — token load paths (`loadClientPortalData`,
  `loadSubPortalData`), `recordPortalAccess`, capability checks.
- `portal_access_tokens` verified columns — `portal_type` (text), per-capability
  booleans incl. `can_view_rfis`, `can_respond_rfis`, `can_view_submittals`,
  `can_submit_submittals`, `can_view_documents`, `can_download_files`, PIN/account
  gates. Find the CHECK constraint or code enum restricting `portal_type` values.
- `lib/services/external-portal-auth.ts` — account claim + workspace grants.
- `lib/services/portal-links.ts` (capability helper from the operational-features
  upgrade) and `lib/services/rfis.ts` `ensurePortalLink` — how tokens are minted for a
  contact/company on demand.
- `lib/services/submittals.ts` — full read; the single-review model you're replacing
  (reviewed_by/review_notes/decideSubmittal), revision chain, portal item submission.
- `app/s/[token]/` structure — you'll add `app/r/[token]/` as a sibling.
- `components/esign/esign-document-viewer.tsx` + `lib/pdfs/esign.ts` — pdf-lib stamping
  mechanics for the review stamp.
- `proxy.ts` — confirm how `app/p|s|b/[token]` public routes are allowed; mirror for
  `/r/[token]`.

## Part 1 — Reviewer seats

**Migration — `<ts>_reviewer_portal.sql`:**

```sql
-- 1. Allow the new portal type (adjust to the actual constraint mechanism found).
--    portal_type gains 'reviewer'.
-- 2. New capabilities:
alter table public.portal_access_tokens
  add column if not exists can_review_submittals boolean not null default false,
  add column if not exists reviewer_role text
    check (reviewer_role in ('architect','engineer','owner_rep','consultant','other'));
```

**Service:** in `portal-access.ts`, add `loadReviewerPortalData(token)` — project
header, drawings (respecting existing sheet sharing flags — reviewers see what
`share_with_clients` OR a new explicit grant allows; simplest correct rule: reviewers
see all published drawing revisions, since design team owns the drawings), RFI list
(assigned to them or where they're on the distribution list), submittal review queue
(steps waiting on them — Part 2). Reuse `ensurePortalLink`-style minting: a helper
`ensureReviewerLink(projectId, contactId)` used by RFI assignment and submittal
routing.

**UI:** `app/r/[token]/` — copy the structural skeleton of `app/s/[token]` (gate
handling, tabs). Tabs: Overview, Drawings, RFIs, Submittals (review queue). Keep it
lean — the heavy work is the submittal review screen (Part 2). Same PIN/account gates
as other portals (they're in the shared token loader — verify nothing is
client/sub-hardcoded in `page.tsx` gate flow; refactor shared gate logic if duplicated,
`app/p` and `app/s` may already share helpers).

**Directory hookup:** `companies.company_type` already includes `architect` and
`engineer`. Project team UI (project settings/directory) gains an "External reviewers"
section: pick a contact, role, and mint their link (one-click copy + email invite via
mailer). Store nothing new — the token IS the membership.

## Part 2 — Submittal review routing

**Migration — `<ts>_submittal_workflow.sql`:**

```sql
create table public.submittal_review_steps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  submittal_id uuid not null references public.submittals(id) on delete cascade,
  step_order integer not null,
  reviewer_kind text not null check (reviewer_kind in ('internal','external')),
  reviewer_user_id uuid,             -- internal
  reviewer_contact_id uuid,          -- external (reviewer seat)
  reviewer_company_id uuid,
  role_label text,                   -- 'GC Review', 'Architect', 'MEP Engineer'
  status text not null default 'pending'
    check (status in ('pending','in_review','returned','skipped')),
  decision text
    check (decision in ('approved','approved_as_noted','revise_resubmit','rejected')),
  notes text,
  decided_at timestamptz,
  due_date date,
  portal_token_id uuid,
  created_at timestamptz not null default now(),
  unique (submittal_id, step_order)
);

alter table public.submittals
  add column if not exists current_review_step_id uuid,
  add column if not exists ball_in_court text;  -- denormalized display label, service-maintained
```

**Workflow rules (implement in `submittals.ts`):**
- Default workflow template per org (org setting, jsonb: ordered steps like
  [GC Review (internal)] or [GC Review, Architect]). Creating/sending a submittal
  instantiates steps; steps are editable while `pending`.
- When the sub submits items (existing portal flow) → step 1 becomes `in_review`,
  BIC = step 1's reviewer, notify them (email via mailer + reviewer portal link for
  external steps).
- `decideReviewStep(stepId, decision, notes, markupFileId?)`:
  - `approved` / `approved_as_noted` → advance to next step; if last step, run the
    EXISTING `decideSubmittal` finalization with that decision (keeps org desk,
    events, emails working) and stamp the PDF (Part 3).
  - `revise_resubmit` / `rejected` → short-circuit: finalize submittal with that
    decision (existing `resubmitSubmittal` path then applies; new revision re-creates
    the same workflow steps).
  - Each step decision records reviewer identity (user or contact+token), timestamps,
    recordEvent/recordAudit.
- Backward compatibility: submittals with zero steps keep today's single
  `decideSubmittal` path untouched (residential projects unaffected). The org's default
  workflow template applies to commercial-POSTURE projects (workstream 01
  `getProjectPosture`); a 2-step default is seeded for orgs on commercial tier or when
  their first commercial project is created.
- **Ball-in-court derivation** (shared helper, also used by RFIs):
  submittal BIC = "Subcontractor (CompanyName)" before items submitted; the current
  step's role_label while in review; "—" when closed. Persist the label to
  `submittals.ball_in_court` on every transition (denormalized for list sorting).
  RFIs: BIC = assigned party while open, "Requester" when answered, empty when closed —
  compute in `rfis.ts` list/detail DTOs and add a `ball_in_court` column the same way.

**UI:**
- Submittal detail (internal): workflow rail (ordered steps, status chips, decide
  controls for internal steps), BIC + days-in-court surfaced at top. Register list
  gains BIC + Due columns; org desk gains "waiting on me/us" filter.
- Reviewer portal submittal screen: item list with files, decision buttons
  (approve / approve-as-noted / revise&resubmit / reject), notes, optional marked-up
  file upload (reuse `portal-uploads.ts`).
- RFI list/detail: BIC chip.

## Part 3 — Review stamp

`lib/pdfs/submittal-stamp.ts`: given the submittal's primary item PDF and the final
decision chain, draw a stamp block on page 1 (top-right, rectangle): org name,
"REVIEWED — <DECISION LABEL>", reviewer name/role, date, and the standard disclaimer
line ("Review is for general conformance with design intent…" — make it an org-editable
setting with this default). Output a new file version via the files service
(`file-versions.ts`) — never overwrite the sub's original. Attach the stamped file id to
the final review step and expose "Download stamped copy" on detail + sub portal (sub
sees returned decision + stamped doc).

## Part 4 — Distribution lists

**Migration — `<ts>_distribution_lists.sql`:**

```sql
create table public.project_distribution_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  scope text not null check (scope in ('rfis','submittals','all')),
  contact_id uuid references public.contacts(id),
  user_id uuid,
  created_at timestamptz not null default now()
);
```

`rfis.ts` `sendRfiEmail` and `submittals.ts` email senders: union the auto-derived
recipients (existing logic, keep it) with distribution members for the scope, dedup as
today. Small management UI on project settings (add contact/user, scope). This also
gives workstream 05's transmittals a recipient source.

## Permissions / events

- New keys: `submittal.route` (edit workflows/decide internal steps) — add to
  `TEAM_PERMISSION_OPTIONS`; reviewer portal actions authorize via token capabilities.
- Events: `submittal.step_decided`, `submittal.returned`, `rfi.ball_changed` (only if
  cheap — BIC is derivable; skip the event if noisy).

## Phases

1. Reviewer portal type + `/r/[token]` shell + team-UI minting. (No routing yet —
   reviewers can view drawings/RFIs and respond to RFIs via existing capabilities.)
2. Review-step schema + service state machine + internal workflow rail UI +
   BIC on submittals and RFIs.
3. Reviewer-portal review queue + decide flow + notifications.
4. Stamp PDF + stamped-copy distribution.
5. Distribution lists.

## Acceptance checklist

> Run in the internal QA org (`Arc QA — Commercial`, slug `arc-qa-commercial`).
> Code + migrations are live; boxes 1–6 are the manual QA gate before merge.

- [ ] Mint an architect reviewer link from project team UI; architect opens `/r/…`,
      sees drawings + RFIs, responds to an RFI (existing portal response path).
- [ ] Commercial submittal: sub uploads → GC internal step approves → architect step
      notified, opens reviewer portal, returns approved-as-noted with markup file →
      submittal finalized approved_as_noted, stamped PDF generated, sub portal shows
      returned stamped copy.
- [ ] revise_resubmit at architect step → resubmission (rev 2) recreates workflow;
      register shows rev chain + BIC correctly at each stage.
- [ ] BIC + days-in-court visible on RFI and submittal registers; org desk
      "waiting on us" filter works.
- [ ] Residential org: no workflow steps, single-decision path identical to before.
- [ ] Distribution-list member receives RFI + submittal emails; no duplicate sends.
- [x] `pnpm lint` clean. (2026-07-10, after every phase)
