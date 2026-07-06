alter table public.bid_packages
  add column if not exists budget_line_id uuid references public.budget_lines(id) on delete set null;

create index if not exists bid_packages_org_project_budget_line_idx
  on public.bid_packages (org_id, project_id, budget_line_id)
  where budget_line_id is not null;

comment on column public.bid_packages.budget_line_id
  is 'Optional direct budget line link used to track buyout status against uncoded or line-level budgets.';

alter table public.documents
  drop constraint if exists documents_source_entity_type_chk;

alter table public.documents
  add constraint documents_source_entity_type_chk check (
    source_entity_type is null
    or source_entity_type in (
      'estimate',
      'proposal',
      'change_order',
      'lien_waiver',
      'selection',
      'subcontract',
      'subcontract_change_order',
      'closeout',
      'other'
    )
  );

alter table public.envelopes
  drop constraint if exists envelopes_source_entity_type_check;

alter table public.envelopes
  add constraint envelopes_source_entity_type_check check (
    source_entity_type is null
    or source_entity_type in (
      'estimate',
      'proposal',
      'change_order',
      'lien_waiver',
      'selection',
      'subcontract',
      'subcontract_change_order',
      'closeout',
      'other'
    )
  );
