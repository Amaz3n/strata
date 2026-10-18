-- STAGED ONLY. Human migration approval and full-schema/RLS QA required.
-- Trusted-service actor identity; never grant these RPCs to browser roles.
create function public.warranty_readable_homes(p_org_id uuid,p_actor_id uuid,p_division_id uuid default null,p_community_id uuid default null)
returns table(project_id uuid) language plpgsql stable security definer set search_path=public,pg_catalog as $$
declare
 members uuid[]; base text[]; grants text[]; denies text[]; platform text[]; effective text[];
 assigned boolean; division_assigned boolean; divisions uuid[]; all_homes boolean; bypass boolean;
begin
 if p_org_id is null or p_actor_id is null or not exists(select 1 from public.app_users where id=p_actor_id) then raise exception 'Warranty analytics actor is unavailable' using errcode='42501'; end if;
 if not exists(select 1 from public.permissions where key='warranty.read') then raise exception 'Warranty read permission is not registered' using errcode='42501'; end if;
 select coalesce(array_agg(m.id),'{}'),coalesce(bool_or(m.project_scope='assigned'),false),coalesce(bool_or(m.division_scope='assigned'),false)
 into members,assigned,division_assigned from public.memberships m join public.roles r on r.id=m.role_id where m.org_id=p_org_id and m.user_id=p_actor_id and m.status='active';
 select coalesce(array_agg(distinct rp.permission_key),'{}') into base from public.memberships m join public.roles r on r.id=m.role_id join public.role_permissions rp on rp.role_id=r.id where m.id=any(members);
 select coalesce(array_agg(permission_key) filter(where effect='grant'),'{}'),coalesce(array_agg(permission_key) filter(where effect='deny'),'{}') into grants,denies from public.membership_permission_overrides where membership_id=any(members);
 select coalesce(array_agg(distinct rp.permission_key),'{}') into platform from public.platform_memberships m join public.roles r on r.id=m.role_id join public.role_permissions rp on rp.role_id=r.id where m.user_id=p_actor_id and m.status='active' and (m.expires_at is null or m.expires_at>statement_timestamp());
 bypass:='*'=any(platform) or 'platform.org.access'=any(platform);
 select coalesce(array_agg(distinct x),'{}') into effective from unnest(base||grants||platform) x where not(x=any(denies));
 if not bypass and ('warranty.read'=any(denies) or not('warranty.read'=any(effective) or '*'=any(effective))) then raise exception 'Warranty analytics read permission denied' using errcode='42501'; end if;
 all_homes:=bypass or '*'=any(base||grants) or 'org.admin'=any(base||grants) or (not assigned and ('project.read'=any(base||grants) or 'project.manage'=any(base||grants)));
 division_assigned:=not bypass and division_assigned and not('org.admin'=any(base));
 select coalesce(array_agg(distinct division_id),'{}') into divisions from public.membership_divisions where membership_id=any(members);
 return query select p.id from public.projects p where p.org_id=p_org_id
 and (p_division_id is null or p.division_id=p_division_id)
 and (not division_assigned or p.division_id=any(divisions))
 and (all_homes or exists(select 1 from public.project_members pm join public.roles r on r.id=pm.role_id where pm.org_id=p_org_id and pm.project_id=p.id and pm.user_id=p_actor_id and pm.status='active'))
 and (p_community_id is null or exists(select 1 from public.lots l join public.communities c on c.id=l.community_id and c.org_id=l.org_id where l.project_id=p.id and l.org_id=p_org_id and c.id=p_community_id));
