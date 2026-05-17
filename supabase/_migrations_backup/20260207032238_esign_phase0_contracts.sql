-- Phase 0: unified e-sign decision contracts and rollout controls

alter table if exists documents
  add column if not exists source_entity_type text,
  add column if not exists source_entity_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'documents_source_entity_type_chk'
  ) then
    alter table documents
      add constraint documents_source_entity_type_chk
      check (
        source_entity_type is null
        or source_entity_type in (
          'proposal',
          'change_order',
          'lien_waiver',
          'selection',
          'subcontract',
          'closeout',
          'other'
        )
      );
  end if;
end$$;

create index if not exists documents_org_source_entity_created_idx
  on documents (org_id, source_entity_type, source_entity_id, created_at desc)
  where source_entity_type is not null and source_entity_id is not null;

create or replace function public.tg_documents_sync_source_entity_from_metadata()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.source_entity_id is not null and new.source_entity_type is not null then
    return new;
  end if;

  if (new.metadata ? 'proposal_id')
     and (new.metadata ->> 'proposal_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    new.source_entity_type := coalesce(new.source_entity_type, 'proposal');
    new.source_entity_id := coalesce(new.source_entity_id, (new.metadata ->> 'proposal_id')::uuid);
    return new;
  end if;

  if (new.metadata ? 'change_order_id')
     and (new.metadata ->> 'change_order_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    new.source_entity_type := coalesce(new.source_entity_type, 'change_order');
    new.source_entity_id := coalesce(new.source_entity_id, (new.metadata ->> 'change_order_id')::uuid);
    return new;
  end if;

  if (new.metadata ? 'lien_waiver_id')
     and (new.metadata ->> 'lien_waiver_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    new.source_entity_type := coalesce(new.source_entity_type, 'lien_waiver');
    new.source_entity_id := coalesce(new.source_entity_id, (new.metadata ->> 'lien_waiver_id')::uuid);
    return new;
  end if;

  return new;
end
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'documents_sync_source_entity_from_metadata') then
    create trigger documents_sync_source_entity_from_metadata
      before insert or update of metadata, source_entity_type, source_entity_id on documents
      for each row
      execute function public.tg_documents_sync_source_entity_from_metadata();
  end if;
end$$;

update documents
set source_entity_type = 'proposal',
    source_entity_id = (metadata ->> 'proposal_id')::uuid
where source_entity_type is null
  and source_entity_id is null
  and document_type = 'proposal'
  and metadata ? 'proposal_id'
  and (metadata ->> 'proposal_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_signing_requests_sequence_positive_chk'
  ) then
    alter table document_signing_requests
      add constraint document_signing_requests_sequence_positive_chk
      check (sequence >= 1);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'document_signing_requests_uses_bounds_chk'
  ) then
    alter table document_signing_requests
      add constraint document_signing_requests_uses_bounds_chk
      check (
        max_uses >= 1
        and used_count >= 0
        and used_count <= max_uses
      );
  end if;
end$$;

create index if not exists document_signing_requests_active_sequence_idx
  on document_signing_requests (org_id, group_id, sequence)
  where required = true
    and status in ('draft', 'sent', 'viewed');

insert into feature_flags (org_id, flag_key, enabled, config, expires_at)
select
  id,
  'unified_esign',
  true,
  jsonb_build_object(
    'phase', 0,
    'scope', 'unified_esign',
    'notes', 'Enable unified e-sign rollout controls'
  ),
  '2099-12-31T23:59:59Z'::timestamptz
from orgs
on conflict (org_id, flag_key) do nothing;
