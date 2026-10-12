-- Selection writes on a home commit only against what they were validated on.
--
-- The service reads the home, prices every option and runs the configuration
-- rules in application code, then hands the rows to
-- `apply_project_selection_writes`. Nothing tied the write to that reading: a
-- price, availability or rule published in between, or another session
-- changing the same home's other selections, cutoff lock or plan, committed a
-- configuration nobody had validated. Two sessions choosing an excluded pair
-- on the same home could both pass and both land.
--
-- The fence is two values read BEFORE validation and checked again inside the
-- write transaction, after a home-level lock:
--   * the org catalog revision (`agreement_catalog_revisions`, advanced by
--     every write to options, packages, prices, configuration rules,
--     categories, plan availability ...), and
--   * a fingerprint of everything on the home the validation consulted: its
--     selections, their cutoff instances, the lot's community and plan
--     version, the project posture and its purchase agreements.
-- Two writes on the same home serialize on the lock; the second sees the first
-- in the fingerprint and is refused rather than landing an unvalidated set.
--
-- Every column a write carries is set; a column it leaves out is kept, so a
-- confirmation can land without restating the choice it confirms. `metadata`
-- is still merged, never replaced.

create or replace function public.project_selection_home_state(p_org_id uuid, p_project_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select md5(concat_ws('|',
    (select string_agg(format('%s:%s:%s:%s:%s:%s', s.id, s.selected_option_id, s.package_id, s.status, s.group_id, extract(epoch from s.locked_at)), ',' order by s.id)
       from public.project_selections s where s.org_id = p_org_id and s.project_id = p_project_id),
    (select string_agg(format('%s:%s:%s', g.group_id, g.status, to_char(g.cutoff_date, 'YYYY-MM-DD')), ',' order by g.group_id)
       from public.project_selection_groups g where g.org_id = p_org_id and g.project_id = p_project_id),
    (select string_agg(format('%s:%s:%s', l.id, l.community_id, l.house_plan_version_id), ',' order by l.id)
       from public.lots l where l.org_id = p_org_id and l.project_id = p_project_id),
    (select string_agg(format('%s:%s:%s', c.id, c.status, extract(epoch from c.signed_at)), ',' order by c.id)
       from public.contracts c where c.org_id = p_org_id and c.project_id = p_project_id and c.contract_type = 'purchase_agreement'),
    (select format('posture:%s', p.property_type) from public.projects p where p.org_id = p_org_id and p.id = p_project_id)
  ))
$$;

revoke all on function public.project_selection_home_state(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.read_project_selection_fence(p_org_id uuid, p_project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_revision bigint;
begin
  select r.revision into current_revision from public.agreement_catalog_revisions r where r.org_id = p_org_id;
  if not found then raise exception 'Catalog revision is unavailable'; end if;
  return jsonb_build_object(
    'catalogRevision', current_revision::text,
    'homeState', public.project_selection_home_state(p_org_id, p_project_id)
  );
end;
$$;

revoke all on function public.read_project_selection_fence(uuid, uuid) from public, anon, authenticated;
grant execute on function public.read_project_selection_fence(uuid, uuid) to service_role;

drop function if exists public.apply_project_selection_writes(uuid, uuid, jsonb);

create function public.apply_project_selection_writes(
  p_org_id uuid,
  p_project_id uuid,
  p_writes jsonb,
  p_expected_catalog_revision text,
  p_expected_home_state text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  w jsonb;
  touched integer;
  total integer := 0;
  current_revision bigint;
begin
  if jsonb_typeof(p_writes) is distinct from 'array' or jsonb_array_length(p_writes) = 0 then
    raise exception 'No selection writes to apply' using errcode = '22023';
  end if;
  if p_expected_catalog_revision is null or p_expected_catalog_revision !~ '^[1-9][0-9]{0,18}$'
     or p_expected_home_state is null or p_expected_home_state !~ '^[0-9a-f]{32}$' then
    raise exception 'Selection writes require the catalog revision and home state they were validated on' using errcode = '22023';
  end if;

  -- One writer per home at a time; everything below is read under the lock.
  perform pg_advisory_xact_lock(hashtextextended('project-selections:' || p_org_id::text || ':' || p_project_id::text, 0));

  select r.revision into current_revision from public.agreement_catalog_revisions r where r.org_id = p_org_id for share;
  if not found then raise exception 'Catalog revision is unavailable'; end if;
  if current_revision::text is distinct from p_expected_catalog_revision then
    raise exception 'The catalog changed while you were choosing; review and try again' using detail = 'SELECTION_CATALOG_CHANGED';
  end if;
  if public.project_selection_home_state(p_org_id, p_project_id) is distinct from p_expected_home_state then
    raise exception 'This home''s selections changed while you were choosing; review and try again' using detail = 'SELECTION_HOME_CHANGED';
  end if;

  for w in select value from jsonb_array_elements(p_writes) loop
    update public.project_selections s set
      selected_option_id = case when w ? 'selected_option_id' then (w ->> 'selected_option_id')::uuid else s.selected_option_id end,
      package_id = case when w ? 'package_id' then (w ->> 'package_id')::uuid else s.package_id end,
      status = case when w ? 'status' then w ->> 'status' else s.status end,
      selected_at = case when w ? 'selected_at' then (w ->> 'selected_at')::timestamptz else s.selected_at end,
      selected_by_contact_id = case when w ? 'selected_by_contact_id' then (w ->> 'selected_by_contact_id')::uuid else s.selected_by_contact_id end,
      price_cents_snapshot = case when w ? 'price_cents_snapshot' then (w ->> 'price_cents_snapshot')::integer else s.price_cents_snapshot end,
      cost_cents_snapshot = case when w ? 'cost_cents_snapshot' then (w ->> 'cost_cents_snapshot')::integer else s.cost_cents_snapshot end,
      confirmed_at = case when w ? 'confirmed_at' then (w ->> 'confirmed_at')::timestamptz else s.confirmed_at end,
      source_change_order_id = case when w ? 'source_change_order_id' then (w ->> 'source_change_order_id')::uuid else s.source_change_order_id end,
      metadata = s.metadata || coalesce(w -> 'metadata', '{}'::jsonb)
    where s.org_id = p_org_id
      and s.project_id = p_project_id
      and s.id = (w ->> 'id')::uuid;
    get diagnostics touched = row_count;
    if touched <> 1 then
      raise exception 'Selection % is not on this home', w ->> 'id' using errcode = 'P0002';
    end if;
    total := total + 1;
  end loop;

  return total;
end;
$$;

revoke all on function public.apply_project_selection_writes(uuid, uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.apply_project_selection_writes(uuid, uuid, jsonb, text, text) to service_role;
