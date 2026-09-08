-- Apply before deploying the settings service. No network calls inside either RPC.
begin;

-- Preserve the previous effective value once, then retire the legacy key.
update public.org_settings
set settings = (settings - 'invoice_default_note') || jsonb_build_object(
  'invoice_default_payment_details', coalesce(settings ->> 'invoice_default_payment_details', settings ->> 'invoice_default_note', '')
), updated_at = now()
where settings ? 'invoice_default_note';

create or replace function public.save_organization_settings(
  p_org_id uuid, p_actor_id uuid, p_section text, p_org_patch jsonb, p_settings_patch jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_org public.orgs%rowtype;
  v_before_org jsonb;
  v_before_settings jsonb;
  v_settings jsonb;
  v_result jsonb;
  v_allowed text[];
begin
  if p_actor_id is null or p_section is null or p_section not in ('organization', 'invoicing')
    or jsonb_typeof(p_org_patch) is distinct from 'object'
    or jsonb_typeof(p_settings_patch) is distinct from 'object' then
    raise exception 'Invalid settings input';
  end if;
  v_allowed := case when p_section = 'invoicing' then array['invoice_default_payment_terms_days', 'invoice_default_payment_details']
    else array['proposal_terms_template', 'estimate_terms_template', 'estimate_accent_color', 'estimate_font', 'estimate_intro_template', 'estimate_builder_signer_mode', 'estimate_builder_signer_user_id'] end;
  if exists (select 1 from jsonb_object_keys(p_settings_patch) as k(key) where not (key = any(v_allowed)))
    or exists (select 1 from jsonb_object_keys(p_org_patch) as k(key) where p_section <> 'invoicing' or key not in ('billing_email', 'address')) then
    raise exception 'Unexpected settings fields';
  end if;

  select * into strict v_org from public.orgs where id = p_org_id for update;
  v_before_org := jsonb_build_object('id', v_org.id, 'name', v_org.name, 'billing_email', v_org.billing_email, 'address', v_org.address, 'logo_url', v_org.logo_url);
  insert into public.org_settings(org_id, settings) values (p_org_id, '{}') on conflict (org_id) do nothing;
  select settings into v_before_settings from public.org_settings where org_id = p_org_id for update;

  if p_settings_patch ->> 'estimate_builder_signer_mode' = 'specific_user' and not exists (
    select 1 from public.memberships where org_id = p_org_id and status = 'active'
      and user_id = nullif(p_settings_patch ->> 'estimate_builder_signer_user_id', '')::uuid
  ) then raise exception 'Builder signer must be an active organization member'; end if;

  if p_org_patch <> '{}'::jsonb then
    update public.orgs set
      billing_email = case when p_org_patch ? 'billing_email' then p_org_patch ->> 'billing_email' else billing_email end,
      address = case when p_org_patch ? 'address' then nullif(p_org_patch -> 'address', 'null'::jsonb) else address end,
      updated_at = now()
    where id = p_org_id returning * into v_org;
  end if;
  update public.org_settings set settings = (settings || p_settings_patch) - 'invoice_default_note', updated_at = now()
  where org_id = p_org_id returning settings into v_settings;

  v_result := jsonb_build_object('org', jsonb_build_object('id', v_org.id, 'name', v_org.name,
    'billing_email', v_org.billing_email, 'address', v_org.address, 'logo_url', v_org.logo_url), 'settings', v_settings);
  insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
  values (p_org_id, p_actor_id, 'update', 'org_settings', p_org_id,
    jsonb_build_object('org', v_before_org, 'settings', v_before_settings), v_result, 'settings.' || p_section);
  insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
  values (p_org_id, 'settings_updated', 'org_settings', p_org_id,
    jsonb_build_object('section', p_section, 'actor_id', p_actor_id), 'activity');
  return v_result;
end;
$$;
revoke all on function public.save_organization_settings(uuid, uuid, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_organization_settings(uuid, uuid, text, jsonb, jsonb) to service_role;

-- Auth factors are not readable by service_role. Expose ONLY a boolean, joined
-- to the requested org, through a server-only RPC; never return factor records.
-- The calling team service checks membership/authorization before invocation.
create or replace function public.get_org_member_mfa_status(p_org_id uuid, p_user_ids uuid[])
returns table(user_id uuid, enabled boolean)
language sql stable
security definer
set search_path = ''
as $$
  select distinct m.user_id, exists (
    select 1 from auth.mfa_factors f where f.user_id = m.user_id and f.status = 'verified'
  ) from public.memberships m where m.org_id = p_org_id and m.user_id = any(p_user_ids);
$$;
revoke all on function public.get_org_member_mfa_status(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.get_org_member_mfa_status(uuid, uuid[]) to service_role;

commit;
