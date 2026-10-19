-- The deal proposal: what the builder writes around the price.
--
-- It lives beside the pricing worksheet, not inside the brief, with its own
-- optimistic version: editing the cover letter must never conflict with the
-- worksheet's autosave, and the other way round.
begin;

alter table public.precon_workspaces
  add column proposal jsonb not null default '{}'::jsonb,
  add column proposal_version integer not null default 0;

alter table public.precon_workspaces
  add constraint precon_workspaces_proposal_object check (jsonb_typeof(proposal) = 'object');

-- Each signer gets a link of their own. A link without a signer is the primary
-- client's (every link issued before this change).
alter table public.estimate_review_links
  add column signer_name text,
  add column signer_email text;

alter table public.estimate_review_links
  add constraint estimate_review_links_signer_pair
  check ((signer_email is null) = (signer_name is null));

create index estimate_review_links_signer_idx
  on public.estimate_review_links(org_id, estimate_id, signer_email);

-- "Save as my default" writes one proposal template field at a time.
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
  if p_actor_id is null or p_section is null or p_section not in ('organization', 'invoicing', 'proposal')
    or jsonb_typeof(p_org_patch) is distinct from 'object'
    or jsonb_typeof(p_settings_patch) is distinct from 'object' then
    raise exception 'Invalid settings input';
  end if;
  v_allowed := case when p_section = 'invoicing' then array['invoice_default_payment_terms_days', 'invoice_default_payment_details']
    when p_section = 'proposal' then array['estimate_intro_template', 'proposal_terms_template', 'proposal_allowance_policy',
      'proposal_inclusions', 'proposal_exclusions', 'proposal_payment_schedule', 'proposal_sections']
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

commit;
