-- STAGED / UNAPPLIED. Requires human approval, full-schema current-JWT/RLS,
-- independent sessions, query plans, legacy-policy reconciliation and flag cutover.
-- No service-role impersonation: the only granted entry binds auth.uid().
create function public.trade_workspace_readable_homes(p_org uuid,p_actor uuid,p_division uuid,p_community uuid)
returns table(project_id uuid) language plpgsql stable security definer set search_path='' as $$
declare members uuid[];base text[];grants text[];denies text[];platform text[];effective text[];
 assigned boolean;division_assigned boolean;divisions uuid[];all_homes boolean;bypass boolean;
begin
 if p_actor is null or p_org is null or not exists(select 1 from public.app_users where id=p_actor) then raise exception 'Trade workspace actor is unavailable' using errcode='42501';end if;
 if not exists(select 1 from public.permissions where key='start.read') then raise exception 'Trade workspace permission is not registered' using errcode='42501';end if;
 select coalesce(array_agg(m.id),'{}'),coalesce(bool_or(m.project_scope='assigned'),false),coalesce(bool_or(m.division_scope='assigned'),false)
 into members,assigned,division_assigned from public.memberships m join public.roles r on r.id=m.role_id where m.org_id=p_org and m.user_id=p_actor and m.status='active';
 select coalesce(array_agg(distinct rp.permission_key),'{}') into base from public.memberships m join public.role_permissions rp on rp.role_id=m.role_id where m.id=any(members);
 select coalesce(array_agg(permission_key) filter(where effect='grant'),'{}'),coalesce(array_agg(permission_key) filter(where effect='deny'),'{}') into grants,denies from public.membership_permission_overrides where membership_id=any(members);
 select coalesce(array_agg(distinct rp.permission_key),'{}') into platform from public.platform_memberships m join public.roles r on r.id=m.role_id join public.role_permissions rp on rp.role_id=r.id where m.user_id=p_actor and m.status='active' and (m.expires_at is null or m.expires_at>statement_timestamp());
 bypass:='*'=any(platform) or 'platform.org.access'=any(platform);
 select coalesce(array_agg(distinct x),'{}') into effective from unnest(base||grants||platform) x where not(x=any(denies));
 if not bypass and (cardinality(members)=0 or 'start.read'=any(denies) or not('start.read'=any(effective) or '*'=any(effective))) then raise exception 'Trade workspace read permission denied' using errcode='42501';end if;
 all_homes:=bypass or '*'=any(base||grants) or 'org.admin'=any(base||grants) or (not assigned and ('project.read'=any(base||grants) or 'project.manage'=any(base||grants)));
 division_assigned:=not bypass and division_assigned and not('org.admin'=any(effective));
 select coalesce(array_agg(distinct division_id),'{}') into divisions from public.membership_divisions where membership_id=any(members);
 return query select p.id from public.projects p where p.org_id=p_org and p.property_type='production' and p.status='active'
 and (p_division is null or p.division_id=p_division) and (not division_assigned or p.division_id=any(divisions))
 and (all_homes or exists(select 1 from public.project_members pm join public.roles r on r.id=pm.role_id where pm.org_id=p_org and pm.project_id=p.id and pm.user_id=p_actor and pm.status='active'))
 and (bypass or not('project.read'=any(denies)) and ('project.read'=any(effective) or '*'=any(effective) or exists(select 1 from public.project_members pm join public.role_permissions rp on rp.role_id=pm.role_id where pm.org_id=p_org and pm.project_id=p.id and pm.user_id=p_actor and pm.status='active' and rp.permission_key in('project.read','*'))))
 and (p_community is null or exists(select 1 from public.lots l join public.communities c on c.id=l.community_id and c.org_id=l.org_id where l.project_id=p.id and l.org_id=p_org and c.id=p_community));
