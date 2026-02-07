-- Phase 0 follow-up: lock function search_path for security lint compliance

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
