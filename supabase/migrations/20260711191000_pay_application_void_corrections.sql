-- Correct progress-billing void behavior for retainage-release applications.
-- The original RPC only reversed pay_application_lines, but release
-- applications intentionally have no lines. Reverse their cumulative SOV
-- release allocation from the newest allocated lines before marking the app
-- void. The existing invoices_restore_retainage_on_void trigger restores the
-- retainage mirror rows when the service subsequently voids the release invoice.

-- Repair already-posted snapshots produced after contract.total_cents had been
-- revised by approved OCOs. change_order_sum_cents is itself an immutable
-- submission snapshot, so base + that snapshot restores lines 1-3 exactly once.
update public.pay_applications pa
set original_contract_sum_cents = (c.snapshot ->> 'base_total_cents')::integer,
    contract_sum_to_date_cents =
      (c.snapshot ->> 'base_total_cents')::integer + pa.change_order_sum_cents,
    balance_to_finish_cents =
      (c.snapshot ->> 'base_total_cents')::integer +
      pa.change_order_sum_cents -
      pa.total_earned_less_retainage_cents
from public.contracts c
where c.id = pa.contract_id
  and c.org_id = pa.org_id
  and pa.status <> 'draft'
  and c.snapshot ->> 'base_total_cents' ~ '^-?[0-9]+$';

