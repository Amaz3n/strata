-- A company may be an AP payee without being a construction trade partner.
-- The existing `vendor` role was contact-only, which forced company payees into
-- `subcontractor` or `supplier` and activated irrelevant construction posture.

update public.directory_relationship_types
set applies_to = 'both',
    label = 'Vendor'
where key = 'vendor'
  and is_system = true;

-- Org provisioning inserts the base taxonomy after migrations have run. Keep
-- future orgs on the same contract even if that seed still carries the former
-- contact-only value.
create or replace function public.tg_generic_vendor_role_applies_to_both()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.is_system and new.key = 'vendor' then
    new.applies_to := 'both';
  end if;
  return new;
end;
$$;

drop trigger if exists generic_vendor_role_applies_to_both
  on public.directory_relationship_types;

create trigger generic_vendor_role_applies_to_both
  before insert or update on public.directory_relationship_types
  for each row execute function public.tg_generic_vendor_role_applies_to_both();

revoke execute on function public.tg_generic_vendor_role_applies_to_both() from public;
revoke execute on function public.tg_generic_vendor_role_applies_to_both() from anon;
revoke execute on function public.tg_generic_vendor_role_applies_to_both() from authenticated;

comment on column public.party_roles.relationship_type_id is
  'Org relationship vocabulary. The generic vendor role means AP payee; subcontractor and supplier are construction-facing roles. Project participation remains in project_vendors.';
