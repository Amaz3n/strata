-- Update one unpublished draft atomically; preserve surviving item identities.
create or replace function public.save_estimate_draft(
  p_org_id uuid, p_estimate_id uuid, p_expected_updated_at timestamptz,
  p_document jsonb, p_items jsonb
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  draft public.estimates%rowtype;
  item jsonb;
  item_id uuid;
  kept_ids uuid[] := '{}';
begin
  select * into draft from public.estimates
    where id = p_estimate_id and org_id = p_org_id for update;
  if not found then raise exception 'Estimate not found'; end if;
  if draft.status <> 'draft' or draft.sent_at is not null or draft.is_current_version = false then
    raise exception 'Only the current unpublished draft can be edited';
  end if;
  if p_expected_updated_at is null or draft.updated_at is distinct from p_expected_updated_at then
    raise exception 'This draft changed elsewhere. Reopen it to load the latest version.';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A draft requires at least one line';
  end if;
  if nullif(p_document->>'recipient_contact_id','') is not null and not exists (
    select 1 from public.contacts where id = (p_document->>'recipient_contact_id')::uuid and org_id = p_org_id
  ) then raise exception 'Client not found in this organization'; end if;
  for item in select value from jsonb_array_elements(p_items) loop
    if nullif(item->>'cost_code_id','') is not null and not exists (
      select 1 from public.cost_codes where id = (item->>'cost_code_id')::uuid and org_id = p_org_id
    ) then raise exception 'Cost code not found in this organization'; end if;
    select id into item_id from public.estimate_items
      where estimate_id = p_estimate_id and org_id = p_org_id
      and (metadata->>'editor_line_id' = item->'metadata'->>'editor_line_id'
        or id::text = item->'metadata'->>'editor_line_id')
      limit 1;
    if item_id = any(kept_ids) then raise exception 'Duplicate draft line'; end if;
    if item_id is null then
      insert into public.estimate_items (org_id, estimate_id, description)
        values (p_org_id, p_estimate_id, item->>'description') returning id into item_id;
    end if;
    update public.estimate_items set
      description = item->>'description', item_type = item->>'item_type',
      cost_code_id = nullif(item->>'cost_code_id','')::uuid,
      quantity = (item->>'quantity')::numeric, unit = item->>'unit',
      unit_cost_cents = (item->>'unit_cost_cents')::bigint,
      markup_pct = (item->>'markup_pct')::numeric,
      sort_order = (item->>'sort_order')::integer,
      metadata = item->'metadata'
      where id = item_id and org_id = p_org_id;
    kept_ids := array_append(kept_ids, item_id);
  end loop;
  delete from public.estimate_items where estimate_id = p_estimate_id and org_id = p_org_id and not (id = any(kept_ids));
  update public.estimates set title = p_document->>'title',
    recipient_contact_id = nullif(p_document->>'recipient_contact_id','')::uuid,
    valid_until = nullif(p_document->>'valid_until','')::date,
    subtotal_cents = (p_document->>'subtotal_cents')::bigint,
    tax_cents = (p_document->>'tax_cents')::bigint,
    total_cents = (p_document->>'total_cents')::bigint,
    metadata = coalesce(draft.metadata, '{}'::jsonb) || (p_document->'metadata'),
    updated_at = clock_timestamp()
    where id = p_estimate_id and org_id = p_org_id returning * into draft;
  return to_jsonb(draft);
end;
$$;
-- The server validates organization membership and the complete input first.
revoke all on function public.save_estimate_draft(uuid,uuid,timestamptz,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.save_estimate_draft(uuid,uuid,timestamptz,jsonb,jsonb) to service_role;
