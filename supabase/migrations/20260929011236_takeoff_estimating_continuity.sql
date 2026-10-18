-- Atomic quantity application to an unissued change. Server-only after project authorization.
create or replace function public.apply_change_order_measurements(
  p_org_id uuid, p_change_id uuid, p_updated_at timestamptz, p_actor_id uuid,
  p_snapshot jsonb, p_updates jsonb
) returns void language plpgsql security invoker set search_path = '' as $$
declare
  v_change public.change_orders%rowtype;
  v_snapshot jsonb;
  v_update jsonb;
  v_line public.change_order_lines%rowtype;
  v_subtotal bigint; v_taxable bigint; v_allowance bigint; v_tax bigint; v_markup bigint; v_cost bigint;
  v_tax_rate numeric; v_markup_percent numeric; v_totals jsonb; v_lines jsonb;
  v_sort integer;
begin
  if p_actor_id is null then raise exception 'Actor is required'; end if;
  if current_user <> 'service_role' and (public.has_org_permission(p_org_id, 'takeoff.write') is not true or public.has_org_permission(p_org_id, 'change_order.write') is not true) then
    raise exception 'Permission denied';
  end if;
  if jsonb_typeof(p_updates) is distinct from 'array' or jsonb_array_length(p_updates) not between 1 and 200 then
    raise exception 'Invalid measurement batch';
  end if;
  select * into v_change from public.change_orders where id = p_change_id and org_id = p_org_id for update;
  if not found then raise exception 'Change order not found'; end if;
  if coalesce(v_change.lifecycle, 'draft') not in ('draft', 'pricing') or v_change.status <> 'draft' or coalesce(v_change.client_visible, false) then
    raise exception 'Only unissued draft changes can receive measured quantities';
  end if;
  if v_change.updated_at is distinct from p_updated_at then raise exception 'The change order changed. Reopen the quantity review.' using errcode = '40001'; end if;
  perform id from public.change_order_lines where change_order_id = p_change_id and org_id = p_org_id for update;
  select coalesce(jsonb_agg(to_jsonb(l) order by l.id), '[]'::jsonb) into v_snapshot from public.change_order_lines l where l.change_order_id = p_change_id and l.org_id = p_org_id;
  if v_snapshot <> (select coalesce(jsonb_agg(to_jsonb(l) order by l.id), '[]'::jsonb) from jsonb_populate_recordset(null::public.change_order_lines, p_snapshot) l) then raise exception 'Change-order scope changed. Reopen the quantity review.' using errcode = '40001'; end if;
  select coalesce(max(sort_order), -1) + 1 into v_sort from public.change_order_lines where change_order_id = p_change_id and org_id = p_org_id;
  for v_update in select value from jsonb_array_elements(p_updates) loop
    if not exists(select 1 from public.takeoff_conditions where id = (v_update->>'condition_id')::uuid and org_id = p_org_id and project_id = v_change.project_id) then raise exception 'Measurement belongs to another project'; end if;
    if v_update->>'cost_code_id' is not null and not exists(select 1 from public.cost_codes where id = (v_update->>'cost_code_id')::uuid and org_id = p_org_id) then raise exception 'Cost code belongs to another workspace'; end if;
    if (v_update->>'quantity')::numeric <= 0 or (v_update->>'quantity')::numeric > 100000000 then raise exception 'Invalid quantity'; end if;
    select * into v_line from public.change_order_lines where id = (v_update->>'id')::uuid and change_order_id = p_change_id and org_id = p_org_id;
    if found then
      if v_line.metadata->'takeoff'->>'condition_id' is distinct from v_update->>'condition_id' then raise exception 'Measurement link changed'; end if;
      if v_line.commitment_change_order_id is not null then raise exception 'Linked trade cost must be reviewed separately'; end if;
      update public.change_order_lines set quantity = (v_update->>'quantity')::numeric, unit = v_update->>'unit', metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('takeoff', v_update->'metadata'->'takeoff') where id = v_line.id and org_id = p_org_id;
    else
      insert into public.change_order_lines(id, org_id, change_order_id, description, quantity, unit, unit_cost_cents, cost_code_id, sort_order, metadata)
      values ((v_update->>'id')::uuid, p_org_id, p_change_id, v_update->>'description', (v_update->>'quantity')::numeric, v_update->>'unit', (v_update->>'unit_cost_cents')::integer, (v_update->>'cost_code_id')::uuid, v_sort, v_update->'metadata');
      v_sort := v_sort + 1;
    end if;
  end loop;
  -- Update the financial metadata used by later approval/budget paths as well.
  update public.change_order_lines set
    gmp_delta_cents = case gmp_impact when 'increase_gmp' then abs(round(quantity * unit_cost_cents + coalesce((metadata->>'allowance_cents')::numeric, 0))) when 'decrease_gmp' then -abs(round(quantity * unit_cost_cents + coalesce((metadata->>'allowance_cents')::numeric, 0))) else 0 end,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('budget_revision_cents', coalesce(internal_cost_cents, round(quantity * unit_cost_cents + coalesce((metadata->>'allowance_cents')::numeric, 0))))
  where change_order_id = p_change_id and org_id = p_org_id;
  update public.change_order_lines set metadata = metadata || jsonb_build_object('gmp_delta_cents', gmp_delta_cents) where change_order_id = p_change_id and org_id = p_org_id;
  select coalesce(sum(round(quantity * unit_cost_cents + coalesce((metadata->>'allowance_cents')::numeric, 0))), 0),
    coalesce(sum(case when metadata->>'taxable' = 'false' then 0 else round(quantity * unit_cost_cents + coalesce((metadata->>'allowance_cents')::numeric, 0)) end), 0),
    coalesce(sum(coalesce((metadata->>'allowance_cents')::numeric, 0)), 0), sum(internal_cost_cents),
    coalesce(jsonb_agg(to_jsonb(l) || coalesce(l.metadata, '{}'::jsonb) order by sort_order, id), '[]'::jsonb)
  into v_subtotal, v_taxable, v_allowance, v_cost, v_lines from public.change_order_lines l where change_order_id = p_change_id and org_id = p_org_id;
  v_tax_rate := coalesce((v_change.metadata->>'tax_rate')::numeric, 0);
  v_markup_percent := case when v_change.markup_mode = 'percent' and v_cost is not null then 0 else coalesce((v_change.metadata->>'markup_percent')::numeric, 0) end;
  v_tax := round(v_taxable * v_tax_rate / 100); v_markup := round(v_subtotal * v_markup_percent / 100);
  v_totals := jsonb_build_object('subtotal_cents', v_subtotal, 'tax_cents', v_tax, 'markup_cents', v_markup, 'allowance_cents', v_allowance, 'total_cents', v_subtotal + v_tax + v_markup, 'tax_rate', v_tax_rate, 'markup_percent', v_markup_percent);
  update public.change_orders set total_cents = v_subtotal + v_tax + v_markup, cost_total_cents = v_cost, updated_at = clock_timestamp(),
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('lines', v_lines, 'totals', v_totals, 'updated_by', p_actor_id)
  where id = p_change_id and org_id = p_org_id;
end;
$$;
revoke all on function public.apply_change_order_measurements(uuid, uuid, timestamptz, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.apply_change_order_measurements(uuid, uuid, timestamptz, uuid, jsonb, jsonb) to service_role;
