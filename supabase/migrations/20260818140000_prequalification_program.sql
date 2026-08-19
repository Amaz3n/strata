-- Prequalification becomes a configurable program rather than a fixed form.
--
-- Three things change:
--   1. An org declares what a prequalification asks for (`orgs.prequalification_template`).
--   2. Each request snapshots that declaration so a template edit never rewrites
--      history or re-labels answers a vendor already gave.
--   3. Prequalification and compliance stop being separate islands — a required
--      document is satisfied by a real `compliance_documents` row.

-- ── The org-level program ───────────────────────────────────────────────────
-- Shape (normalized by lib/validation/prequalification.ts, which is the contract):
--   {
--     "fields":      { "<standard field key>": "required" | "optional" | "off" },
--     "questions":   [{ "id", "section", "label", "type", "required", "help", "options" }],
--     "documents":   [{ "document_type_id", "is_required" }],
--     "references_required": 0,
--     "instructions": ""
--   }
alter table public.orgs
  add column if not exists prequalification_template jsonb not null default '{}'::jsonb;

comment on column public.orgs.prequalification_template is
  'Which standard fields, custom questions, and compliance document types a prequalification request asks for. Empty object means the built-in default program.';

-- ── Per-request snapshot and provenance ─────────────────────────────────────
alter table public.prequalifications
  add column if not exists template jsonb not null default '{}'::jsonb,
  add column if not exists invited_at timestamptz,
  add column if not exists submitted_by_name text,
  add column if not exists submitted_by_email text;

comment on column public.prequalifications.template is
  'The org program as it stood when this request was issued. Answers are keyed against this, never against the current org template.';
comment on column public.prequalifications.invited_at is
  'When an invitation email carrying a portal link was last sent for this request.';

-- `questionnaire` predates the program and held one free-text blob under a
-- "general" key. It is now a map of question id -> answer; the review UI renders
-- unknown keys verbatim so pre-program submissions stay readable.
comment on column public.prequalifications.questionnaire is
  'Answers keyed by question id from the snapshot template. Legacy rows may carry a single "general" key.';

-- ── Documents can belong to a prequalification package ──────────────────────
alter table public.compliance_documents
  add column if not exists prequalification_id uuid
    references public.prequalifications(id) on delete set null;

comment on column public.compliance_documents.prequalification_id is
  'Set when the document was submitted to satisfy a prequalification requirement. The document still counts toward ongoing compliance.';

create index if not exists compliance_documents_prequalification_idx
  on public.compliance_documents (org_id, prequalification_id)
  where prequalification_id is not null;

-- ── A vendor can be prequalified before they are on a project ───────────────
-- 20260803001216 made `project_id` nullable but required a bid-invite scope in
-- its place, which left no room for the case prequalification actually needs:
-- an access record that is about the vendor's relationship with the builder and
-- no single job. A company-scoped sub record is now a third valid shape.
alter table public.portal_access_tokens
  drop constraint if exists portal_access_tokens_scope_present;
alter table public.portal_access_tokens
  add constraint portal_access_tokens_scope_present
    check (project_id is not null or scoped_bid_invite_id is not null or company_id is not null);

comment on column public.portal_access_tokens.project_id is
  'Null for a bid-scoped record whose package has no project yet, or for a company-scoped vendor account record (onboarding, prequalification, compliance). Every consumer must handle null.';

create index if not exists portal_access_tokens_company_scope_idx
  on public.portal_access_tokens (org_id, company_id, portal_type)
  where project_id is null and company_id is not null;
