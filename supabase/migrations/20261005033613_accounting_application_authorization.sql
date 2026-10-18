-- Deploy the authorized server administration paths before applying this SQL.
-- Application sessions retain metadata reads; all writes use an authorized
-- server service client. Reassignment fails closed until this SQL installs the
-- count RPC; metadata/admin paths can deploy first. An old-app rollback must
-- retain these restricted grants, never restore broad authenticated writes.
-- This migration is additive and does not run D2 cleanup.
set lock_timeout = '5s';
set statement_timeout = '120s';

-- Table privileges and column privileges are independent in PostgreSQL.
-- Clear both, including grants on optional pre-D2 credential columns and views.
do $$
declare relation_name text; columns_sql text;
begin
  foreach relation_name in array array['accounting_connections','accounting_entity_map','accounting_sync_records','qbo_connections','qbo_sync_records','qbo_connections_legacy'] loop
    if to_regclass('public.' || relation_name) is null then continue; end if;
    execute format('revoke all privileges on table public.%I from public, anon, authenticated', relation_name);
    select string_agg(quote_ident(attname), ',') into columns_sql
      from pg_attribute where attrelid=to_regclass('public.' || relation_name) and attnum>0 and not attisdropped;
    if columns_sql is not null then
      execute format('revoke select (%s), insert (%s), update (%s), references (%s) on table public.%I from public, anon, authenticated', columns_sql, columns_sql, columns_sql, columns_sql, relation_name);
    end if;
  end loop;
end $$;

-- Explicit reviewed metadata only: no table SELECT that could expose a future
-- secret column. Lifecycle/health fields support existing metadata DTO callers.
grant select (id,org_id,provider,label,external_account_id,external_account_name,
  status,connected_at,disconnected_at,last_sync_at,last_error,token_expires_at,
  refresh_token_expires_at,refresh_failure_count,settings)
  on public.accounting_connections to authenticated;
grant select on public.accounting_entity_map, public.accounting_sync_records to authenticated;

drop policy if exists accounting_connections_org_access on public.accounting_connections;
create policy accounting_connections_org_access on public.accounting_connections
  for select to authenticated using (public.is_org_member(org_id));
drop policy if exists accounting_entity_map_org_access on public.accounting_entity_map;
create policy accounting_entity_map_org_access on public.accounting_entity_map
  for select to authenticated using (public.is_org_member(org_id));
-- The policy retains its original name after the qbo table rename. Other
-- division/read policies are deliberately preserved.
drop policy if exists qbo_sync_records_access on public.accounting_sync_records;
create policy qbo_sync_records_access on public.accounting_sync_records
  for select to authenticated using (public.is_org_member(org_id));

-- Keep internal mutation RPCs server-only, across deployed overloads. Some
-- compatibility functions may already be absent following D2 cleanup.
do $$
declare routine record;
begin
  for routine in select p.oid::regprocedure signature from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=any(array[
      'accounting_claim_sync_create','qbo_claim_sync_create','update_qbo_cdc_cursor',
      'claim_accounting_delivery','release_accounting_delivery','persist_accounting_delivery',
      'accounting_claim_import','accounting_finish_import','accounting_persist_import_row',
      'accounting_persist_import_children','accounting_adopt_import_identity'
    ])
  loop
    execute format('revoke all privileges on function %s from public, anon, authenticated', routine.signature);
    execute format('grant execute on function %s to service_role', routine.signature);
  end loop;
end $$;

-- Reassignment acknowledgement must inspect the complete scope. PostgREST
-- arrays can be capped at 1,000 rows; this aggregate never exports identity lists.
create or replace function public.accounting_count_synced_scope(
  p_org_id uuid, p_connection_id uuid, p_project_id uuid default null,
  p_division_id uuid default null, p_community_id uuid default null
) returns bigint language plpgsql stable security definer
set search_path = public, pg_temp as $$
declare result bigint;
begin
  if p_org_id is null or p_connection_id is null or not exists (
    select 1 from public.accounting_connections c where c.id=p_connection_id and c.org_id=p_org_id
  ) then raise exception 'Accounting connection must belong to the organization'; end if;
  if num_nonnulls(p_project_id,p_division_id,p_community_id)>1 then
    raise exception 'Choose one accounting mapping scope';
  end if;
  if (p_project_id is not null and not exists(select 1 from public.projects p where p.id=p_project_id and p.org_id=p_org_id))
    or (p_division_id is not null and not exists(select 1 from public.divisions d where d.id=p_division_id and d.org_id=p_org_id))
    or (p_community_id is not null and not exists(select 1 from public.communities c where c.id=p_community_id and c.org_id=p_org_id)) then
    raise exception 'Accounting mapping scope must belong to the organization';
  end if;
  if num_nonnulls(p_project_id,p_division_id,p_community_id)=0 then
    select count(*) into result from public.accounting_sync_records s
      where s.org_id=p_org_id and s.connection_id=p_connection_id and s.external_id<>'';
    return result;
  end if;
  with scoped_projects as (
    select p.id from public.projects p where p.org_id=p_org_id and (
      p.id=p_project_id
      or (p_division_id is not null and p.division_id=p_division_id and p.phase='delivery')
      or (p_community_id is not null and exists(select 1 from public.lots l
        where l.org_id=p_org_id and l.community_id=p_community_id and l.project_id=p.id))
    )
  )
  select count(*) into result from public.accounting_sync_records s
    where s.org_id=p_org_id and s.connection_id=p_connection_id and s.external_id<>'' and (
      exists(select 1 from public.invoices i join scoped_projects p on p.id=i.project_id where i.org_id=p_org_id and i.id=s.entity_id)
      or exists(select 1 from public.project_expenses e join scoped_projects p on p.id=e.project_id where e.org_id=p_org_id and e.id=s.entity_id)
      or exists(select 1 from public.vendor_bills b join scoped_projects p on p.id=b.project_id where b.org_id=p_org_id and b.id=s.entity_id)
      or exists(select 1 from public.payments y join scoped_projects p on p.id=y.project_id where y.org_id=p_org_id and y.id=s.entity_id)
    );
  return result;
end $$;
revoke all on function public.accounting_count_synced_scope(uuid,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.accounting_count_synced_scope(uuid,uuid,uuid,uuid,uuid) to service_role;
