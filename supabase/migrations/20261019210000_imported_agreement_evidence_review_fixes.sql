-- EP12 review fixes for cutover records (follows 20261019200000_imported_agreement_evidence).
--
-- 1. Imported agreement evidence and imported inspection history are scoped to
--    the member's divisions and projects, like every other home record.
-- 2. An executed copy is bound by the SHA-256 the server computed from the
--    stored bytes, never by files.checksum (on the direct-upload path the
--    browser supplies that). The service stamps file_sha256_verified_at when it
--    hashed the object itself; the guard accepts an executed copy only with it,
--    and refuses a file whose recorded checksum disagrees with those bytes.
-- 3. A home carries at most one imported change-order balance, so two batches
--    committing at once cannot amend its agreement twice.

-- 1. Division and project scope -------------------------------------------------
drop policy if exists imported_agreement_evidence_division_scope on public.imported_agreement_evidence;
create policy imported_agreement_evidence_division_scope on public.imported_agreement_evidence
  as restrictive for all to authenticated
  using (org_id = any ((select public.member_unscoped_org_ids())::uuid[]) or project_id in (select public.member_reachable_project_ids()))
  with check (org_id = any ((select public.member_unscoped_org_ids())::uuid[]) or project_id in (select public.member_reachable_project_ids()));

drop policy if exists imported_inspection_records_division_scope on public.imported_inspection_records;
create policy imported_inspection_records_division_scope on public.imported_inspection_records
  as restrictive for all to authenticated
  using (org_id = any ((select public.member_unscoped_org_ids())::uuid[]) or project_id in (select public.member_reachable_project_ids()))
  with check (org_id = any ((select public.member_unscoped_org_ids())::uuid[]) or project_id in (select public.member_reachable_project_ids()));

-- 2. Server-verified hash ---------------------------------------------------------
alter table public.imported_agreement_evidence add column if not exists file_sha256_verified_at timestamptz;

-- Not validated: rows bound before this migration (acceptance fixtures only; the
-- table ships with the previous migration) are immutable and keep their history.
alter table public.imported_agreement_evidence drop constraint if exists imported_agreement_evidence_verified_hash;
alter table public.imported_agreement_evidence add constraint imported_agreement_evidence_verified_hash
  check (status <> 'executed_file' or file_sha256_verified_at is not null) not valid;

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
    if new.file_sha256_verified_at is null then
      raise exception 'The executed copy must be bound by the SHA-256 the server computed from its stored bytes' using errcode = '23514';
    end if;
    perform 1 from public.files f
     where f.org_id = new.org_id and f.id = new.file_id and f.archived_at is null
       and (f.project_id is null or f.project_id = new.project_id)
       and (f.checksum is null or lower(f.checksum) = new.file_sha256);
    if not found then
      raise exception 'The executed copy must be this organization''s file for the home, and its recorded checksum must match its bytes' using errcode = '23514';
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

-- 3. One imported change-order balance per home -------------------------------------
-- Only cutover imports write this key, and they are new with 20261019200000, so no
-- home can already hold two.
create unique index if not exists change_orders_one_imported_cutover_balance
  on public.change_orders (org_id, project_id) where metadata ? 'imported_cutover_balance';