end $$;
revoke all on function public.trade_workspace_readable_homes(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function public.read_trade_lookahead_workspace(p_org uuid,p_actor uuid,p_weeks integer,p_division uuid default null,p_community uuid default null,p_q text default '',p_page integer default 1,p_group text default null,p_item_page integer default 1)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare start_day date:=(statement_timestamp() at time zone 'UTC')::date;end_day date;result jsonb;
begin
 if auth.uid() is null or auth.uid() is distinct from p_actor then raise exception 'Trade workspace authenticated actor mismatch' using errcode='42501';end if;
 if p_weeks is null or p_weeks not in(2,3,4) or p_page is null or p_page not between 1 and 1000000 or p_item_page is null or p_item_page not between 1 and 1000000 or p_q is null or length(p_q)>120 or length(p_group)>500 then raise exception 'Invalid trade workspace query';end if;
 end_day:=start_day+p_weeks*7;
 -- Validate source ancestry rather than silently dropping corrupt source evidence.
 if exists(select 1 from public.trade_workspace_readable_homes(p_org,p_actor,p_division,p_community) h join public.lots l on l.project_id=h.project_id and l.org_id=p_org group by h.project_id having count(*)>1) then raise exception 'Trade home has multiple lot sources; reconcile the home before review';end if;
 if exists(select 1 from public.trade_workspace_readable_homes(p_org,p_actor,p_division,p_community) h join public.schedule_items s on s.project_id=h.project_id and s.org_id=p_org join public.schedule_assignments a on a.schedule_item_id=s.id left join public.companies c on c.id=a.company_id where s.start_date between start_day and end_day and (a.org_id is distinct from p_org or a.project_id is distinct from s.project_id or a.company_id is not null and c.org_id is distinct from p_org)) then raise exception 'Trade assignment source belongs to another home or organization';end if;
 with homes as materialized(select project_id from public.trade_workspace_readable_homes(p_org,p_actor,p_division,p_community)),
 schedule as materialized(select s.id,s.project_id,s.name,nullif(s.trade,'') trade,s.status,s.start_date,coalesce(s.end_date,s.start_date) end_date,s.cost_code_id,
 coalesce(case when nullif(l.block,'') is not null then l.block||'-'||l.lot_number else l.lot_number end,'Lot') lot_label,coalesce(c.name,'Community') community_name
 from public.schedule_items s join homes h on h.project_id=s.project_id left join public.lots l on l.project_id=s.project_id and l.org_id=p_org left join public.communities c on c.id=l.community_id and c.org_id=p_org
 where s.org_id=p_org and s.start_date between start_day and end_day),
 assigned as materialized(select s.id,a.company_id,max(c.name) company_name,bool_or(a.confirmed_at is not null) confirmed from schedule s join public.schedule_assignments a on a.schedule_item_id=s.id and a.org_id=p_org and a.project_id=s.project_id join public.companies c on c.id=a.company_id and c.org_id=p_org group by s.id,a.company_id),
 fallback as (select s.id,case when count(distinct c.id)=1 then min(c.id::text)::uuid end company_id,case when count(distinct c.id)=1 then max(c.name) end company_name from schedule s
 join public.commitments po on po.org_id=p_org and po.project_id=s.project_id and po.commitment_type='purchase_order'
 join public.commitment_lines pl on pl.commitment_id=po.id and pl.org_id=p_org and pl.cost_code_id=s.cost_code_id
 join public.companies c on c.id=po.company_id and c.org_id=p_org where not exists(select 1 from assigned a where a.id=s.id) group by s.id),
 expanded as materialized(select s.*,coalesce(a.company_id,f.company_id) company_id,coalesce(a.company_name,f.company_name,'Unassigned') company_name,coalesce(a.confirmed,false) confirmed,
 '['||coalesce(to_json(coalesce(a.company_id,f.company_id)::text)::text,'null')||','||coalesce(to_json(s.trade)::text,'null')||']' group_key
 from schedule s left join assigned a on a.id=s.id left join fallback f on f.id=s.id),
 groups as materialized(select group_key,company_id,company_name,trade,count(*) item_count,count(*) filter(where confirmed) confirmed_count,min(start_date) first_date from expanded group by group_key,company_id,company_name,trade),
 matching as materialized(select * from groups where strpos(lower(company_name||' '||coalesce(trade,'')),lower(btrim(p_q)))>0),
 group_page as (select * from matching order by company_name collate "C",company_id nulls first,trade collate "C" nulls first offset (p_page-1)*50 limit 50),
 selected as (select * from groups where group_key=p_group),
 item_page as (select * from expanded where group_key=p_group order by start_date,id offset (p_item_page-1)*50 limit 50)
 select jsonb_build_object('orgId',p_org,'actorId',p_actor,'divisionId',p_division,'communityId',p_community,'weeks',p_weeks,'q',btrim(p_q),'group',p_group,
 'page',p_page,'pageSize',50,'itemPage',p_item_page,'itemPageSize',50,'total',(select count(*) from matching),'selectedUnavailable',p_group is not null and not exists(select 1 from selected),
 'rows',coalesce((select jsonb_agg(jsonb_build_object('key',group_key,'companyId',company_id,'companyName',company_name,'trade',trade,'itemCount',item_count,'confirmedCount',confirmed_count,'firstDate',first_date) order by company_name collate "C",company_id nulls first,trade collate "C" nulls first) from group_page),'[]'::jsonb),
 'selected',(select jsonb_build_object('key',g.group_key,'companyId',g.company_id,'companyName',g.company_name,'trade',g.trade,'itemCount',g.item_count,'confirmedCount',g.confirmed_count,'firstDate',g.first_date,
 'items',coalesce((select jsonb_agg(jsonb_build_object('scheduleItemId',id,'projectId',project_id,'lotLabel',lot_label,'communityName',community_name,'name',name,'startDate',start_date,'endDate',end_date,'status',status,'confirmation',case when confirmed then 'confirmed' else 'unsent' end) order by start_date,id) from item_page),'[]'::jsonb)) from selected g)) into result;
 return result;
end $$;
revoke all on function public.read_trade_lookahead_workspace(uuid,uuid,integer,uuid,uuid,text,integer,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_trade_lookahead_workspace(uuid,uuid,integer,uuid,uuid,text,integer,text,integer) to authenticated;

-- Validate lock duration and plans in the disposable full-schema environment before rollout.
create index if not exists schedule_items_trade_workspace on public.schedule_items(org_id,start_date,project_id,id);
create index if not exists schedule_assignments_trade_workspace on public.schedule_assignments(org_id,schedule_item_id,project_id,company_id);
create index if not exists commitments_trade_workspace on public.commitments(org_id,project_id,id) where commitment_type='purchase_order';
create index if not exists commitment_lines_trade_workspace on public.commitment_lines(org_id,commitment_id,cost_code_id,id);
