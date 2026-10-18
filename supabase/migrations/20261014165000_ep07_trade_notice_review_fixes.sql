-- EP07 review B: one bad assignment row must not blank the look-ahead.
--
-- read_trade_lookahead_workspace raised for the WHOLE organization when any
-- in-window schedule_assignments row named another home or another
-- organization's company, and any member can insert such a row through the data
-- API. The workspace already joins assignments on the item's own home and the
-- organization's own companies, so a mismatched row simply never counts; the
-- raise only let one member take the desk away from everyone. Dropped.

create or replace function public.read_trade_lookahead_workspace(p_org uuid,p_actor uuid,p_weeks integer,p_division uuid default null,p_community uuid default null,p_q text default '',p_page integer default 1,p_group text default null,p_item_page integer default 1)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare start_day date:=(statement_timestamp() at time zone 'UTC')::date;end_day date;result jsonb;
begin
 if auth.uid() is null or auth.uid() is distinct from p_actor then raise exception 'Trade workspace authenticated actor mismatch' using errcode='42501';end if;
 if p_weeks is null or p_weeks not in(2,3,4) or p_page is null or p_page not between 1 and 1000000 or p_item_page is null or p_item_page not between 1 and 1000000 or p_q is null or length(p_q)>120 or length(p_group)>500 then raise exception 'Invalid trade workspace query';end if;
 end_day:=start_day+p_weeks*7;
 if exists(select 1 from public.trade_workspace_readable_homes(p_org,p_actor,p_division,p_community) h join public.lots l on l.project_id=h.project_id and l.org_id=p_org group by h.project_id having count(*)>1) then raise exception 'Trade home has multiple lot sources; reconcile the home before review';end if;
 with homes as materialized(select project_id from public.trade_workspace_readable_homes(p_org,p_actor,p_division,p_community)),
 schedule as materialized(select s.id,s.project_id,s.name,nullif(s.trade,'') trade,s.status,s.start_date,coalesce(s.end_date,s.start_date) end_date,s.cost_code_id,
 coalesce(case when nullif(l.block,'') is not null then l.block||'-'||l.lot_number else l.lot_number end,'Lot') lot_label,coalesce(c.name,'Community') community_name
 from public.schedule_items s join homes h on h.project_id=s.project_id left join public.lots l on l.project_id=s.project_id and l.org_id=p_org left join public.communities c on c.id=l.community_id and c.org_id=p_org
 where s.org_id=p_org and s.start_date<=end_day and coalesce(s.end_date,s.start_date)>=start_day and s.status not in('cancelled','completed')),
 assigned as materialized(select s.id,a.company_id,max(c.name) company_name,bool_or(a.confirmed_at is not null) confirmed from schedule s join public.schedule_assignments a on a.schedule_item_id=s.id and a.org_id=p_org and a.project_id=s.project_id join public.companies c on c.id=a.company_id and c.org_id=p_org group by s.id,a.company_id),
 fallback as (select s.id,case when count(distinct c.id)=1 then min(c.id::text)::uuid end company_id,case when count(distinct c.id)=1 then max(c.name) end company_name from schedule s
 join public.commitments po on po.org_id=p_org and po.project_id=s.project_id and po.commitment_type='purchase_order' and po.status in('approved','complete')
 join public.commitment_lines pl on pl.commitment_id=po.id and pl.org_id=p_org and pl.cost_code_id=s.cost_code_id
 join public.companies c on c.id=po.company_id and c.org_id=p_org where not exists(select 1 from assigned a where a.id=s.id) group by s.id),
 expanded as materialized(select s.*,coalesce(a.company_id,f.company_id) company_id,coalesce(a.company_name,f.company_name,'Unassigned') company_name,coalesce(a.confirmed,false) confirmed,
 case when coalesce(a.company_id,f.company_id) is null then 'unassigned' when a.company_id is null then 'inferred' else 'assigned' end assignment,
 '['||coalesce(to_json(coalesce(a.company_id,f.company_id)::text)::text,'null')||','||coalesce(to_json(s.trade)::text,'null')||']' group_key
 from schedule s left join assigned a on a.id=s.id left join fallback f on f.id=s.id),
 groups as materialized(select group_key,company_id,company_name,trade,count(*) item_count,count(*) filter(where confirmed) confirmed_count,count(*) filter(where assignment='inferred') inferred_count,min(start_date) first_date from expanded group by group_key,company_id,company_name,trade),
 matching as materialized(select * from groups where strpos(lower(company_name||' '||coalesce(trade,'')),lower(btrim(p_q)))>0),
 group_page as (select * from matching order by company_name collate "C",company_id nulls first,trade collate "C" nulls first offset (p_page-1)*50 limit 50),
 selected as (select * from groups where group_key=p_group),
 item_page as (select * from expanded where group_key=p_group order by start_date,id offset (p_item_page-1)*50 limit 50)
 select jsonb_build_object('orgId',p_org,'actorId',p_actor,'divisionId',p_division,'communityId',p_community,'weeks',p_weeks,'q',btrim(p_q),'group',p_group,
 'page',p_page,'pageSize',50,'itemPage',p_item_page,'itemPageSize',50,'total',(select count(*) from matching),'selectedUnavailable',p_group is not null and not exists(select 1 from selected),
 'rows',coalesce((select jsonb_agg(jsonb_build_object('key',group_key,'companyId',company_id,'companyName',company_name,'trade',trade,'itemCount',item_count,'confirmedCount',confirmed_count,'inferredCount',inferred_count,'firstDate',first_date) order by company_name collate "C",company_id nulls first,trade collate "C" nulls first) from group_page),'[]'::jsonb),
 'selected',(select jsonb_build_object('key',g.group_key,'companyId',g.company_id,'companyName',g.company_name,'trade',g.trade,'itemCount',g.item_count,'confirmedCount',g.confirmed_count,'inferredCount',g.inferred_count,'firstDate',g.first_date,
 'items',coalesce((select jsonb_agg(jsonb_build_object('scheduleItemId',id,'projectId',project_id,'lotLabel',lot_label,'communityName',community_name,'name',name,'startDate',start_date,'endDate',end_date,'status',status,'assignment',assignment,'confirmation',case when confirmed then 'confirmed' else 'unsent' end) order by start_date,id) from item_page),'[]'::jsonb)) from selected g)) into result;
 return result;
end $$;
