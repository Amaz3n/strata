-- EP12-04 / EP12-05: cutover records that are not Books openings.
--
-- 1. Three more staged importers: signed agreements (the executed copy of an
--    agreement Open WIP brought over), selections (current choices, cutoffs and
--    change-order balances) and inspection history.
--
-- 2. An agreement Open WIP imports is a contract row with a total and a date and
--    nothing behind it, yet it read as executed. Each one now carries an
--    imported_agreement_evidence row that starts as evidence_missing. It becomes
--    executed_file only with the org's own file whose SHA-256 is recorded, bound
--    by a signed Documents row, and accepted only by a named person with a
--    reason. Once either, the row never changes again. While it is missing, the
--    closing gate "Purchase agreement executed" cannot be completed or waived.
--
-- 3. Inspection history is kept as read-only historical records outside the
--    inspection lifecycle: an imported row never becomes an inspection, attempt,
--    obligation or closing gate, so every new inspection starts in the lifecycle.

alter table public.import_batches drop constraint if exists import_batches_importer_check;
alter table public.import_batches add constraint import_batches_importer_check check (importer in (
  'cost_codes','plan_library','option_catalog','price_book','communities_lots','open_wip','team','warranty_homes',
  'agreements','selections','inspection_history'));
alter table public.import_mapping_profiles drop constraint if exists import_mapping_profiles_importer_check;
alter table public.import_mapping_profiles add constraint import_mapping_profiles_importer_check check (importer in (
  'cost_codes','plan_library','option_catalog','price_book','communities_lots','open_wip','team','warranty_homes',
  'agreements','selections','inspection_history'));

-- ---------------------------------------------------------------------------
-- Imported agreement evidence

create table public.imported_agreement_evidence (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  contract_id uuid not null unique references public.contracts(id) on delete cascade,
  status text not null default 'evidence_missing' check (status in ('evidence_missing','executed_file','accepted')),
  document_id uuid references public.documents(id) on delete restrict,
  file_id uuid references public.files(id) on delete restrict,
  file_sha256 text check (file_sha256 ~ '^[0-9a-f]{64}$'),
  signers jsonb not null default '[]'::jsonb check (jsonb_typeof(signers) = 'array'),
  signed_on date,
  source_batch_id uuid references public.import_batches(id) on delete restrict,
  source_row_id uuid,
  source_deposit_cents bigint check (source_deposit_cents >= 0),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  review_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint imported_agreement_evidence_executed_complete check (status <> 'executed_file' or (
    document_id is not null and file_id is not null and file_sha256 is not null and signed_on is not null and jsonb_array_length(signers) > 0)),
  constraint imported_agreement_evidence_accepted_complete check (status <> 'accepted' or (
    reviewed_by is not null and reviewed_at is not null and length(btrim(coalesce(review_reason, ''))) >= 10))
);

create index imported_agreement_evidence_org_project_idx on public.imported_agreement_evidence (org_id, project_id);
create index imported_agreement_evidence_missing_idx on public.imported_agreement_evidence (org_id, created_at) where status = 'evidence_missing';
create index imported_agreement_evidence_document_idx on public.imported_agreement_evidence (document_id) where document_id is not null;
create index imported_agreement_evidence_file_idx on public.imported_agreement_evidence (file_id) where file_id is not null;
create index imported_agreement_evidence_batch_idx on public.imported_agreement_evidence (source_batch_id) where source_batch_id is not null;

create trigger imported_agreement_evidence_set_updated_at before update on public.imported_agreement_evidence
  for each row execute function public.tg_set_updated_at();

