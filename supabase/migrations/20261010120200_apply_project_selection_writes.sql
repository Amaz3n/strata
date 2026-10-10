-- Several selection rows on one home, written in one transaction.
--
-- Applying a design package and applying a selection change order each touch
-- several `project_selections` rows. They were written one UPDATE at a time,
-- so a failure partway left the home with half a package, or a change order
-- that had flipped some selections and not others — with the variance orders
-- for the trade side never created. The service validates and prices every
-- row first, then hands the whole set here.
--
-- Each write names the selection and the values it lands on (set-to-target,
-- so a retry is harmless). `confirmed_at` and `source_change_order_id` change
-- only when the write carries them; `metadata` is merged, never replaced, so
-- the signing evidence on a selection survives a package apply. A write that
-- does not match exactly one selection on this home aborts the whole set.

create or replace function public.apply_project_selection_writes(
  p_org_id uuid,
  p_project_id uuid,
  p_writes jsonb
)
returns integer
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  w jsonb;
  touched integer;
  total integer := 0;
begin
  if jsonb_typeof(p_writes) is distinct from 'array' or jsonb_array_length(p_writes) = 0 then
    raise exception 'No selection writes to apply' using errcode = '22023';
  end if;

  for w in select value from jsonb_array_elements(p_writes) loop
    update public.project_selections s set
      selected_option_id = (w ->> 'selected_option_id')::uuid,
      package_id = (w ->> 'package_id')::uuid,
      status = w ->> 'status',
      selected_at = (w ->> 'selected_at')::timestamptz,
      selected_by_contact_id = (w ->> 'selected_by_contact_id')::uuid,
      price_cents_snapshot = (w ->> 'price_cents_snapshot')::integer,
      cost_cents_snapshot = (w ->> 'cost_cents_snapshot')::integer,
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

revoke all on function public.apply_project_selection_writes(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apply_project_selection_writes(uuid, uuid, jsonb) to service_role;