create or replace function public.void_pay_application(
  p_org_id uuid,
  p_pay_application_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_app record;
  v_newer integer;
  v_invoice_status text;
  v_release_remaining integer;
  v_release_take integer;
  v_line record;
begin
  select * into v_app
  from public.pay_applications
  where id = p_pay_application_id and org_id = p_org_id
  for update;

  if not found then
    raise exception 'Pay application not found';
  end if;

  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
    and not exists (
      select 1
      from public.memberships m
      where m.org_id = p_org_id
        and m.user_id = (select auth.uid())
        and m.status = 'active'
        and (
          exists (
            select 1 from public.membership_permission_overrides mpo
            where mpo.membership_id = m.id
              and mpo.permission_key = 'payapp.write'
              and mpo.effect = 'grant'
          )
          or exists (
            select 1 from public.role_permissions rp
            where rp.role_id = m.role_id
              and rp.permission_key = 'payapp.write'
          )
        )
        and not exists (
          select 1 from public.membership_permission_overrides mpo
          where mpo.membership_id = m.id
            and mpo.permission_key = 'payapp.write'
            and mpo.effect = 'deny'
        )
        and (
          coalesce(m.project_scope::text, 'all') <> 'assigned'
          or exists (
            select 1 from public.project_members pm
            where pm.org_id = p_org_id
              and pm.project_id = v_app.project_id
              and pm.user_id = (select auth.uid())
              and pm.status = 'active'
          )
        )
    ) then
    raise exception 'Missing permission: payapp.write' using errcode = '42501';
  end if;
  if v_app.status = 'void' then
    return jsonb_build_object('pay_application_id', p_pay_application_id, 'already_void', true);
  end if;
  if v_app.status not in ('submitted', 'approved', 'invoiced') then
    raise exception 'Only submitted pay applications can be voided; delete drafts instead';
  end if;

  select count(*) into v_newer
  from public.pay_applications
  where org_id = p_org_id
    and contract_id = v_app.contract_id
    and application_number > v_app.application_number
    and status <> 'void';
  if v_newer > 0 then
    raise exception 'Only the latest pay application can be voided';
  end if;

  if v_app.invoice_id is not null then
    select status into v_invoice_status
    from public.invoices
    where id = v_app.invoice_id and org_id = p_org_id;
    if v_invoice_status in ('paid', 'partial') then
      raise exception 'The pay application invoice has payments and cannot be voided';
    end if;
  end if;

  if coalesce(v_app.metadata ->> 'type', '') = 'retainage_release' then
    v_release_remaining := coalesce((v_app.metadata ->> 'release_amount_cents')::integer, 0);
    if v_release_remaining <= 0 then
      raise exception 'Retainage release application is missing its release amount';
    end if;

    -- Releases allocate oldest SOV lines first. Because only the latest
    -- application may be voided, reversing newest allocations first restores
    -- the exact cumulative state that preceded this release.
    for v_line in
      select id, retainage_released_cents
      from public.prime_sov_lines
      where org_id = p_org_id
        and contract_id = v_app.contract_id
        and retainage_released_cents > 0
      order by line_number desc
      for update
    loop
      exit when v_release_remaining <= 0;
      v_release_take := least(v_release_remaining, v_line.retainage_released_cents);
      update public.prime_sov_lines
      set retainage_released_cents = retainage_released_cents - v_release_take
      where id = v_line.id and org_id = p_org_id;
      v_release_remaining := v_release_remaining - v_release_take;
    end loop;

    if v_release_remaining <> 0 then
      raise exception 'Retainage release allocation is inconsistent (% cents missing)', v_release_remaining;
    end if;
  else
    update public.prime_sov_lines s
    set previous_billed_cents = s.previous_billed_cents - l.this_period_cents,
        stored_materials_cents = coalesce((l.metadata->>'previous_stored_materials_cents')::integer, s.stored_materials_cents),
        retainage_held_cents = s.retainage_held_cents - l.retainage_cents
    from public.pay_application_lines l
    where l.pay_application_id = p_pay_application_id
      and l.org_id = p_org_id
      and s.id = l.prime_sov_line_id
      and s.org_id = p_org_id;
  end if;

  update public.pay_applications
  set status = 'void'
  where id = p_pay_application_id and org_id = p_org_id;

  return jsonb_build_object(
    'pay_application_id', p_pay_application_id,
    'invoice_id', v_app.invoice_id,
    'retainage_release_reversed', coalesce(v_app.metadata ->> 'type', '') = 'retainage_release'
  );
end;
$$;

revoke all on function public.void_pay_application(uuid, uuid) from public, anon, authenticated;
grant execute on function public.void_pay_application(uuid, uuid) to authenticated, service_role;

-- Atomically void an approved owner change order and every financial effect
-- created by approval. Any validation or write failure rolls the entire
-- statement back, preventing lifecycle, SOV, budget, contract, and draw drift.
create or replace function public.void_approved_change_order_atomic(
  p_org_id uuid,
  p_change_order_id uuid,
  p_actor_id uuid,
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_co public.change_orders%rowtype;
  v_contract public.contracts%rowtype;
  v_now timestamptz := now();
  v_approved_total bigint := 0;
  v_approved_gmp_delta bigint := 0;
  v_base_total bigint;
  v_revised_total bigint;
  v_base_gmp bigint;
  v_revised_gmp bigint;
begin
  select * into v_co
  from public.change_orders
  where id = p_change_order_id and org_id = p_org_id
  for update;

  if not found then
    raise exception 'Change order not found';
  end if;

  if p_actor_id is distinct from (select auth.uid())
    and coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'Actor does not match authenticated user' using errcode = '42501';
  end if;

  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
    and not exists (
      select 1
      from public.memberships m
      where m.org_id = p_org_id
        and m.user_id = (select auth.uid())
        and m.status = 'active'
        and (
          exists (
            select 1 from public.membership_permission_overrides mpo
            where mpo.membership_id = m.id
              and mpo.permission_key = 'change_order.approve'
              and mpo.effect = 'grant'
          )
          or exists (
            select 1 from public.role_permissions rp
            where rp.role_id = m.role_id
              and rp.permission_key = 'change_order.approve'
          )
        )
        and not exists (
          select 1 from public.membership_permission_overrides mpo
          where mpo.membership_id = m.id
            and mpo.permission_key = 'change_order.approve'
            and mpo.effect = 'deny'
        )
        and (
          coalesce(m.project_scope::text, 'all') <> 'assigned'
          or exists (
            select 1 from public.project_members pm
            where pm.org_id = p_org_id
              and pm.project_id = v_co.project_id
              and pm.user_id = (select auth.uid())
              and pm.status = 'active'
          )
        )
    ) then
    raise exception 'Missing permission: change_order.approve' using errcode = '42501';
  end if;

  if v_co.lifecycle not in ('approved', 'void') then
    raise exception 'Only an approved change order can use the atomic financial reversal';
  end if;

  if exists (
    select 1 from public.invoices i
    where i.org_id = p_org_id
      and i.metadata ->> 'source_change_order_id' = p_change_order_id::text
      and i.status <> 'void'
  ) then
    raise exception 'This change order has a non-void invoice';
  end if;

  if exists (
    select 1 from public.prime_sov_lines s
    where s.org_id = p_org_id
      and s.metadata ->> 'source_change_order_id' = p_change_order_id::text
      and (
        s.previous_billed_cents <> 0
        or s.stored_materials_cents <> 0
        or s.retainage_held_cents <> 0
        or s.retainage_released_cents <> 0
      )
  ) then
    raise exception 'This change order has pay-application activity';
  end if;

  if exists (
    select 1
    from public.pay_application_lines pal
    join public.prime_sov_lines s
      on s.id = pal.prime_sov_line_id and s.org_id = p_org_id
    join public.pay_applications pa
      on pa.id = pal.pay_application_id and pa.org_id = p_org_id
    where pal.org_id = p_org_id
      and s.metadata ->> 'source_change_order_id' = p_change_order_id::text
      and pa.status not in ('draft', 'void')
  ) then
    raise exception 'This change order appears on a posted pay application';
  end if;

  update public.change_orders
  set status = 'cancelled',
      lifecycle = 'void',
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'voided_at', v_now,
        'voided_by', p_actor_id,
        'void_reason', p_reason,
        'financial_impact', coalesce(metadata -> 'financial_impact', '{}'::jsonb) ||
          jsonb_build_object('reversed_at', v_now)
      )
  where id = p_change_order_id and org_id = p_org_id;

  update public.budget_revisions
  set status = 'voided',
      metadata = coalesce(metadata, '{}'::jsonb) ||
        jsonb_build_object('voided_at', v_now, 'voided_by', p_actor_id)
  where org_id = p_org_id
    and change_order_id = p_change_order_id
    and status = 'posted';

  delete from public.pay_application_lines pal
  using public.prime_sov_lines s, public.pay_applications pa
  where pal.org_id = p_org_id
    and s.id = pal.prime_sov_line_id
    and s.org_id = p_org_id
    and s.metadata ->> 'source_change_order_id' = p_change_order_id::text
    and pa.id = pal.pay_application_id
    and pa.org_id = p_org_id
    and pa.status in ('draft', 'void');

  delete from public.prime_sov_lines s
  where s.org_id = p_org_id
    and s.metadata ->> 'source_change_order_id' = p_change_order_id::text;

  select * into v_contract
  from public.contracts
  where org_id = p_org_id
    and project_id = v_co.project_id
    and status = 'active'
  order by created_at desc
  limit 1
  for update;

  if found then
    select
      coalesce(sum(co.total_cents), 0),
      coalesce(sum(coalesce((co.metadata -> 'financial_impact' ->> 'gmp_delta_cents')::bigint, 0)), 0)
    into v_approved_total, v_approved_gmp_delta
    from public.change_orders co
    where co.org_id = p_org_id
      and co.project_id = v_co.project_id
      and co.lifecycle = 'approved';

    v_base_total := coalesce((v_contract.snapshot ->> 'base_total_cents')::bigint, v_contract.total_cents, 0);
    v_revised_total := v_base_total + v_approved_total;
    v_base_gmp := coalesce((v_contract.snapshot ->> 'base_gmp_cents')::bigint, v_contract.gmp_cents, 0);
    v_revised_gmp := greatest(0, v_base_gmp + v_approved_gmp_delta);

    update public.contracts
    set total_cents = v_revised_total,
        snapshot = coalesce(snapshot, '{}'::jsonb) || jsonb_build_object(
          'base_total_cents', v_base_total,
          'approved_change_orders_cents', v_approved_total,
          'revised_total_cents', v_revised_total,
          'base_gmp_cents', v_base_gmp,
          'approved_gmp_change_orders_cents', v_approved_gmp_delta,
          'revised_gmp_cents', v_revised_gmp
        )
    where id = v_contract.id and org_id = p_org_id;

    update public.draw_schedules
    set amount_cents = round(v_revised_total * percent_of_contract / 100.0)
    where org_id = p_org_id
      and project_id = v_co.project_id
      and status = 'pending'
      and percent_of_contract is not null;
  end if;

  return jsonb_build_object(
    'change_order_id', p_change_order_id,
    'project_id', v_co.project_id,
    'already_void', v_co.lifecycle = 'void',
    'contract_total_cents', case when v_contract.id is null then null else v_revised_total end
  );
end;
$$;

revoke all on function public.void_approved_change_order_atomic(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.void_approved_change_order_atomic(uuid, uuid, uuid, text)
  to authenticated, service_role;