end $$;
revoke all on function public.warranty_readable_homes(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function public.assert_warranty_analytics_money(p_org_id uuid,p_actor_id uuid,p_division_id uuid default null,p_community_id uuid default null)
returns void language plpgsql stable security definer set search_path=public,pg_catalog as $$
begin
 if exists(with homes as materialized(select project_id from public.warranty_readable_homes(p_org_id,p_actor_id,p_division_id,p_community_id))
 select 1 from public.warranty_service_visits v join homes h on h.project_id=v.project_id where v.org_id=p_org_id and v.status='completed' and v.books_cost_approved_at is not null and (v.books_approved_cost_cents is null or v.books_approved_cost_cents<0 or v.books_approved_cost_cents>9007199254740991)
 union all select 1 from public.warranty_backcharges b join homes h on h.project_id=b.project_id where b.org_id=p_org_id and (b.amount_cents is null or b.recovered_cents is null or b.amount_cents<0 or b.recovered_cents<0 or b.recovered_cents>b.amount_cents or b.amount_cents>9007199254740991)
 ) then raise exception 'Invalid scoped warranty monetary evidence'; end if;
end $$;
revoke all on function public.assert_warranty_analytics_money(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function public.warranty_cost_summary_for_actor(p_org_id uuid,p_actor_id uuid,p_division_id uuid default null,p_community_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=public,pg_catalog as $$
declare result jsonb;
begin
 perform public.assert_warranty_analytics_money(p_org_id,p_actor_id,p_division_id,p_community_id);
 with homes as materialized (select project_id from public.warranty_readable_homes(p_org_id,p_actor_id,p_division_id,p_community_id)),
 mapped as materialized (select h.project_id,l.community_id,c.name from homes h join public.lots l on l.project_id=h.project_id and l.org_id=p_org_id join public.communities c on c.id=l.community_id and c.org_id=p_org_id),
 costs as (select v.project_id,sum(v.books_approved_cost_cents)::bigint cents from public.warranty_service_visits v join mapped h on h.project_id=v.project_id join public.warranty_requests r on r.id=v.request_id and r.org_id=v.org_id and r.project_id=v.project_id where v.org_id=p_org_id and v.status='completed' and v.books_cost_approved_at is not null group by v.project_id),
 recoveries as (select b.project_id,sum(b.recovered_cents)::bigint cents from public.warranty_backcharges b join mapped h on h.project_id=b.project_id join public.warranty_requests r on r.id=b.warranty_request_id and r.org_id=b.org_id and r.project_id=b.project_id where b.org_id=p_org_id group by b.project_id),
 revenue as (select cl.project_id,sum(coalesce((coalesce(cl.settlement->>'finalPriceCents',cl.settlement->>'final_price_cents'))::bigint,i.total_cents::bigint,0))::bigint cents from public.closings cl join mapped h on h.project_id=cl.project_id and h.community_id=cl.community_id left join public.invoices i on i.id=cl.closing_invoice_id and i.org_id=cl.org_id and i.project_id=cl.project_id where cl.org_id=p_org_id and cl.status='closed' group by cl.project_id),
 totals as (select h.community_id,max(h.name) community_name,coalesce(sum(c.cents),0)::bigint warranty_cost_cents,coalesce(sum(r.cents),0)::bigint recovered_cents,coalesce(sum(v.cents),0)::bigint closed_revenue_cents from mapped h left join costs c using(project_id) left join recoveries r using(project_id) left join revenue v using(project_id) group by h.community_id),
 rows as (select t.*,(warranty_cost_cents-recovered_cents)::bigint net_cost_cents,case when closed_revenue_cents>0 then round((warranty_cost_cents-recovered_cents)*100.0/closed_revenue_cents,3) else null end cost_percent from totals t)
 select coalesce(jsonb_agg(to_jsonb(rows) order by community_name,community_id),'[]'::jsonb) into result from rows;
 return result;
end $$;
revoke all on function public.warranty_cost_summary_for_actor(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.warranty_cost_summary_for_actor(uuid,uuid,uuid,uuid) to service_role;

create function public.warranty_company_signal_for_actor(p_org_id uuid,p_actor_id uuid,p_company_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public,pg_catalog as $$
declare result jsonb;
begin
 if p_company_id is null then raise exception 'Warranty company identity required'; end if;
 perform public.assert_warranty_analytics_money(p_org_id,p_actor_id);
 with homes as materialized (select project_id from public.warranty_readable_homes(p_org_id,p_actor_id)),
 requests as (select count(*)::bigint n from public.warranty_requests r join homes h on h.project_id=r.project_id where r.org_id=p_org_id and r.assigned_company_id=p_company_id),
 charges as (select coalesce(sum(b.amount_cents),0)::bigint amount,coalesce(sum(b.recovered_cents),0)::bigint recovered,count(*) filter(where b.status in('issued','disputed'))::bigint n from public.warranty_backcharges b join homes h on h.project_id=b.project_id where b.org_id=p_org_id and b.company_id=p_company_id)
 select jsonb_build_object('request_count',r.n,'backcharge_cents',c.amount,'recovered_cents',c.recovered,'open_backcharges',c.n) into result from requests r cross join charges c;
 return result;
end $$;
revoke all on function public.warranty_company_signal_for_actor(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.warranty_company_signal_for_actor(uuid,uuid,uuid) to service_role;

create function public.warranty_defect_analysis_for_actor(p_org_id uuid,p_actor_id uuid,p_group_by text,p_division_id uuid default null,p_community_id uuid default null,p_from timestamptz default null,p_to timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path=public,pg_catalog as $$
declare result jsonb;
begin
 if p_group_by not in ('community','company','cost_code','plan_version','plan') or p_group_by is null then raise exception 'Invalid warranty analytics grouping'; end if;
 if p_from is not null and p_to is not null and p_to<=p_from then raise exception 'Invalid warranty analytics period'; end if;
 perform public.assert_warranty_analytics_money(p_org_id,p_actor_id,p_division_id,p_community_id);
 with report as (
with readable_homes as materialized (select project_id from public.warranty_readable_homes(p_org_id,p_actor_id,p_division_id,p_community_id)), request_backcharges as (
    select
      wb.warranty_request_id,
      sum(wb.amount_cents)::bigint as backcharge_cents,
      sum(wb.recovered_cents)::bigint as recovered_cents
    from public.warranty_backcharges wb
    where wb.org_id = p_org_id and exists(select 1 from readable_homes h join public.warranty_requests r on r.project_id=h.project_id and r.org_id=p_org_id where h.project_id=wb.project_id and r.id=wb.warranty_request_id)
    group by wb.warranty_request_id
  ), request_backcharge_company as (
    select distinct on (wb.warranty_request_id)
      wb.warranty_request_id,
      wb.company_id
    from public.warranty_backcharges wb
    where wb.org_id = p_org_id and exists(select 1 from readable_homes h join public.warranty_requests r on r.project_id=h.project_id and r.org_id=p_org_id where h.project_id=wb.project_id and r.id=wb.warranty_request_id)
    order by wb.warranty_request_id, wb.created_at
  ), request_internal as (
    select
      v.request_id,
      sum(case when v.books_cost_approved_at is not null then v.books_approved_cost_cents else 0 end)::bigint as internal_cents
    from public.warranty_service_visits v
    where v.org_id = p_org_id and exists(select 1 from readable_homes h join public.warranty_requests r on r.project_id=h.project_id and r.org_id=p_org_id where h.project_id=v.project_id and r.id=v.request_id)
      and v.status = 'completed'
    group by v.request_id
  ), request_base as (
    select
      wr.id,
      wr.project_id,
      wr.category,
      coalesce(wr.assigned_company_id, rbc.company_id) as company_id,
      wr.cost_code_id,
      l.community_id,
      l.house_plan_version_id,
      hpv.house_plan_id,
      (coalesce(ri.internal_cents, 0))::bigint as remediation_cost_cents,
      coalesce(rb.recovered_cents, 0)::bigint as recovered_cents,
      case p_group_by
        when 'community' then l.community_id::text
        when 'company' then coalesce(wr.assigned_company_id, rbc.company_id)::text
        when 'cost_code' then wr.cost_code_id::text
        when 'plan_version' then l.house_plan_version_id::text
        when 'plan' then hpv.house_plan_id::text
      end as group_id
    from public.warranty_requests wr
    left join request_backcharges rb on rb.warranty_request_id = wr.id
    left join request_backcharge_company rbc on rbc.warranty_request_id = wr.id
    left join request_internal ri on ri.request_id = wr.id
    left join public.lots l on l.org_id = wr.org_id and l.project_id = wr.project_id
    left join public.house_plan_versions hpv
      on hpv.org_id = wr.org_id and hpv.id = l.house_plan_version_id
    where wr.org_id = p_org_id
      and exists(select 1 from readable_homes h where h.project_id=wr.project_id)
      and (p_from is null or wr.created_at >= p_from)
      and (p_to is null or wr.created_at < p_to)
      and p_group_by in ('community','company','cost_code','plan_version','plan')
      -- Scheduled courtesy walks are a ritual, not a reported defect.
      and (wr.metadata ->> 'courtesy_milestone') is null
  ), names as (
    select rb.*,
      case p_group_by
        when 'community' then c.name
        when 'company' then co.name
        when 'cost_code' then concat_ws(' — ', cc.code, cc.name)
        when 'plan_version' then concat_ws(
          ' — ',
          hp.code,
          coalesce(hpv.label, 'Version ' || hpv.version_number::text)
        )
        when 'plan' then concat_ws(' — ', hp.code, hp.name)
      end as group_name
    from request_base rb
    left join public.communities c
      on p_group_by = 'community' and c.id::text = rb.group_id and c.org_id=p_org_id
    left join public.companies co
      on p_group_by = 'company' and co.id::text = rb.group_id and co.org_id=p_org_id
    left join public.cost_codes cc
      on p_group_by = 'cost_code' and cc.id::text = rb.group_id and cc.org_id=p_org_id and c.org_id=p_org_id
    left join public.house_plan_versions hpv
      on p_group_by = 'plan_version' and hpv.id::text = rb.group_id and hpv.org_id=p_org_id
    left join public.house_plans hp
      on hp.org_id=p_org_id and hp.id = coalesce(
        hpv.house_plan_id,
        case
          when p_group_by = 'plan' and rb.group_id is not null
            then rb.group_id::uuid
        end
      )
    where rb.group_id is not null
  ), totals as (
    select
      n.group_id,
      max(n.group_name) as group_name,
      count(*) as request_count,
      count(distinct n.project_id) as affected_home_count,
      sum(n.remediation_cost_cents)::bigint as remediation_cost_cents,
      sum(n.recovered_cents)::bigint as recovered_cents
    from names n
    group by n.group_id
  ), categories as (
    select
      group_id,
      coalesce(
        jsonb_agg(
          jsonb_build_object('category', category, 'count', category_count)
          order by category_count desc, category
        ) filter (where category_rank <= 3),
        '[]'::jsonb
      ) as top_categories
    from (
      select
        group_id,
        coalesce(category, 'Uncategorized') as category,
        count(*) as category_count,
        row_number() over (
          partition by group_id
          order by count(*) desc, coalesce(category, 'Uncategorized')
        ) as category_rank
      from names
      group by group_id, coalesce(category, 'Uncategorized')
    ) ranked
    group by group_id
  ), scoped_closed as (
    select
      cl.project_id,
      l.community_id,
      l.house_plan_version_id,
      hpv.house_plan_id
    from public.closings cl
    left join public.lots l
      on l.org_id = cl.org_id and l.project_id = cl.project_id
    left join public.house_plan_versions hpv
      on hpv.org_id = cl.org_id and hpv.id = l.house_plan_version_id
    where cl.org_id = p_org_id
      and cl.status = 'closed'
      and exists(select 1 from readable_homes h where h.project_id=cl.project_id)
  ), group_closed as (
    select
      t.group_id,
      (
        select count(distinct cl.project_id)
        from scoped_closed cl
        where case p_group_by
          when 'community' then cl.community_id::text = t.group_id
          when 'plan_version' then cl.house_plan_version_id::text = t.group_id
          when 'plan' then cl.house_plan_id::text = t.group_id
          else true
        end
      )::bigint as closed_home_count
    from totals t
  )
  select
    t.group_id,
    t.group_name,
    t.request_count,
    t.affected_home_count,
    gc.closed_home_count,
    -- The rate this group failed at, against this group's own volume. Dividing
    -- by org-wide closings understated every plan by its share of the business.
    round(
      t.affected_home_count * 100.0 / nullif(gc.closed_home_count, 0),
      2
    ) as affected_home_percent,
    t.remediation_cost_cents,
    t.recovered_cents,
    case
      when t.request_count = 0 then 0
      else (t.remediation_cost_cents / t.request_count)::bigint
    end as average_cost_cents,
    c.top_categories
  from totals t
  join categories c using (group_id)
  join group_closed gc using (group_id)
  order by t.request_count desc, t.group_name
) select coalesce(jsonb_agg(to_jsonb(report) order by request_count desc,group_name,group_id),'[]'::jsonb) into result from report;
 return result;
end $$;
revoke all on function public.warranty_defect_analysis_for_actor(uuid,uuid,text,uuid,uuid,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.warranty_defect_analysis_for_actor(uuid,uuid,text,uuid,uuid,timestamptz,timestamptz) to service_role;
