-- Sub portal signing follow-up:
-- - payable lien waivers can be tied directly to vendor bills
-- - commitment/subcontract signing can be surfaced from existing document envelopes

alter table public.lien_waivers
  add column if not exists bill_id uuid references public.vendor_bills(id) on delete set null;

create index if not exists lien_waivers_bill_idx
  on public.lien_waivers (org_id, bill_id)
  where bill_id is not null;

create unique index if not exists lien_waivers_bill_type_unique_idx
  on public.lien_waivers (org_id, bill_id, waiver_type)
  where bill_id is not null;

create index if not exists documents_subcontract_source_idx
  on public.documents (org_id, project_id, source_entity_type, source_entity_id)
  where source_entity_type = 'subcontract';
