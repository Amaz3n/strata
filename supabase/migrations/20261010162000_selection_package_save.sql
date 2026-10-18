-- Saving a package and replacing its members is one transaction.
--
-- upsertPackage (the live path while atomic publication is off) wrote the
-- package row, deleted every member, then inserted the new set as three
-- separate PostgREST calls: a failed insert left the package empty, and a
-- failed first save left a package with no members. Here the package row is
-- locked, its options are verified (same org, one per category), and the row,
-- the delete and the insert commit or roll back together. The service has
-- already authorized selections.catalog.manage and keeps the audit write.

create or replace function public.save_selection_package(
  p_org_id uuid,
  p_package_id uuid,
  p_fields jsonb,
  p_option_ids uuid[]
) returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_id uuid;
  v_distinct uuid[];
  v_found integer;
  v_categories integer;
  v_community uuid;
begin
  if p_org_id is null or p_fields is null then
    raise exception 'Package scope is required' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct x), '{}') into v_distinct from unnest(coalesce(p_option_ids, '{}')) x;
  if cardinality(v_distinct) = 0 or cardinality(v_distinct) <> cardinality(p_option_ids) then
    raise exception 'A package needs at least one distinct option' using errcode = '22023';
  end if;
  select count(*), count(distinct category_id) into v_found, v_categories
    from public.selection_options
   where org_id = p_org_id and id = any(v_distinct);
  if v_found <> cardinality(v_distinct) then
    raise exception 'One or more package options were not found' using errcode = 'foreign_key_violation';
  end if;
  if v_categories <> v_found then
    raise exception 'A package can include only one option per category' using errcode = 'check_violation';
  end if;
  v_community := nullif(p_fields ->> 'community_id', '')::uuid;
  if v_community is not null
     and not exists (select 1 from public.communities where org_id = p_org_id and id = v_community) then
    raise exception 'Package community not found' using errcode = 'foreign_key_violation';
  end if;

  if p_package_id is null then
    insert into public.selection_packages (org_id, community_id, name, description, image_url, price_cents, cost_cents, is_available, sort_order)
    values (
      p_org_id, v_community, p_fields ->> 'name', p_fields ->> 'description', p_fields ->> 'image_url',
      (p_fields ->> 'price_cents')::integer, (p_fields ->> 'cost_cents')::integer,
      coalesce((p_fields ->> 'is_available')::boolean, true), coalesce((p_fields ->> 'sort_order')::integer, 0)
    )
    returning id into v_id;
  else
    perform 1 from public.selection_packages where org_id = p_org_id and id = p_package_id for update;
    if not found then
      raise exception 'Package not found' using errcode = 'no_data_found';
    end if;
    update public.selection_packages set
      community_id = v_community,
      name = p_fields ->> 'name',
      description = p_fields ->> 'description',
      image_url = p_fields ->> 'image_url',
      price_cents = (p_fields ->> 'price_cents')::integer,
      cost_cents = case when p_fields ? 'cost_cents' then (p_fields ->> 'cost_cents')::integer else cost_cents end,
      is_available = coalesce((p_fields ->> 'is_available')::boolean, is_available),
      sort_order = coalesce((p_fields ->> 'sort_order')::integer, sort_order)
    where org_id = p_org_id and id = p_package_id
    returning id into v_id;
    delete from public.selection_package_items where org_id = p_org_id and package_id = v_id;
  end if;

  insert into public.selection_package_items (org_id, package_id, option_id)
  select p_org_id, v_id, option_id from unnest(v_distinct) as option_id;
  return v_id;
end;
$$;

revoke all on function public.save_selection_package(uuid, uuid, jsonb, uuid[]) from public, anon, authenticated;
grant execute on function public.save_selection_package(uuid, uuid, jsonb, uuid[]) to service_role;
