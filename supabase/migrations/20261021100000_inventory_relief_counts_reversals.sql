-- SPEC-01 (EP14-02) found: selling a home whose same-day vendor bills had been re-posted from work in
-- progress (1160) to completed inventory (1170) when the completion was recorded refused with
-- "Inventory components (X) do not add to the inventory balance (Y)". The component breakdown skipped
-- every entry whose source_type is not one of the two lifecycle transitions with `source_type not in
-- (...)`; reversal entries carry a NULL source_type, and `NULL not in (...)` is not true, so the reversal
-- of the 1160 posting was dropped while the original and its 1170 re-post were both counted. The only
-- change below is that predicate: a reversal is counted unless it reverses a lifecycle transition (which
-- the next line already excludes). Everything else is the function as 20261007235500 defined it.
create or replace function public.transition_books_project_inventory(p_org_id uuid,p_project_id uuid,p_transition text,p_date date,p_evidence_url text,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare settings public.project_financial_settings%rowtype; cip uuid; completed uuid; cogs uuid; cip_cents bigint; completed_cents bigint; total bigint; policy integer; revision integer; result_id uuid; lines jsonb; evidence jsonb;
  v_entry_date date; v_late boolean := false; v_component record; v_line integer := 0; v_relieved bigint := 0;
begin
 select * into settings from public.project_financial_settings where org_id=p_org_id and project_id=p_project_id for update;
 if not found or not settings.books_inventory_enabled then return jsonb_build_object('status','not_enabled'); end if;
 if p_transition not in ('completion','sale_relief') or p_date<settings.books_inventory_effective_on or p_evidence_url not like 'https://%' then raise exception 'Invalid inventory transition or missing evidence'; end if;
 if p_transition='completion' and settings.books_inventory_sold_on is not null then raise exception 'A sold home cannot return to completed inventory'; end if;
 if p_transition='completion' and settings.books_inventory_completed_on is not null and settings.books_inventory_completed_on<>p_date then raise exception 'The completion date is already recorded'; end if;
 if p_transition='sale_relief' and p_date<coalesce(settings.books_inventory_completed_on,settings.books_inventory_effective_on) then raise exception 'Sale cannot precede completion or inventory adoption'; end if;
 if p_transition='sale_relief' and settings.books_inventory_sold_on is not null and p_date<>settings.books_inventory_sold_on then raise exception 'The sale date is already recorded'; end if;
 select id into cip from public.gl_accounts where org_id=p_org_id and code='1160' and active;
 select id into completed from public.gl_accounts where org_id=p_org_id and code='1170' and active;
 select id into cogs from public.gl_accounts where org_id=p_org_id and code='5000' and active;
 if cip is null or completed is null or cogs is null then raise exception 'Inventory accounts are missing'; end if;
 select active_policy_version into policy from public.books_settings where org_id=p_org_id and workspace_enabled and arc_ledger_mode<>'disabled';
 if not found then raise exception 'Books posting is not enabled'; end if;
 -- A late cost on a sold home whose sale month is closed is relieved when found.
 v_entry_date := p_date;
 if p_transition='sale_relief' and settings.books_inventory_sold_on is not null and exists(
   select 1 from public.accounting_periods where org_id=p_org_id and status='closed' and settings.books_inventory_sold_on between period_start and period_end) then
   v_entry_date := greatest(p_date, (now() at time zone 'UTC')::date);
   v_late := true;
 end if;
 select coalesce(sum(l.debit_cents-l.credit_cents) filter(where l.account_id=cip),0),coalesce(sum(l.debit_cents-l.credit_cents) filter(where l.account_id=completed),0)
 into cip_cents,completed_cents from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id where l.org_id=p_org_id and l.project_id=p_project_id and l.account_id in(cip,completed) and e.status in('posted','reversed') and e.entry_date<=v_entry_date;
 if (select coalesce(sum(j.cost_cents),0) from public.job_cost_entries j where j.org_id=p_org_id and j.project_id=p_project_id and j.status='posted' and j.incurred_on<=v_entry_date) is distinct from
   (select coalesce(sum(l.debit_cents-l.credit_cents),0) from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id and a.org_id=l.org_id where l.org_id=p_org_id and l.project_id=p_project_id and e.status in('posted','reversed') and e.entry_date<=v_entry_date and (a.account_type='cogs' or a.code in('1160','1170')) and coalesce(l.dimensions->>'warranty_reserve_adjustment','false')<>'true') then
   raise exception 'Project costs must fully tie to Books before completing or selling inventory';
 end if;
 if p_transition='completion' then completed_cents:=0; end if;
 total:=cip_cents+completed_cents;
 if (total<0 or cip_cents<0 or completed_cents<0) and settings.books_inventory_completed_on is null and settings.books_inventory_sold_on is null then raise exception 'Negative inventory requires review before a lifecycle transition'; end if;
 if cip_cents<>0 or completed_cents<>0 then
   select count(*)+1 into revision from public.journal_entries where org_id=p_org_id and source_type='inventory_'||p_transition and source_id=p_project_id;
   evidence:=jsonb_build_object('inventory_transition',p_transition,'evidence_url',p_evidence_url,'inventory_basis_cents',total)
     || case when v_late then jsonb_build_object('late_closed_home_cost',true,'sold_on',settings.books_inventory_sold_on) else '{}'::jsonb end;
   lines:='[]'::jsonb;
   if p_transition='completion' then
     lines:=jsonb_build_array(jsonb_build_object('line_no',1,'account_id',completed,'project_id',p_project_id,'debit_cents',greatest(total,0),'credit_cents',greatest(-total,0),'dimensions',evidence));
   else
     -- What remains in inventory, by the component it came from: cost in, less what
     -- earlier reliefs took for that component (unlabeled reliefs were construction).
     for v_component in
       with costs as (
         select case e.source_type when 'inventory_start' then 'land_and_development' when 'inventory_interest' then 'capitalized_interest' when 'inventory_impairment' then 'impairment' else 'construction' end as component,
           sum(l.debit_cents-l.credit_cents) as cents
         from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
         where l.org_id=p_org_id and l.project_id=p_project_id and l.account_id in(cip,completed) and e.status in('posted','reversed') and e.entry_date<=v_entry_date
           and coalesce(e.source_type,'') not in ('inventory_completion','inventory_sale_relief')
           and not exists(select 1 from public.journal_entries o where o.id=e.reversal_of_entry_id and o.source_type in ('inventory_completion','inventory_sale_relief'))
         group by 1
       ), relieved as (
         select coalesce(l.dimensions->>'cost_component','construction') as component, sum(l.debit_cents-l.credit_cents) as cents
         from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
         where l.org_id=p_org_id and l.project_id=p_project_id and l.account_id=cogs and e.status in('posted','reversed')
           and (e.source_type='inventory_sale_relief' or exists(select 1 from public.journal_entries o where o.id=e.reversal_of_entry_id and o.source_type='inventory_sale_relief'))
         group by 1
       )
       select c.component, c.cents - coalesce(r.cents,0) as cents from costs c left join relieved r on r.component=c.component
       where c.cents - coalesce(r.cents,0) <> 0 order by c.component
     loop
       v_line := v_line + 1;
       v_relieved := v_relieved + v_component.cents;
       lines:=lines||jsonb_build_array(jsonb_build_object('line_no',v_line,'account_id',cogs,'project_id',p_project_id,'debit_cents',greatest(v_component.cents,0),'credit_cents',greatest(-v_component.cents,0),'dimensions',evidence||jsonb_build_object('cost_component',v_component.component)));
     end loop;
     -- Components always add back to what is in inventory; anything else is a ledger defect.
     if v_relieved<>total then raise exception 'Inventory components (%) do not add to the inventory balance (%)', v_relieved, total; end if;
   end if;
   if cip_cents<>0 then lines:=lines||jsonb_build_array(jsonb_build_object('line_no',v_line+2,'account_id',cip,'project_id',p_project_id,'debit_cents',greatest(-cip_cents,0),'credit_cents',greatest(cip_cents,0),'dimensions',evidence)); end if;
   if completed_cents<>0 then lines:=lines||jsonb_build_array(jsonb_build_object('line_no',v_line+3,'account_id',completed,'project_id',p_project_id,'debit_cents',greatest(-completed_cents,0),'credit_cents',greatest(completed_cents,0),'dimensions',evidence)); end if;
   result_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',v_entry_date,'entry_kind','adjusting',
     'memo',case when v_late then 'Late cost on a sold home' else 'Inventory '||p_transition end,
     'posting_key','inventory:'||p_project_id||':'||p_transition||':'||revision,'projection_version',1,'policy_version',policy,'source_type','inventory_'||p_transition,'source_id',p_project_id,'created_by',p_actor_id),lines);
 end if;
 update public.project_financial_settings set books_inventory_completed_on=case when p_transition='completion' then p_date else books_inventory_completed_on end,
   books_inventory_sold_on=case when p_transition='sale_relief' then coalesce(books_inventory_sold_on,p_date) else books_inventory_sold_on end,updated_at=now() where org_id=p_org_id and project_id=p_project_id;
 return jsonb_build_object('status','posted','id',result_id,'amount_cents',total,'late',v_late,'entry_date',v_entry_date);
end;
$$;
revoke all on function public.transition_books_project_inventory(uuid,uuid,text,date,text,uuid) from public,anon,authenticated;
grant execute on function public.transition_books_project_inventory(uuid,uuid,text,date,text,uuid) to service_role;
