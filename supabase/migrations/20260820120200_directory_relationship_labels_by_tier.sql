-- Role chips speak the org's own language.
--
-- `directory_relationship_types.label` is per-org and already renders directly
-- as the chip on every directory row, so tier vocabulary is a seeding question,
-- not a branching one — which is what makes this safe under the posture rules:
-- no code path forks, the same nine keys exist everywhere, and an org that has
-- renamed a label keeps its own wording.
--
-- The keys never change. Only what a human sees does:
--
--   key            residential      commercial          production
--   ------------   --------------   -----------------   --------------
--   client         Client           Owner               Buyer
--   subcontractor  Subcontractor    Trade partner       Trade partner
--   supplier       Supplier         Supplier            Supplier
--
-- Mirrors lib/terminology.ts, which supplies the same nouns to page chrome.

-- Only rows still carrying the seeded default are touched. `is_system` plus an
-- exact label match is what distinguishes "never customized" from "this builder
-- deliberately calls them something else" — renaming the latter would be Arc
-- overwriting a customer's own vocabulary.
update public.directory_relationship_types rt
set label = 'Owner'
from public.orgs o
where o.id = rt.org_id
  and o.product_tier = 'commercial'
  and rt.key = 'client'
  and rt.is_system
  and rt.label = 'Client';

update public.directory_relationship_types rt
set label = 'Buyer'
from public.orgs o
where o.id = rt.org_id
  and o.product_tier = 'production'
  and rt.key = 'client'
  and rt.is_system
  and rt.label = 'Client';

-- Commercial GCs and production builders both contract trades rather than
-- "subcontractors" in the residential sense.
update public.directory_relationship_types rt
set label = 'Trade partner'
from public.orgs o
where o.id = rt.org_id
  and o.product_tier in ('commercial', 'production')
  and rt.key = 'subcontractor'
  and rt.is_system
  and rt.label = 'Subcontractor';

-- New orgs should be born with the right vocabulary rather than waiting for a
-- migration. Provisioning seeds the base set (see the seed-repair migration);
-- this trigger renames the two tier-sensitive labels as they are inserted.
create or replace function public.tg_directory_relationship_type_tier_label()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tier text;
begin
  -- Only ever adjusts a freshly seeded system row's label; a custom label or a
  -- later rename passes through untouched.
  if not new.is_system then
    return new;
  end if;

  select product_tier into v_tier from public.orgs where id = new.org_id;
  if v_tier is null then
    return new;
  end if;

  if new.key = 'client' and new.label = 'Client' then
    if v_tier = 'commercial' then
      new.label := 'Owner';
    elsif v_tier = 'production' then
      new.label := 'Buyer';
    end if;
  elsif new.key = 'subcontractor' and new.label = 'Subcontractor' then
    if v_tier in ('commercial', 'production') then
      new.label := 'Trade partner';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.tg_directory_relationship_type_tier_label() is
  'Names newly seeded system relationship types in the org tier''s vocabulary (Client/Owner/Buyer). Mirrors lib/terminology.ts.';

drop trigger if exists directory_relationship_type_tier_label
  on public.directory_relationship_types;

create trigger directory_relationship_type_tier_label
  before insert on public.directory_relationship_types
  for each row
  execute function public.tg_directory_relationship_type_tier_label();

-- The function is SECURITY DEFINER and must not be callable as an RPC, the same
-- lockdown 20260819220019 applied to the applies_to trigger.
revoke execute on function public.tg_directory_relationship_type_tier_label() from public;
revoke execute on function public.tg_directory_relationship_type_tier_label() from anon;
revoke execute on function public.tg_directory_relationship_type_tier_label() from authenticated;
