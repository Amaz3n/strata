-- Evaluate the actual winning route before and after any mapping change. New
-- overrides and moves between scopes require the same protection as replacement.
create function public.guard_accounting_effective_route_change()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_org uuid:=coalesce(new.org_id,old.org_id); v_changed_id uuid:=coalesce(new.id,old.id); v_old jsonb:=case when tg_op='INSERT' then null else to_jsonb(old) end; v_conflicts integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(v_org::text||':accounting-routing',0));
  with documents as (
    select s.connection_id,i.project_id from accounting_sync_records s join invoices i on i.id=s.entity_id and i.org_id=s.org_id where s.org_id=v_org and s.entity_type='invoice' and nullif(s.external_id,'') is not null
    union select s.connection_id,e.project_id from accounting_sync_records s join project_expenses e on e.id=s.entity_id and e.org_id=s.org_id where s.org_id=v_org and s.entity_type='project_expense' and nullif(s.external_id,'') is not null
    union select s.connection_id,b.project_id from accounting_sync_records s join vendor_bills b on b.id=s.entity_id and b.org_id=s.org_id where s.org_id=v_org and s.entity_type in ('bill','vendor_credit') and nullif(s.external_id,'') is not null
    union select s.connection_id,p.project_id from accounting_sync_records s join payments p on p.id=s.entity_id and p.org_id=s.org_id where s.org_id=v_org and s.entity_type in ('payment','bill_payment') and nullif(s.external_id,'') is not null
  ), old_maps as (
    select m.connection_id,m.project_id,m.community_id,m.division_id from accounting_entity_map m where m.org_id=v_org and m.id<>v_changed_id
    union all select (v_old->>'connection_id')::uuid,(v_old->>'project_id')::uuid,(v_old->>'community_id')::uuid,(v_old->>'division_id')::uuid where v_old is not null
  ), routes as (
    select d.*,before_route.connection_id as before_connection,after_route.connection_id as after_connection from documents d
    left join projects p on p.id=d.project_id and p.org_id=v_org
    left join lateral(select community_id from lots where org_id=v_org and project_id=d.project_id limit 1) l on true
    left join lateral(select m.connection_id from old_maps m where (m.project_id=d.project_id or m.community_id=l.community_id or m.division_id=p.division_id or (m.project_id is null and m.community_id is null and m.division_id is null)) order by (m.project_id is not null) desc,(m.community_id is not null) desc,(m.division_id is not null) desc limit 1) before_route on true
    left join lateral(select m.connection_id from accounting_entity_map m where m.org_id=v_org and (m.project_id=d.project_id or m.community_id=l.community_id or m.division_id=p.division_id or (m.project_id is null and m.community_id is null and m.division_id is null)) order by (m.project_id is not null) desc,(m.community_id is not null) desc,(m.division_id is not null) desc limit 1) after_route on true
  ) select count(*) into v_conflicts from routes where before_connection is distinct from after_connection and connection_id is distinct from after_connection;
  if v_conflicts>0 then raise exception 'Accounting route change affects % linked transaction groups; retain historical connection identity and complete a reviewed transfer disposition first',v_conflicts; end if;
  return coalesce(new,old);
end $$;
create trigger accounting_effective_route_identity_guard after insert or update or delete on public.accounting_entity_map for each row execute function public.guard_accounting_effective_route_change();
revoke all on function public.guard_accounting_effective_route_change() from public,anon,authenticated;