create or replace function public.guard_imported_agreement_evidence() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    -- A home Open WIP rolls back takes its never-evidenced agreement with it; reviewed evidence is kept.
    if old.status <> 'evidence_missing' then
      raise exception 'Reviewed imported agreement evidence is part of the record and cannot be deleted' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if (new.id, new.org_id, new.project_id, new.contract_id, new.created_at) is distinct from (old.id, old.org_id, old.project_id, old.contract_id, old.created_at) then
      raise exception 'Imported agreement evidence identity cannot change' using errcode = '42501';
    end if;
    if old.status <> 'evidence_missing' then
      if (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
        raise exception 'Imported agreement evidence is immutable once its executed copy is on file or a person has accepted it' using errcode = '42501';
      end if;
      return new;
    end if;
  end if;
  if new.status = 'executed_file' then
    perform 1 from public.files f
     where f.org_id = new.org_id and f.id = new.file_id and f.checksum = new.file_sha256 and f.archived_at is null
       and (f.project_id is null or f.project_id = new.project_id);
    if not found then
      raise exception 'The executed copy must be this organization''s file for the home, with the SHA-256 recorded' using errcode = '23514';
    end if;
    perform 1 from public.documents d
     where d.org_id = new.org_id and d.id = new.document_id and d.project_id = new.project_id and d.executed_file_id = new.file_id
       and d.status = 'signed' and d.source_entity_type = 'contract' and d.source_entity_id = new.contract_id;
    if not found then
      raise exception 'The executed copy must be bound by a signed document for this agreement' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger imported_agreement_evidence_guard before insert or update or delete on public.imported_agreement_evidence
  for each row execute function public.guard_imported_agreement_evidence();

-- Every agreement Open WIP writes starts with its evidence missing.
create or replace function public.tg_contract_imported_agreement_evidence() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.imported_agreement_evidence (org_id, project_id, contract_id)
  values (new.org_id, new.project_id, new.id)
  on conflict (contract_id) do nothing;
  return null;
end $$;

create trigger contracts_imported_agreement_evidence after insert on public.contracts
  for each row when (new.contract_type = 'purchase_agreement' and new.project_id is not null and new.snapshot->>'imported_open_wip' = 'true')
  execute function public.tg_contract_imported_agreement_evidence();

insert into public.imported_agreement_evidence (org_id, project_id, contract_id)
select c.org_id, c.project_id, c.id from public.contracts c
 where c.contract_type = 'purchase_agreement' and c.project_id is not null and c.snapshot->>'imported_open_wip' = 'true'
on conflict (contract_id) do nothing;

-- The closing gate that says the agreement is executed cannot be completed or
-- waived while the home's active imported agreement has no evidence.
create or replace function public.guard_closing_agreement_evidence() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.key = 'agreement_executed' and new.status <> 'open' and (tg_op = 'INSERT' or new.status is distinct from old.status) then
    if exists (
      select 1 from public.closings c
        join public.imported_agreement_evidence e on e.org_id = c.org_id and e.project_id = c.project_id and e.status = 'evidence_missing'
        join public.contracts k on k.id = e.contract_id and k.status = 'active'
       where c.id = new.closing_id and c.org_id = new.org_id) then
      raise exception 'The imported purchase agreement has no executed copy on file. Attach it, or accept it with a reason, under Data imports > Signed agreements first.' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger closing_checklist_agreement_evidence before insert or update on public.closing_checklist_items
  for each row execute function public.guard_closing_agreement_evidence();

alter table public.imported_agreement_evidence enable row level security;
create policy imported_agreement_evidence_member_read on public.imported_agreement_evidence
  for select to authenticated using (public.is_org_member(org_id));
revoke all on public.imported_agreement_evidence from anon;
revoke insert, update, delete, truncate, references, trigger on public.imported_agreement_evidence from authenticated;
grant select on public.imported_agreement_evidence to authenticated;

-- ---------------------------------------------------------------------------
-- Imported inspection history

create table public.imported_inspection_records (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  inspection_type text not null check (length(btrim(inspection_type)) between 1 and 200),
  inspected_on date not null,
  result text not null check (result in ('pass','fail','partial')),
  inspector text,
  reference text,
  source_batch_id uuid not null references public.import_batches(id) on delete restrict,
  source_row_id uuid not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create unique index imported_inspection_records_identity_idx
  on public.imported_inspection_records (org_id, project_id, lower(btrim(inspection_type)), inspected_on, result);
create index imported_inspection_records_org_project_idx on public.imported_inspection_records (org_id, project_id);
create index imported_inspection_records_batch_idx on public.imported_inspection_records (source_batch_id);

create or replace function public.guard_imported_inspection_record() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Removing the home takes its history with it; nothing else changes a record.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 and not exists (select 1 from public.projects p where p.id = old.project_id) then
    return old;
  end if;
  raise exception 'Imported inspection history is a read-only record' using errcode = '42501';
end $$;

create trigger imported_inspection_records_guard before update or delete on public.imported_inspection_records
  for each row execute function public.guard_imported_inspection_record();

alter table public.imported_inspection_records enable row level security;
create policy imported_inspection_records_member_read on public.imported_inspection_records
  for select to authenticated using (public.is_org_member(org_id));
revoke all on public.imported_inspection_records from anon;
revoke insert, update, delete, truncate, references, trigger on public.imported_inspection_records from authenticated;
grant select on public.imported_inspection_records to authenticated;
