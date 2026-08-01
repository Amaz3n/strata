-- Version AP fee policies instead of editing pricing history in place.
-- These functions are service-role only; application actions separately require
-- the platform.billing.manage permission before invoking them.

create or replace function public.replace_payment_fee_policy_atomic(
  p_org_id uuid,
  p_pass_through_processor_fees boolean,
  p_processor_fee_bps integer,
  p_processor_fee_fixed_cents bigint,
  p_processor_fee_cap_cents bigint,
  p_ap_platform_fee_flat_cents bigint,
  p_ap_platform_fee_bps integer,
  p_actor_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.payment_fee_policies%rowtype;
  v_effective_from timestamptz := clock_timestamp();
  v_policy_id uuid;
  v_pricing_model text;
begin
  if p_actor_id is null then
    raise exception 'An actor is required';
  end if;

  if p_processor_fee_bps is not null and (p_processor_fee_bps < 0 or p_processor_fee_bps > 10000) then
    raise exception 'Processor fee rate must be between 0 and 10000 basis points';
  end if;
  if p_processor_fee_fixed_cents is not null and p_processor_fee_fixed_cents < 0 then
    raise exception 'Processor fixed fee cannot be negative';
  end if;
  if p_processor_fee_cap_cents is not null and p_processor_fee_cap_cents < 0 then
    raise exception 'Processor fee cap cannot be negative';
  end if;
  if p_ap_platform_fee_flat_cents < 0 then
    raise exception 'Arc flat fee cannot be negative';
  end if;
  if p_ap_platform_fee_bps < 0 or p_ap_platform_fee_bps > 10000 then
    raise exception 'Arc fee rate must be between 0 and 10000 basis points';
  end if;
  if p_pass_through_processor_fees
    and p_processor_fee_bps is null
    and p_processor_fee_fixed_cents is null then
    raise exception 'Enter a processor percentage, fixed fee, or both when pass-through is enabled';
  end if;

  -- One lock namespace per scope prevents concurrent writers from racing the
  -- partial unique index while preserving parallel writes for different orgs.
  perform pg_advisory_xact_lock(hashtextextended('payment_fee_policy:' || coalesce(p_org_id::text, 'platform'), 0));

  select *
  into v_existing
  from public.payment_fee_policies
  where org_id is not distinct from p_org_id
    and effective_to is null
  for update;

  if found then
    v_effective_from := greatest(v_effective_from, v_existing.effective_from + interval '1 microsecond');
    update public.payment_fee_policies
    set effective_to = v_effective_from
    where id = v_existing.id;
  end if;

  v_pricing_model := case
    when p_ap_platform_fee_flat_cents = 0 and p_ap_platform_fee_bps = 0
      then 'subscription_plus_pass_through'
    else 'custom'
  end;

  insert into public.payment_fee_policies (
    org_id,
    pricing_model,
    pass_through_processor_fees,
    processor_fee_bps,
    processor_fee_fixed_cents,
    processor_fee_cap_cents,
    ap_platform_fee_flat_cents,
    ap_platform_fee_bps,
    effective_from,
    created_by
  ) values (
    p_org_id,
    v_pricing_model,
    p_pass_through_processor_fees,
    case when p_pass_through_processor_fees then p_processor_fee_bps else null end,
    case when p_pass_through_processor_fees then p_processor_fee_fixed_cents else null end,
    case when p_pass_through_processor_fees then p_processor_fee_cap_cents else null end,
    p_ap_platform_fee_flat_cents,
    p_ap_platform_fee_bps,
    v_effective_from,
    p_actor_id
  )
  returning id into v_policy_id;

  insert into public.authorization_audit_log (
    actor_user_id,
    org_id,
    action_key,
    resource_type,
    resource_id,
    decision,
    reason_code,
    policy_version,
    context
  ) values (
    p_actor_id,
    p_org_id,
    'platform.payment_fees.replace',
    'payment_fee_policy',
    v_policy_id::text,
    'allow',
    'platform_billing_admin',
    'payment_fee_policy_v1',
    jsonb_build_object(
      'scope', case when p_org_id is null then 'platform' else 'organization' end,
      'replaces_policy_id', v_existing.id,
      'pricing_model', v_pricing_model,
      'pass_through_processor_fees', p_pass_through_processor_fees,
      'processor_fee_bps', case when p_pass_through_processor_fees then p_processor_fee_bps else null end,
      'processor_fee_fixed_cents', case when p_pass_through_processor_fees then p_processor_fee_fixed_cents else null end,
      'processor_fee_cap_cents', case when p_pass_through_processor_fees then p_processor_fee_cap_cents else null end,
      'ap_platform_fee_flat_cents', p_ap_platform_fee_flat_cents,
      'ap_platform_fee_bps', p_ap_platform_fee_bps
    )
  );

  return v_policy_id;
end;
$$;

create or replace function public.retire_org_payment_fee_policy_atomic(
  p_org_id uuid,
  p_actor_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.payment_fee_policies%rowtype;
  v_effective_to timestamptz := clock_timestamp();
begin
  if p_org_id is null then
    raise exception 'Only organization overrides can be retired';
  end if;
  if p_actor_id is null then
    raise exception 'An actor is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('payment_fee_policy:' || p_org_id::text, 0));

  select *
  into v_existing
  from public.payment_fee_policies
  where org_id = p_org_id
    and effective_to is null
  for update;

  if not found then
    raise exception 'No active organization fee override exists';
  end if;

  v_effective_to := greatest(v_effective_to, v_existing.effective_from + interval '1 microsecond');
  update public.payment_fee_policies
  set effective_to = v_effective_to
  where id = v_existing.id;

  insert into public.authorization_audit_log (
    actor_user_id,
    org_id,
    action_key,
    resource_type,
    resource_id,
    decision,
    reason_code,
    policy_version,
    context
  ) values (
    p_actor_id,
    p_org_id,
    'platform.payment_fees.retire_override',
    'payment_fee_policy',
    v_existing.id::text,
    'allow',
    'platform_billing_admin',
    'payment_fee_policy_v1',
    jsonb_build_object('fallback', 'platform_default', 'effective_to', v_effective_to)
  );

  return v_existing.id;
end;
$$;

revoke all on function public.replace_payment_fee_policy_atomic(uuid, boolean, integer, bigint, bigint, bigint, integer, uuid) from public, anon, authenticated;
grant execute on function public.replace_payment_fee_policy_atomic(uuid, boolean, integer, bigint, bigint, bigint, integer, uuid) to service_role;

revoke all on function public.retire_org_payment_fee_policy_atomic(uuid, uuid) from public, anon, authenticated;
grant execute on function public.retire_org_payment_fee_policy_atomic(uuid, uuid) to service_role;
