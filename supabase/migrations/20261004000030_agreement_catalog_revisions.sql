-- STAGED / UNAPPLIED. Catalog definition fence for atomic purchase agreements.
-- All source writes advance the revision in their own transaction. Sale commits
-- key-lock referenced catalog parents first, then use a shared revision lock
-- and plain MVCC definition reads (avoids row -> revision lock inversion).
-- Organization-wide invalidation is conservative; measure contention and quote
-- refresh frequency before activation and partition if enterprise evidence requires it.
create table public.agreement_catalog_revisions (
 org_id uuid primary key references public.orgs(id) on delete cascade,
 revision bigint not null default 1 check(revision>0)
);
alter table public.agreement_catalog_revisions enable row level security;
revoke all on public.agreement_catalog_revisions from public,anon,authenticated,service_role;
grant select on public.agreement_catalog_revisions to authenticated,service_role;
create policy agreement_catalog_revision_org_read on public.agreement_catalog_revisions for select to authenticated
 using(public.is_org_member(org_id));
insert into public.agreement_catalog_revisions(org_id) select id from public.orgs;

create function public.initialize_agreement_catalog_revision() returns trigger
language plpgsql security definer set search_path='' as $$
begin insert into public.agreement_catalog_revisions(org_id) values(new.id); return new; end $$;
revoke all on function public.initialize_agreement_catalog_revision() from public,anon,authenticated,service_role;
create trigger initialize_agreement_catalog_revision after insert on public.orgs
 for each row execute function public.initialize_agreement_catalog_revision();

create function public.advance_agreement_catalog_revision() returns trigger
language plpgsql security definer set search_path='' as $$
declare old_org uuid; new_org uuid; source_org uuid;
begin
 if tg_op<>'INSERT' then old_org:=old.org_id; end if;
 if tg_op<>'DELETE' then new_org:=new.org_id; end if;
 -- A catalog record can move organizations only under its existing source policy;
 -- both tenants must invalidate, in a deterministic order.
 for source_org in select distinct x from unnest(array[old_org,new_org]) x where x is not null order by x loop
   insert into public.agreement_catalog_revisions(org_id,revision)
   select id,1 from public.orgs where id=source_org
   on conflict(org_id) do update set revision=agreement_catalog_revisions.revision+1;
 end loop;
 return null;
end $$;
revoke all on function public.advance_agreement_catalog_revision() from public,anon,authenticated,service_role;
create function public.forbid_agreement_catalog_truncate() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'Truncating agreement catalog sources bypasses revision evidence; use an approved row-level operation'; end $$;
revoke all on function public.forbid_agreement_catalog_truncate() from public,anon,authenticated,service_role;

do $$ declare source_table text; begin
 foreach source_table in array array['selection_categories','selection_options','selection_packages','selection_package_items',
  'selection_catalog_prices','selection_configuration_rules','house_plans','house_plan_versions','house_plan_elevations',
  'community_plan_availability','incentives','feature_flags','communities'] loop
  execute format('create trigger agreement_catalog_revision after insert or update or delete on public.%I for each row execute function public.advance_agreement_catalog_revision()',source_table);
  execute format('create trigger agreement_catalog_no_truncate before truncate on public.%I for each statement execute function public.forbid_agreement_catalog_truncate()',source_table);
 end loop;
end $$;

create function public.assert_agreement_catalog_revision(p_org_id uuid,p_expected text) returns void
language plpgsql security definer set search_path='' as $$
declare current_revision bigint;
begin
 if p_expected is null or p_expected !~ '^[1-9][0-9]{0,18}$' then raise exception 'Verified catalog revision required'; end if;
 select revision into current_revision from public.agreement_catalog_revisions where org_id=p_org_id for share;
 if not found then raise exception 'Agreement catalog revision is unavailable'; end if;
 if current_revision::text is distinct from p_expected then
  raise exception 'Agreement catalog changed; review a fresh quote' using detail='AGREEMENT_QUOTE_CHANGED';
 end if;
end $$;
revoke all on function public.assert_agreement_catalog_revision(uuid,text) from public,anon,authenticated,service_role;
