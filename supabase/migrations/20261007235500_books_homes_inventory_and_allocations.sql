-- Home sale relief and closing reversal, warranty consumption, home inventory controls, development and cost allocations, impairment, and the export layer left after retiring the per-entity ledger (B11.3, B11.4, B12.2, B14).
--
-- Consolidated before deploy (2026-10-09) from 8 unapplied migrations, in their
-- original order; each section is marked with the file it came from.

-- ==== 20261007180000_books_home_sale_relief ====
-- B11.3: selling a home relieves its inventory to cost of sales by the cost it
-- came from, and a cost that arrives after the sale has an explicit policy.
--
-- * Relief is split by component: land and development (brought in when the
--   house started, `inventory_start`), capitalized interest (`inventory_interest`),
--   any reviewed write-down (`inventory_impairment`, a negative component) and
--   construction (everything else). Each cost-of-sales line names its
--   component, so a sold home reconciles to its original cost ownership.
-- * A late cost on a sold home (anything left in inventory after the sale was
--   relieved, e.g. a bill dated before the sale but entered after it) is
--   relieved on the sale date while that month is open; once the sale's month is
--   closed it is relieved on the date it is found, labeled as a late cost on a
--   sold home, and the closed month's cost of sales is never rewritten.

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
           and e.source_type not in ('inventory_completion','inventory_sale_relief')
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

-- ==== 20261007190000_books_warranty_consumption_accounts ====
-- B11.3: consuming the warranty reserve takes an approved warranty cost off the
-- cost-of-sales account it actually posted to (it used to credit 5050 Warranty
-- costs whatever the source account, leaving job cost overstated and warranty
-- expense negative).

CREATE OR REPLACE FUNCTION public.approve_books_warranty_cost(p_org_id uuid, p_visit_id uuid, p_date date, p_sources jsonb, p_evidence_url text, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare credits jsonb := '[]'::jsonb; source_account uuid; remaining bigint; take bigint; credit_line jsonb; line_no integer := 1; visit public.warranty_service_visits%rowtype; item jsonb; cost public.job_cost_entries%rowtype; used bigint; total bigint:=0; covered bigint; reserve uuid; expense uuid; available bigint; result_id uuid; policy integer; source_kind text; resolved_source_id uuid; dimensions jsonb;
begin
 if jsonb_typeof(p_sources)<>'array' or jsonb_array_length(p_sources)=0 or p_evidence_url not like 'https://%' then raise exception 'Posted source costs and supporting evidence are required'; end if;
 if (select count(*) from jsonb_array_elements(p_sources))<>(select count(distinct x->>'job_cost_entry_id') from jsonb_array_elements(p_sources) x) then raise exception 'Cost sources must be unique'; end if;
 perform 1 from public.job_cost_entries j where j.org_id=p_org_id and j.id in(select (x->>'job_cost_entry_id')::uuid from jsonb_array_elements(p_sources) x) order by j.id for update;
 select * into visit from public.warranty_service_visits where org_id=p_org_id and id=p_visit_id for update;
 if not found or visit.status<>'completed' then raise exception 'Only completed warranty visits can receive cost approval'; end if;
 if visit.books_cost_approved_at is not null then
   if visit.books_cost_sources=p_sources and visit.books_cost_date=p_date and visit.books_cost_evidence_url=p_evidence_url then return jsonb_build_object('id',visit.books_cost_journal_entry_id,'approved_cents',visit.books_approved_cost_cents,'reserve_cents',visit.books_reserve_consumed_cents); end if;
   raise exception 'Reverse the prior cost approval before changing its sources';
 end if;
 perform 1 from public.project_financial_settings where org_id=p_org_id and project_id=visit.project_id for update;
 for item in select x from jsonb_array_elements(p_sources) x loop
   select * into cost from public.job_cost_entries where org_id=p_org_id and id=(item->>'job_cost_entry_id')::uuid;
   if not found or cost.project_id<>visit.project_id or cost.status<>'posted' or cost.cost_cents<=0 or cost.incurred_on>p_date or (item->>'amount_cents')::bigint<=0 then raise exception 'Select positive posted costs from this visit project on or before the approval date'; end if;
   source_kind:=case cost.source_type when 'vendor_bill_line' then 'vendor_bill' when 'project_expense_line' then 'expense' when 'project_expense' then 'expense' when 'time_entry' then 'labor_cost' when 'bank_transaction' then 'bank_transaction' else null end;
   resolved_source_id:=case cost.source_type when 'vendor_bill_line' then (select bill_id from public.bill_lines where org_id=p_org_id and id=cost.source_id::uuid) when 'project_expense_line' then (select expense_id from public.project_expense_lines where org_id=p_org_id and id=cost.source_id::uuid) when 'time_entry' then cost.id else cost.source_id::uuid end;
   if source_kind is null or not exists(select 1 from public.journal_entries e where e.org_id=p_org_id and e.source_type=source_kind and e.source_id=resolved_source_id and e.status='posted') then raise exception 'Post the actual cost source to Books before allocating it to warranty'; end if;
   select coalesce(sum((allocation->>'amount_cents')::bigint),0) into used from public.warranty_service_visits v cross join lateral jsonb_array_elements(v.books_cost_sources) allocation where v.org_id=p_org_id and v.books_cost_approved_at is not null and allocation->>'job_cost_entry_id'=cost.id::text;
   if used+(item->>'amount_cents')::bigint>cost.cost_cents then raise exception 'Warranty allocations exceed the actual source cost'; end if;
   -- The account this cost actually posted to: consuming the reserve takes the
   -- cost off that same account, so job cost and warranty expense stay true.
   select l.account_id into source_account from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id and a.org_id=l.org_id
     where l.org_id=p_org_id and e.source_type=source_kind and e.source_id=resolved_source_id and e.status='posted' and l.project_id=visit.project_id and a.account_type='cogs' and l.debit_cents>0
     order by (l.debit_cents=cost.cost_cents) desc, l.line_no limit 1;
   credits:=credits||jsonb_build_array(jsonb_build_object('account_id',source_account,'cents',(item->>'amount_cents')::bigint));
   total:=total+(item->>'amount_cents')::bigint;
 end loop;
 select id into reserve from public.gl_accounts where org_id=p_org_id and code='2260' and active;
 select id into expense from public.gl_accounts where org_id=p_org_id and code='5050' and active;
 select coalesce(sum(l.credit_cents-l.debit_cents),0) into available from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id where l.org_id=p_org_id and l.project_id=visit.project_id and l.account_id=reserve and e.status in('posted','reversed') and e.entry_date<=p_date;
 covered:=least(total,greatest(available,0));
 if covered>0 then
   if expense is null then raise exception 'Warranty expense account is missing'; end if;
   select active_policy_version into policy from public.books_settings where org_id=p_org_id;
   dimensions:=jsonb_build_object('warranty_reserve_adjustment',true,'warranty_visit_id',visit.id,'evidence_url',p_evidence_url,'actual_sources',p_sources);
   -- Credit the covered amount to the accounts the sources posted to, in source
   -- order; a source with no cost-of-sales line (none expected) uses warranty costs.
   remaining:=covered;
   credit_line:=jsonb_build_array(jsonb_build_object('line_no',1,'account_id',reserve,'project_id',visit.project_id,'debit_cents',covered,'credit_cents',0,'dimensions',dimensions));
   for item in select x from jsonb_array_elements(credits) x loop
     exit when remaining<=0;
     take:=least(remaining,(item->>'cents')::bigint);
     line_no:=line_no+1;
     credit_line:=credit_line||jsonb_build_array(jsonb_build_object('line_no',line_no,'account_id',coalesce((item->>'account_id')::uuid,expense),'project_id',visit.project_id,'debit_cents',0,'credit_cents',take,'dimensions',dimensions));
     remaining:=remaining-take;
   end loop;
   result_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p_date,'entry_kind','adjusting','memo','Consume warranty reserve for approved actual cost','posting_key','warranty_cost:'||visit.id||':'||encode(extensions.digest(p_sources::text||p_date::text||now()::text,'sha256'),'hex'),'projection_version',1,'policy_version',policy,'source_type','warranty_reserve_consumption','source_id',visit.id,'created_by',p_actor_id),
   credit_line);
 end if;
 update public.warranty_service_visits set books_cost_sources=p_sources,books_approved_cost_cents=total,books_reserve_consumed_cents=covered,books_cost_approved_by=p_actor_id,books_cost_approved_at=now(),books_cost_date=p_date,books_cost_evidence_url=p_evidence_url,books_cost_journal_entry_id=result_id,updated_at=now() where org_id=p_org_id and id=visit.id;
 return jsonb_build_object('id',result_id,'approved_cents',total,'reserve_cents',covered);
end;
$function$;

-- ==== 20261007200000_books_home_inventory_controls ====
-- B11.3: land, completed homes and the warranty reserve tie to their own records.
--
-- * Land (1120): each lot held as land (acquired, not yet started into a home)
--   carries its recorded cost basis (acquisition plus allocated development) in
--   the ledger, lot by lot.
-- * Completed homes held for sale (1170): the ledger equals the homes completed
--   and not yet sold, each with its completion date, so spec aging reads from the
--   books; a 1170 balance on a home that is not held for sale is an exception.
-- * Warranty reserve (2260): what the ledger consumed equals the reserve
--   consumption recorded on approved warranty visits.

create or replace function public.books_home_inventory_controls(p_org_id uuid, p_as_of date)
returns jsonb language sql stable security definer set search_path = public as $$
  with lines as (
    select a.code, l.project_id, l.dimensions, e.source_type, e.source_id, e.reversal_of_entry_id, (l.debit_cents - l.credit_cents)::bigint as net
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
    join public.gl_accounts a on a.id = l.account_id and a.org_id = l.org_id
    where l.org_id = p_org_id and e.status in ('posted','reversed') and e.entry_date <= p_as_of and a.code in ('1120','1170','2260')
  ), land_ledger as (
    select dimensions->>'lot_id' as lot_id, sum(net)::bigint as cents from lines where code = '1120' group by 1
  ), land_lots as (
    select lo.id::text as lot_id, coalesce(lo.lot_number, '') as lot_number, coalesce(lo.cost_basis_cents, 0)::bigint as cents
    from public.lots lo
    join public.journal_entries acq on acq.id = lo.books_acquisition_entry_id and acq.org_id = lo.org_id and acq.entry_date <= p_as_of
    where lo.org_id = p_org_id
      and not exists(select 1 from public.journal_entries s where s.org_id = p_org_id and s.source_type = 'inventory_start' and s.source_id = lo.id and s.status = 'posted' and s.entry_date <= p_as_of)
  ), land_rows as (
    select coalesce(k.lot_id, g.lot_id) as lot_id, k.lot_number, coalesce(g.cents, 0) as ledger_cents, coalesce(k.cents, 0) as subledger_cents
    from land_lots k full join land_ledger g on g.lot_id = k.lot_id
  ), held as (
    select s.project_id, s.books_inventory_completed_on as completed_on from public.project_financial_settings s
    where s.org_id = p_org_id and s.books_inventory_enabled and s.books_inventory_completed_on <= p_as_of
      and (s.books_inventory_sold_on is null or s.books_inventory_sold_on > p_as_of)
  ), completed_ledger as (
    select project_id, sum(net)::bigint as cents from lines where code = '1170' group by 1
  ), completed_rows as (
    select coalesce(h.project_id, c.project_id) as project_id, h.completed_on, coalesce(c.cents, 0) as cents, h.project_id is not null as held
    from held h full join completed_ledger c on c.project_id = h.project_id
  ), consumed_ledger as (
    select coalesce(sum(net), 0)::bigint as cents from lines where code = '2260'
      and (source_type = 'warranty_reserve_consumption' or exists(select 1 from public.journal_entries o where o.id = reversal_of_entry_id and o.source_type = 'warranty_reserve_consumption'))
  )
  select jsonb_build_object(
    'land', jsonb_build_object(
      'ledgerCents', (select coalesce(sum(ledger_cents), 0) from land_rows),
      'subledgerCents', (select coalesce(sum(subledger_cents), 0) from land_rows),
      'exceptions', coalesce((select jsonb_agg(jsonb_build_object('lotId', lot_id, 'lotNumber', lot_number, 'ledgerCents', ledger_cents, 'basisCents', subledger_cents) order by lot_number) from land_rows where ledger_cents <> subledger_cents), '[]'::jsonb)),
    'completedHomes', jsonb_build_object(
      'ledgerCents', (select coalesce(sum(cents), 0) from completed_rows),
      'heldCents', (select coalesce(sum(cents), 0) from completed_rows where held),
      'homes', coalesce((select jsonb_agg(jsonb_build_object('projectId', project_id, 'completedOn', completed_on, 'ageDays', p_as_of - completed_on, 'cents', cents) order by completed_on, project_id) from completed_rows where held), '[]'::jsonb),
      'exceptions', coalesce((select jsonb_agg(jsonb_build_object('projectId', project_id, 'cents', cents)) from completed_rows where not held and cents <> 0), '[]'::jsonb)),
    'warrantyReserve', jsonb_build_object(
      'ledgerCents', (select cents from consumed_ledger),
      'subledgerCents', (select coalesce(sum(v.books_reserve_consumed_cents), 0)::bigint from public.warranty_service_visits v
        where v.org_id = p_org_id and v.books_cost_approved_at is not null and v.books_cost_date <= p_as_of))
  );
$$;
revoke all on function public.books_home_inventory_controls(uuid, date) from public, anon, authenticated;
grant execute on function public.books_home_inventory_controls(uuid, date) to service_role;

-- ==== 20261007210000_books_development_allocation_review ====
-- B11.3: shared development cost reaches lots only through a reviewed allocation.
-- A proposal states the basis (equal per lot, front footage, square footage,
-- sales value, or a custom schedule), each lot's weight and the total; the
-- database computes each lot's share in exact cents (largest remainder, ties by
-- lot), so the shares always add back to the total. A different person approves
-- it, and only then does it post. Proposals are never edited; a correction is a
-- new proposal.

create table public.books_development_allocations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  allocation_date date not null,
  reference text not null check (length(btrim(reference)) between 3 and 120),
  basis text not null check (basis in ('equal','front_footage','square_footage','sales_value','custom')),
  total_cents bigint not null check (total_cents > 0),
  shares jsonb not null check (jsonb_typeof(shares) = 'array' and jsonb_array_length(shares) between 1 and 250),
  evidence_url text not null check (evidence_url like 'https://%'),
  note text not null check (length(trim(note)) between 10 and 4000),
  status text not null default 'proposed' check (status in ('proposed','approved','rejected')),
  prepared_by uuid not null references public.app_users(id),
  prepared_at timestamptz not null default clock_timestamp(),
  reviewed_by uuid references public.app_users(id),
  reviewed_at timestamptz,
  review_note text,
  journal_entry_id uuid references public.journal_entries(id) on delete restrict,
  constraint books_development_allocations_review_check check ((status = 'proposed') = (reviewed_by is null)),
  constraint books_development_allocations_independent_check check (reviewed_by is null or reviewed_by <> prepared_by),
  unique (org_id, reference)
);
create index books_development_allocations_project_idx on public.books_development_allocations (org_id, project_id, prepared_at desc);
create index books_development_allocations_prepared_by_idx on public.books_development_allocations (prepared_by);
create index books_development_allocations_reviewed_by_idx on public.books_development_allocations (reviewed_by) where reviewed_by is not null;
create index books_development_allocations_entry_idx on public.books_development_allocations (journal_entry_id) where journal_entry_id is not null;
alter table public.books_development_allocations enable row level security;
create policy books_development_allocations_read on public.books_development_allocations
  for select to authenticated using (public.has_org_permission(org_id, 'books.read'));
grant select on public.books_development_allocations to authenticated;

create or replace function public.books_guard_development_allocation()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'Development allocations are kept; propose a correction instead'; end if;
  if old.status <> 'proposed' then raise exception 'A reviewed development allocation cannot change'; end if;
  if (new.org_id, new.project_id, new.allocation_date, new.reference, new.basis, new.total_cents, new.shares, new.evidence_url, new.note, new.prepared_by, new.prepared_at)
    is distinct from (old.org_id, old.project_id, old.allocation_date, old.reference, old.basis, old.total_cents, old.shares, old.evidence_url, old.note, old.prepared_by, old.prepared_at) then
    raise exception 'Only the review decision of a development allocation can be recorded';
  end if;
  return new;
end;
$$;
revoke all on function public.books_guard_development_allocation() from public, anon, authenticated;
create trigger books_development_allocations_guard before update or delete on public.books_development_allocations
  for each row execute function public.books_guard_development_allocation();

-- Exact shares by largest remainder: floor of each weighted share, then one more
-- cent to the largest remainders (ties by key) until the total is reached. Every
-- reviewed allocation (development to lots, shared cost to jobs) splits through it.
create or replace function public.books_allocation_shares(p_total bigint, p_weights jsonb)
returns jsonb language sql immutable set search_path = public as $$
  with w as (
    select value->>'key' as key, (value->>'weight')::numeric as weight from jsonb_array_elements(p_weights)
  ), t as (select sum(weight) as total_weight from w), raw as (
    select w.key, w.weight, floor(p_total * w.weight / t.total_weight)::bigint as base, (p_total * w.weight / t.total_weight) - floor(p_total * w.weight / t.total_weight) as remainder from w, t
  ), ranked as (
    select raw.*, row_number() over (order by remainder desc, key) as rank, p_total - sum(base) over () as leftover from raw
  )
  select coalesce(jsonb_agg(jsonb_build_object('key', key, 'weight', weight, 'amount_cents', base + case when rank <= leftover then 1 else 0 end) order by key), '[]'::jsonb) from ranked;
$$;

create or replace function public.propose_books_development_allocation(
  p_org_id uuid, p_project_id uuid, p_date date, p_reference text, p_basis text, p_total_cents bigint, p_weights jsonb, p_evidence_url text, p_note text, p_actor_id uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_row jsonb; v_shares jsonb; v_id uuid;
begin
  if not exists(select 1 from public.project_financial_settings where org_id = p_org_id and project_id = p_project_id and books_inventory_enabled) then
    raise exception 'The source project must hold owned development inventory';
  end if;
  if p_actor_id is null or not exists(select 1 from public.app_users where id = p_actor_id) then raise exception 'A preparer is required'; end if;
  if jsonb_typeof(p_weights) is distinct from 'array' or jsonb_array_length(p_weights) = 0 then raise exception 'Give each receiving lot its share of the basis'; end if;
  if (select count(*) from jsonb_array_elements(p_weights)) <> (select count(distinct value->>'lot_id') from jsonb_array_elements(p_weights)) then raise exception 'Name each lot once'; end if;
  for v_row in select value from jsonb_array_elements(p_weights) loop
    if coalesce((v_row->>'weight')::numeric, 0) <= 0 then raise exception 'Each lot''s basis must be positive'; end if;
    if not exists(select 1 from public.lots where org_id = p_org_id and id = (v_row->>'lot_id')::uuid) then raise exception 'A receiving lot is outside this organization'; end if;
  end loop;
  select jsonb_agg(jsonb_build_object('lot_id', s->>'key', 'weight', s->'weight', 'amount_cents', s->'amount_cents') order by s->>'key') into v_shares
    from jsonb_array_elements(public.books_allocation_shares(p_total_cents,
      (select jsonb_agg(jsonb_build_object('key', w->>'lot_id', 'weight', w->'weight')) from jsonb_array_elements(p_weights) w))) s;
  if (select sum((value->>'amount_cents')::bigint) from jsonb_array_elements(v_shares)) <> p_total_cents then raise exception 'Allocation shares must add to the total'; end if;
  insert into public.books_development_allocations(org_id, project_id, allocation_date, reference, basis, total_cents, shares, evidence_url, note, prepared_by)
  values (p_org_id, p_project_id, p_date, btrim(p_reference), p_basis, p_total_cents, v_shares, p_evidence_url, trim(p_note), p_actor_id)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.propose_books_development_allocation(uuid,uuid,date,text,text,bigint,jsonb,text,text,uuid) from public, anon, authenticated;
grant execute on function public.propose_books_development_allocation(uuid,uuid,date,text,text,bigint,jsonb,text,text,uuid) to service_role;

create or replace function public.review_books_development_allocation(p_org_id uuid, p_allocation_id uuid, p_approve boolean, p_note text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.books_development_allocations%rowtype; v_entry uuid;
begin
  select * into v from public.books_development_allocations where id = p_allocation_id and org_id = p_org_id for update;
  if not found then raise exception 'Development allocation not found'; end if;
  if v.status <> 'proposed' then raise exception 'This allocation has already been reviewed'; end if;
  if p_actor_id is null or p_actor_id = v.prepared_by then raise exception 'A development allocation is approved by someone other than the person who proposed it'; end if;
  if not p_approve and length(trim(coalesce(p_note, ''))) < 10 then raise exception 'Say why the allocation is rejected'; end if;
  if p_approve then
    v_entry := public.allocate_books_development_cost(p_org_id, v.project_id, v.allocation_date,
      (select jsonb_agg(jsonb_build_object('lot_id', value->>'lot_id', 'amount_cents', (value->>'amount_cents')::bigint)) from jsonb_array_elements(v.shares)),
      v.reference, v.evidence_url, p_actor_id);
  end if;
  update public.books_development_allocations set status = case when p_approve then 'approved' else 'rejected' end,
    reviewed_by = p_actor_id, reviewed_at = clock_timestamp(), review_note = nullif(trim(coalesce(p_note, '')), ''), journal_entry_id = v_entry
    where id = v.id;
  return jsonb_build_object('allocationId', v.id, 'projectId', v.project_id, 'status', case when p_approve then 'approved' else 'rejected' end, 'journalEntryId', v_entry);
end;
$$;
revoke all on function public.review_books_development_allocation(uuid,uuid,boolean,text,uuid) from public, anon, authenticated;
grant execute on function public.review_books_development_allocation(uuid,uuid,boolean,text,uuid) to service_role;

-- ==== 20261007220000_books_home_closing_reversal ====
-- B11.3: a recorded home closing can be reversed, and the reversal puts the
-- books back exactly. The money side runs first in the service (the balance
-- payment refunded, the deposit applications reversed so the deposit liability
-- returns, and a full credit memo taking the sale out of revenue). This function
-- then, atomically: returns the home's relieved cost to inventory component by
-- component (the exact negative of the relief), clears the sale date, withdraws
-- the remaining warranty provision, returns the lot to started and records the
-- closing as cancelled with who reversed it and why. Nothing is deleted.

create or replace function public.guard_closing_settlement_evidence() returns trigger
language plpgsql security definer set search_path=public,pg_catalog as $$
declare gates integer;
begin
 if tg_op='DELETE' then
  if old.status in ('closed','cancelled') then raise exception 'Recorded closing history cannot be deleted'; end if;
  return old;
 end if;
 if tg_op='UPDATE' then
  if (new.id,new.org_id,new.project_id,new.lot_id,new.community_id) is distinct from (old.id,old.org_id,old.project_id,old.lot_id,old.community_id) then raise exception 'Closing home identity cannot change'; end if;
  -- The one change a recorded closing allows: its reversal, made only by
  -- reverse_books_home_closing (which sets arc.closing_reversal for this row).
  if old.status='closed' and new.status='cancelled' and current_setting('arc.closing_reversal', true)=old.id::text
   and (new.scheduled_date,new.actual_date,new.settlement,new.closing_invoice_id) is not distinct from (old.scheduled_date,old.actual_date,old.settlement,old.closing_invoice_id) then
   return new;
  end if;
  if old.status in ('closed','cancelled') and
   (new.status,new.scheduled_date,new.actual_date,new.settlement,new.closing_invoice_id,new.cancel_reason,new.metadata->'adjustments') is distinct from
   (old.status,old.scheduled_date,old.actual_date,old.settlement,old.closing_invoice_id,old.cancel_reason,old.metadata->'adjustments') then
   raise exception 'Recorded closing settlement evidence is immutable';
  end if;
 end if;
 if new.status='closed' and (tg_op='INSERT' or old.status<>'closed') then
  if new.closing_invoice_id is null then raise exception 'Closing invoice evidence is required'; end if;
  if jsonb_typeof(new.settlement->'finalPriceCents') is distinct from 'number' or coalesce(new.settlement->>'finalPriceCents','')!~'^[0-9]+$' then raise exception 'Recorded final price cents are invalid'; end if;
  if (new.settlement->>'finalPriceCents')::numeric>9007199254740991 then raise exception 'Recorded final price exceeds safe integer cents'; end if;
  perform 1 from public.invoices where id=new.closing_invoice_id and org_id=new.org_id and project_id=new.project_id and total_cents=(new.settlement->>'finalPriceCents')::numeric for share;
  if not found then raise exception 'Closing invoice belongs to another home, is unavailable or differs from the settlement'; end if;
  perform 1 from public.files f where exists(select 1 from public.closing_checklist_items i
    where i.closing_id=new.id and i.org_id=new.org_id and i.is_gate and i.file_id=f.id) order by f.id for share;
  select count(*) into gates from public.closing_checklist_items where closing_id=new.id and org_id=new.org_id and is_gate;
  if gates=0 then raise exception 'Closing readiness gates are missing'; end if;
  -- No child row locks: checklist writers take the parent lock and either
  -- commit before this read or fail after the parent becomes closed.
  if exists(select 1 from public.closing_checklist_items i where i.closing_id=new.id and i.org_id=new.org_id and i.is_gate and
   (i.status='open' or i.completed_by is null or i.completed_at is null or (i.status='waived' and length(btrim(coalesce(i.notes,'')))<10) or
    (i.file_id is not null and not exists(select 1 from public.files f where f.id=i.file_id and f.org_id=new.org_id and f.project_id=new.project_id and f.archived_at is null)))) then
   raise exception 'Closing readiness gate evidence is incomplete';
  end if;
 end if;
 return new;
end $$;

create or replace function public.reverse_books_home_closing(p_org_id uuid, p_closing_id uuid, p_date date, p_reason text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_closing public.closings%rowtype; v_invoice public.invoices%rowtype; v_settings public.project_financial_settings%rowtype;
  v_cogs uuid; v_reserve uuid; v_expense uuid; v_policy integer; v_lines jsonb := '[]'::jsonb; v_line integer := 0; v_row record; v_inventory uuid; v_warranty uuid; v_reserve_cents bigint; v_revision integer;
begin
  select * into v_closing from public.closings where id = p_closing_id and org_id = p_org_id for update;
  if not found then raise exception 'Closing not found'; end if;
  if v_closing.status <> 'closed' then raise exception 'Only a recorded closing can be reversed'; end if;
  if p_actor_id is null or length(trim(coalesce(p_reason, ''))) < 10 then raise exception 'Say why the closing is reversed'; end if;
  if exists(select 1 from public.accounting_periods where org_id = p_org_id and status = 'closed' and p_date between period_start and period_end) then
    raise exception 'The reversal date is in a closed month; date it in an open month';
  end if;
  select * into v_invoice from public.invoices where id = v_closing.closing_invoice_id and org_id = p_org_id for update;
  if not found then raise exception 'Closing invoice not found'; end if;
  -- The money comes off first: nothing still owed, nothing still collected, and the sale credited in full.
  if coalesce(v_invoice.balance_due_cents, 0) <> 0
    or coalesce((select sum(a.amount_cents) from public.receivable_adjustments a where a.org_id = p_org_id and a.invoice_id = v_invoice.id and a.adjustment_type = 'credit_memo' and a.status = 'posted'), 0) <> v_invoice.total_cents then
    raise exception 'Refund the closing payment, reverse the deposit applications and credit the sale in full before reversing the closing';
  end if;
  select * into v_settings from public.project_financial_settings where org_id = p_org_id and project_id = v_closing.project_id for update;
  select active_policy_version into v_policy from public.books_settings where org_id = p_org_id;
  select id into v_cogs from public.gl_accounts where org_id = p_org_id and code = '5000' and active;
  -- Inventory back, component by component: the exact negative of every relief.
  if v_settings.books_inventory_sold_on is not null then
    for v_row in
      select l.account_id, coalesce(l.dimensions->>'cost_component', 'construction') as component, sum(l.debit_cents - l.credit_cents)::bigint as cents
      from public.journal_lines l join public.journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      where l.org_id = p_org_id and l.project_id = v_closing.project_id and e.status in ('posted','reversed')
        and (e.source_type = 'inventory_sale_relief' or exists(select 1 from public.journal_entries o where o.id = e.reversal_of_entry_id and o.source_type = 'inventory_sale_relief'))
      group by 1, 2 having sum(l.debit_cents - l.credit_cents) <> 0 order by 2, 1
    loop
      v_line := v_line + 1;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('line_no', v_line, 'account_id', v_row.account_id, 'project_id', v_closing.project_id,
        'debit_cents', greatest(-v_row.cents, 0), 'credit_cents', greatest(v_row.cents, 0),
        'dimensions', jsonb_build_object('inventory_transition', 'sale_reversal', 'closing_id', v_closing.id) || case when v_row.account_id = v_cogs then jsonb_build_object('cost_component', v_row.component) else '{}'::jsonb end));
    end loop;
    if jsonb_array_length(v_lines) > 0 then
      select count(*) + 1 into v_revision from public.journal_entries where org_id = p_org_id and source_type = 'inventory_sale_relief' and source_id = v_closing.project_id;
      v_inventory := public.post_books_journal_entry(p_org_id, jsonb_build_object('entry_date', p_date, 'entry_kind', 'adjusting', 'memo', 'Closing reversed: home returned to inventory',
        'posting_key', 'inventory:' || v_closing.project_id || ':sale_reversal:' || v_revision, 'projection_version', 1, 'policy_version', v_policy,
        'source_type', 'inventory_sale_relief', 'source_id', v_closing.project_id, 'created_by', p_actor_id), v_lines);
    end if;
    update public.project_financial_settings set books_inventory_sold_on = null, updated_at = now() where org_id = p_org_id and project_id = v_closing.project_id;
  end if;
  -- The warranty provision made at closing is withdrawn (what remains of it).
  select id into v_reserve from public.gl_accounts where org_id = p_org_id and code = '2260' and active;
  select id into v_expense from public.gl_accounts where org_id = p_org_id and code = '5050' and active;
  select coalesce(sum(l.credit_cents - l.debit_cents), 0) into v_reserve_cents from public.journal_lines l join public.journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
    where l.org_id = p_org_id and l.project_id = v_closing.project_id and l.account_id = v_reserve and e.status in ('posted','reversed');
  if v_reserve_cents <> 0 then
    select count(*) + 1 into v_revision from public.journal_entries where org_id = p_org_id and source_type = 'warranty_reserve' and source_id = v_closing.project_id;
    v_warranty := public.post_books_journal_entry(p_org_id, jsonb_build_object('entry_date', p_date, 'entry_kind', 'adjusting', 'memo', 'Closing reversed: warranty provision withdrawn',
      'posting_key', 'warranty_reserve:' || v_closing.project_id || ':' || v_revision, 'projection_version', 1, 'policy_version', v_policy,
      'source_type', 'warranty_reserve', 'source_id', v_closing.project_id, 'created_by', p_actor_id),
      jsonb_build_array(
        jsonb_build_object('line_no', 1, 'account_id', v_reserve, 'project_id', v_closing.project_id, 'debit_cents', greatest(v_reserve_cents, 0), 'credit_cents', greatest(-v_reserve_cents, 0), 'dimensions', jsonb_build_object('warranty_reserve_adjustment', true, 'closing_id', v_closing.id)),
        jsonb_build_object('line_no', 2, 'account_id', v_expense, 'project_id', v_closing.project_id, 'debit_cents', greatest(-v_reserve_cents, 0), 'credit_cents', greatest(v_reserve_cents, 0), 'dimensions', jsonb_build_object('warranty_reserve_adjustment', true, 'closing_id', v_closing.id))));
  end if;
  update public.project_financial_settings set books_warranty_provisioned_on = null, updated_at = now() where org_id = p_org_id and project_id = v_closing.project_id;
  update public.lots set status = 'started', updated_at = now() where org_id = p_org_id and id = v_closing.lot_id and status = 'closed';
  perform set_config('arc.closing_reversal', v_closing.id::text, true);
  update public.closings set status = 'cancelled', cancel_reason = trim(p_reason),
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('reversed_at', now(), 'reversed_by', p_actor_id, 'reversed_on', p_date, 'reversal_inventory_entry_id', v_inventory, 'reversal_warranty_entry_id', v_warranty)
    where id = v_closing.id;
  perform set_config('arc.closing_reversal', '', true);
  return jsonb_build_object('closingId', v_closing.id, 'projectId', v_closing.project_id, 'inventoryEntryId', v_inventory, 'warrantyEntryId', v_warranty);
end;
$$;
revoke all on function public.reverse_books_home_closing(uuid,uuid,date,text,uuid) from public, anon, authenticated;
grant execute on function public.reverse_books_home_closing(uuid,uuid,date,text,uuid) to service_role;

-- ==== 20261007230000_books_cost_allocations ====
-- B11.4: shared construction cost (equipment, overhead, insurance, supervision)
-- reaches jobs only through a reviewed allocation.
--
-- * The pool is the source expense account's balance that sits on no job. Costs
--   already charged to a job (time entries, bills, payroll) are never in it, and
--   every allocation draws the pool down, so the same depreciation or overhead
--   cannot be allocated twice.
-- * A proposal states the pool, the basis and each destination's weight; one
--   destination may be "retained" (the part that stays company overhead). The
--   database splits the total in exact cents (books_allocation_shares) and a
--   different member approves it before anything posts.
-- * Approval posts one journal (credit the pool, debit each job's cost account —
--   inventory for a home the builder owns, by the same date rule as any other
--   cost) and one job-cost row per destination line, keyed on that journal line,
--   so budget, job cost, WIP and the statements read the same cents.
-- * A reallocation reverses the original (both legs stay on record: the original
--   entry, its exact reversal and the negative job-cost rows) and posts the new
--   split, in one transaction.

alter table public.job_cost_entries drop constraint job_cost_entries_source_type_check;
alter table public.job_cost_entries add constraint job_cost_entries_source_type_check check (source_type = any (array[
  'vendor_bill_line','project_expense','project_expense_line','time_entry','bank_transaction','inventory_event','payroll_import','payroll_correction','cost_allocation']));

create table public.books_cost_allocations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  allocation_date date not null,
  reference text not null check (length(btrim(reference)) between 3 and 120),
  pool text not null check (pool in ('equipment','overhead','insurance','supervision','other')),
  basis text not null check (basis in ('equal','labor_hours','direct_cost','equipment_hours','custom')),
  source_account_id uuid not null references public.gl_accounts(id) on delete restrict,
  cost_code_id uuid references public.cost_codes(id) on delete restrict,
  total_cents bigint not null check (total_cents > 0),
  shares jsonb not null check (jsonb_typeof(shares) = 'array' and jsonb_array_length(shares) between 1 and 250),
  evidence_url text not null check (evidence_url like 'https://%'),
  note text not null check (length(trim(note)) between 10 and 4000),
  corrects_allocation_id uuid references public.books_cost_allocations(id) on delete restrict,
  status text not null default 'proposed' check (status in ('proposed','approved','rejected','reallocated')),
  prepared_by uuid not null references public.app_users(id),
  prepared_at timestamptz not null default clock_timestamp(),
  reviewed_by uuid references public.app_users(id),
  reviewed_at timestamptz,
  review_note text,
  journal_entry_id uuid references public.journal_entries(id) on delete restrict,
  reversal_entry_id uuid references public.journal_entries(id) on delete restrict,
  constraint books_cost_allocations_review_check check ((status = 'proposed') = (reviewed_by is null)),
  constraint books_cost_allocations_independent_check check (reviewed_by is null or reviewed_by <> prepared_by),
  constraint books_cost_allocations_posted_check check ((status in ('approved','reallocated')) = (journal_entry_id is not null)),
  constraint books_cost_allocations_reversal_check check ((status = 'reallocated') = (reversal_entry_id is not null)),
  unique (org_id, reference)
);
create index books_cost_allocations_org_date_idx on public.books_cost_allocations (org_id, allocation_date desc);
create index books_cost_allocations_source_account_idx on public.books_cost_allocations (source_account_id);
create index books_cost_allocations_cost_code_idx on public.books_cost_allocations (cost_code_id) where cost_code_id is not null;
create index books_cost_allocations_corrects_idx on public.books_cost_allocations (corrects_allocation_id) where corrects_allocation_id is not null;
create unique index books_cost_allocations_one_correction_idx on public.books_cost_allocations (corrects_allocation_id) where corrects_allocation_id is not null and status in ('proposed','approved','reallocated');
create index books_cost_allocations_prepared_by_idx on public.books_cost_allocations (prepared_by);
create index books_cost_allocations_reviewed_by_idx on public.books_cost_allocations (reviewed_by) where reviewed_by is not null;
create index books_cost_allocations_entry_idx on public.books_cost_allocations (journal_entry_id) where journal_entry_id is not null;
create index books_cost_allocations_reversal_idx on public.books_cost_allocations (reversal_entry_id) where reversal_entry_id is not null;
alter table public.books_cost_allocations enable row level security;
create policy books_cost_allocations_read on public.books_cost_allocations
  for select to authenticated using (public.has_org_permission(org_id, 'books.read'));
grant select on public.books_cost_allocations to authenticated;

create or replace function public.books_guard_cost_allocation()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'Cost allocations are kept; propose a reallocation instead'; end if;
  if (new.org_id, new.allocation_date, new.reference, new.pool, new.basis, new.source_account_id, new.cost_code_id, new.total_cents, new.shares, new.evidence_url, new.note, new.corrects_allocation_id, new.prepared_by, new.prepared_at)
    is distinct from (old.org_id, old.allocation_date, old.reference, old.pool, old.basis, old.source_account_id, old.cost_code_id, old.total_cents, old.shares, old.evidence_url, old.note, old.corrects_allocation_id, old.prepared_by, old.prepared_at) then
    raise exception 'A cost allocation proposal cannot change; propose a new one';
  end if;
  if not (old.status = 'proposed' and new.status in ('approved','rejected')) and not (old.status = 'approved' and new.status = 'reallocated') then
    raise exception 'A reviewed cost allocation cannot change';
  end if;
  return new;
end;
$$;
revoke all on function public.books_guard_cost_allocation() from public, anon, authenticated;
create trigger books_cost_allocations_guard before update or delete on public.books_cost_allocations
  for each row execute function public.books_guard_cost_allocation();

-- The pool: what the source account holds on no job as of a date.
create or replace function public.books_cost_pool_cents(p_org_id uuid, p_account_id uuid, p_as_of date)
returns bigint language sql stable set search_path = public as $$
  select coalesce(sum(l.debit_cents - l.credit_cents), 0)::bigint
  from public.journal_lines l join public.journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
  where l.org_id = p_org_id and l.account_id = p_account_id and l.project_id is null and e.status in ('posted','reversed') and e.entry_date <= p_as_of;
$$;
revoke all on function public.books_cost_pool_cents(uuid,uuid,date) from public, anon, authenticated;
grant execute on function public.books_cost_pool_cents(uuid,uuid,date) to service_role;

create or replace function public.propose_books_cost_allocation(
  p_org_id uuid, p_date date, p_reference text, p_pool text, p_basis text, p_source_account_id uuid, p_cost_code_id uuid,
  p_total_cents bigint, p_weights jsonb, p_evidence_url text, p_note text, p_corrects uuid, p_actor_id uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_row jsonb; v_shares jsonb; v_id uuid; v_original public.books_cost_allocations%rowtype; v_moved bigint;
begin
  if p_actor_id is null or not exists(select 1 from public.app_users where id = p_actor_id) then raise exception 'A preparer is required'; end if;
  if not exists(select 1 from public.gl_accounts where org_id = p_org_id and id = p_source_account_id and active and account_type = 'expense') then
    raise exception 'Allocate from a company expense account (the pool); job costs are already on their jobs';
  end if;
  if p_cost_code_id is not null and not exists(select 1 from public.cost_codes where org_id = p_org_id and id = p_cost_code_id) then raise exception 'The cost code is outside this organization'; end if;
  if jsonb_typeof(p_weights) is distinct from 'array' or jsonb_array_length(p_weights) = 0 then raise exception 'Give each destination its share of the basis'; end if;
  if (select count(*) from jsonb_array_elements(p_weights)) <> (select count(distinct coalesce(value->>'project_id', 'retained')) from jsonb_array_elements(p_weights)) then raise exception 'Name each destination once'; end if;
  if not exists(select 1 from jsonb_array_elements(p_weights) where value->>'project_id' is not null) then raise exception 'Allocate to at least one job'; end if;
  for v_row in select value from jsonb_array_elements(p_weights) loop
    if coalesce((v_row->>'weight')::numeric, 0) <= 0 then raise exception 'Each destination''s basis must be positive'; end if;
    if v_row->>'project_id' is not null and not exists(select 1 from public.projects where org_id = p_org_id and id = (v_row->>'project_id')::uuid) then raise exception 'A destination job is outside this organization'; end if;
  end loop;
  if exists(select 1 from public.accounting_periods where org_id = p_org_id and status = 'closed' and p_date between period_start and period_end) then raise exception 'The allocation date is in a closed month'; end if;
  if p_corrects is not null then
    select * into v_original from public.books_cost_allocations where org_id = p_org_id and id = p_corrects;
    if not found or v_original.status <> 'approved' then raise exception 'Only an approved allocation can be reallocated'; end if;
    if v_original.source_account_id <> p_source_account_id then raise exception 'A reallocation draws on the same pool as the allocation it corrects'; end if;
    if p_date < v_original.allocation_date then raise exception 'A reallocation cannot be dated before the allocation it corrects'; end if;
  end if;
  select jsonb_agg(jsonb_build_object('project_id', nullif(s->>'key', 'retained'), 'weight', s->'weight', 'amount_cents', s->'amount_cents') order by s->>'key') into v_shares
    from jsonb_array_elements(public.books_allocation_shares(p_total_cents,
      (select jsonb_agg(jsonb_build_object('key', coalesce(w->>'project_id', 'retained'), 'weight', w->'weight')) from jsonb_array_elements(p_weights) w))) s;
  if (select sum((value->>'amount_cents')::bigint) from jsonb_array_elements(v_shares)) <> p_total_cents then raise exception 'Allocation shares must add to the total'; end if;
  select coalesce(sum((value->>'amount_cents')::bigint), 0) into v_moved from jsonb_array_elements(v_shares) where value->>'project_id' is not null;
  if v_moved > public.books_cost_pool_cents(p_org_id, p_source_account_id, p_date) + coalesce((select sum(l.debit_cents) from public.journal_lines l
       where l.org_id = p_org_id and l.entry_id = v_original.journal_entry_id and l.project_id is not null), 0) then
    raise exception 'The allocation exceeds the unallocated pool on that account at that date';
  end if;
  insert into public.books_cost_allocations(org_id, allocation_date, reference, pool, basis, source_account_id, cost_code_id, total_cents, shares, evidence_url, note, corrects_allocation_id, prepared_by)
  values (p_org_id, p_date, btrim(p_reference), p_pool, p_basis, p_source_account_id, p_cost_code_id, p_total_cents, v_shares, p_evidence_url, trim(p_note), p_corrects, p_actor_id)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.propose_books_cost_allocation(uuid,date,text,text,text,uuid,uuid,bigint,jsonb,text,text,uuid,uuid) from public, anon, authenticated;
grant execute on function public.propose_books_cost_allocation(uuid,date,text,text,text,uuid,uuid,bigint,jsonb,text,text,uuid,uuid) to service_role;

-- A job's cost account on a date: inventory while the builder owns the home, cost
-- of sales otherwise (the same rule as inventoryCostAccount in the application).
create or replace function public.books_job_cost_account_code(p_org_id uuid, p_project_id uuid, p_date date)
returns text language sql stable set search_path = public as $$
  select case
    when s.project_id is null or not s.books_inventory_enabled or s.books_inventory_effective_on is null or p_date < s.books_inventory_effective_on then '5000'
    when s.books_inventory_sold_on is not null and p_date >= s.books_inventory_sold_on then '5000'
    when s.books_inventory_completed_on is not null and p_date >= s.books_inventory_completed_on then '1170'
    else '1160' end
  from (select 1) one left join public.project_financial_settings s on s.org_id = p_org_id and s.project_id = p_project_id;
$$;
revoke all on function public.books_job_cost_account_code(uuid,uuid,date) from public, anon, authenticated;
grant execute on function public.books_job_cost_account_code(uuid,uuid,date) to service_role;

create or replace function public.review_books_cost_allocation(p_org_id uuid, p_allocation_id uuid, p_approve boolean, p_note text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.books_cost_allocations%rowtype; v_original public.books_cost_allocations%rowtype; v_policy integer; v_entry uuid; v_reversal uuid;
  v_lines jsonb := '[]'::jsonb; v_line integer := 0; v_share jsonb; v_code text; v_sold date; v_moved bigint := 0; v_dims jsonb; v_row record;
begin
  select * into v from public.books_cost_allocations where id = p_allocation_id and org_id = p_org_id for update;
  if not found then raise exception 'Cost allocation not found'; end if;
  if v.status <> 'proposed' then raise exception 'This allocation has already been reviewed'; end if;
  if p_actor_id is null or p_actor_id = v.prepared_by then raise exception 'A cost allocation is approved by someone other than the person who proposed it'; end if;
  if not p_approve then
    if length(trim(coalesce(p_note, ''))) < 10 then raise exception 'Say why the allocation is rejected'; end if;
    update public.books_cost_allocations set status = 'rejected', reviewed_by = p_actor_id, reviewed_at = clock_timestamp(), review_note = trim(p_note) where id = v.id;
    return jsonb_build_object('allocationId', v.id, 'status', 'rejected', 'journalEntryId', null, 'reversalEntryId', null);
  end if;
  -- One pool at a time: concurrent approvals cannot both spend the same balance.
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':cost-pool:' || v.source_account_id::text, 0));
  select active_policy_version into v_policy from public.books_settings where org_id = p_org_id;
  if v_policy is null then raise exception 'Books posting is not enabled'; end if;
  -- A reallocation first reverses what it corrects: the entry and its job-cost rows.
  if v.corrects_allocation_id is not null then
    select * into v_original from public.books_cost_allocations where id = v.corrects_allocation_id and org_id = p_org_id for update;
    if v_original.status <> 'approved' then raise exception 'The allocation being corrected was already reallocated'; end if;
    v_reversal := (public.reverse_books_journal_entry(p_org_id, v_original.journal_entry_id,
      jsonb_build_object('entry_date', v.allocation_date, 'entry_kind', 'reversal', 'reversal_of_entry_id', v_original.journal_entry_id,
        'memo', 'Reallocated: ' || v_original.reference, 'posting_key', 'cost_allocation_reversal:' || v_original.id, 'projection_version', 1, 'policy_version', v_policy,
        'source_type', 'cost_allocation', 'source_id', v_original.id, 'created_by', p_actor_id),
      (select jsonb_agg(jsonb_build_object('line_no', l.line_no, 'account_id', l.account_id, 'project_id', l.project_id, 'debit_cents', l.credit_cents, 'credit_cents', l.debit_cents,
          'dimensions', l.dimensions) order by l.line_no)
        from public.journal_lines l where l.org_id = p_org_id and l.entry_id = v_original.journal_entry_id))->>'id')::uuid;
    update public.journal_entries set status = 'reversed' where org_id = p_org_id and id = v_original.journal_entry_id and status = 'posted';
    for v_row in select l.id, l.project_id, l.debit_cents - l.credit_cents as cents, l.dimensions from public.journal_lines l
      where l.org_id = p_org_id and l.entry_id = v_reversal and l.project_id is not null loop
      insert into public.job_cost_entries(org_id, project_id, cost_code_id, source_type, source_id, incurred_on, cost_cents, status, is_billable, metadata)
      values (p_org_id, v_row.project_id, v_original.cost_code_id, 'cost_allocation', v_row.id::text, v.allocation_date, v_row.cents, 'posted', false,
        jsonb_build_object('cost_allocation_id', v_original.id, 'reallocated_by', v.id, 'pool', v_original.pool));
    end loop;
    update public.books_cost_allocations set status = 'reallocated', reversal_entry_id = v_reversal where id = v_original.id;
  end if;
  for v_share in select value from jsonb_array_elements(v.shares) where value->>'project_id' is not null order by value->>'project_id' loop
    v_code := public.books_job_cost_account_code(p_org_id, (v_share->>'project_id')::uuid, v.allocation_date);
    select books_inventory_sold_on into v_sold from public.project_financial_settings where org_id = p_org_id and project_id = (v_share->>'project_id')::uuid and books_inventory_enabled;
    v_dims := jsonb_build_object('cost_allocation_id', v.id, 'pool', v.pool, 'cost_type', 'allocated_' || v.pool)
      || case when v.cost_code_id is not null then jsonb_build_object('cost_code_id', v.cost_code_id) else '{}'::jsonb end
      || case when v_sold is not null and v.allocation_date >= v_sold then jsonb_build_object('closed_home_cost', true) else '{}'::jsonb end;
    v_line := v_line + 1;
    v_moved := v_moved + (v_share->>'amount_cents')::bigint;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('line_no', v_line, 'account_id', (select id from public.gl_accounts where org_id = p_org_id and code = v_code and active),
      'project_id', (v_share->>'project_id')::uuid, 'debit_cents', (v_share->>'amount_cents')::bigint, 'credit_cents', 0, 'dimensions', v_dims));
  end loop;
  if v_moved > public.books_cost_pool_cents(p_org_id, v.source_account_id, v.allocation_date) then
    raise exception 'The allocation exceeds the unallocated pool on that account at that date';
  end if;
  v_lines := v_lines || jsonb_build_array(jsonb_build_object('line_no', v_line + 1, 'account_id', v.source_account_id, 'project_id', null,
    'debit_cents', 0, 'credit_cents', v_moved, 'dimensions', jsonb_build_object('cost_allocation_id', v.id, 'pool', v.pool, 'basis', v.basis, 'evidence_url', v.evidence_url)));
  v_entry := public.post_books_journal_entry(p_org_id, jsonb_build_object('entry_date', v.allocation_date, 'entry_kind', 'adjusting', 'memo', 'Allocate ' || v.pool || ': ' || v.reference,
    'posting_key', 'cost_allocation:' || v.id, 'projection_version', 1, 'policy_version', v_policy, 'source_type', 'cost_allocation', 'source_id', v.id, 'created_by', p_actor_id), v_lines);
  for v_row in select l.id, l.project_id, l.debit_cents as cents from public.journal_lines l where l.org_id = p_org_id and l.entry_id = v_entry and l.project_id is not null loop
    insert into public.job_cost_entries(org_id, project_id, cost_code_id, source_type, source_id, incurred_on, cost_cents, status, is_billable, metadata)
    values (p_org_id, v_row.project_id, v.cost_code_id, 'cost_allocation', v_row.id::text, v.allocation_date, v_row.cents, 'posted', false,
      jsonb_build_object('cost_allocation_id', v.id, 'pool', v.pool, 'basis', v.basis));
  end loop;
  update public.books_cost_allocations set status = 'approved', reviewed_by = p_actor_id, reviewed_at = clock_timestamp(), review_note = nullif(trim(coalesce(p_note, '')), ''), journal_entry_id = v_entry
    where id = v.id;
  return jsonb_build_object('allocationId', v.id, 'status', 'approved', 'journalEntryId', v_entry, 'reversalEntryId', v_reversal);
end;
$$;
revoke all on function public.review_books_cost_allocation(uuid,uuid,boolean,text,uuid) from public, anon, authenticated;
grant execute on function public.review_books_cost_allocation(uuid,uuid,boolean,text,uuid) to service_role;

-- Every pool with something left to allocate, in one read for the register.
create or replace function public.books_cost_pools(p_org_id uuid, p_as_of date)
returns table (account_id uuid, code text, name text, cents bigint) language sql stable set search_path = public as $$
  select a.id, a.code, a.name, sum(l.debit_cents - l.credit_cents)::bigint
  from public.journal_lines l
  join public.journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
  join public.gl_accounts a on a.id = l.account_id and a.org_id = l.org_id
  where l.org_id = p_org_id and l.project_id is null and a.account_type = 'expense' and a.active and e.status in ('posted','reversed') and e.entry_date <= p_as_of
  group by a.id, a.code, a.name having sum(l.debit_cents - l.credit_cents) > 0
  order by a.code;
$$;
revoke all on function public.books_cost_pools(uuid,date) from public, anon, authenticated;
grant execute on function public.books_cost_pools(uuid,date) to service_role;

-- ==== 20261007235000_books_inventory_impairment ====
-- B12.2: a home the builder owns is written down, after review, when it is worth
-- less than it cost.
--
-- * Measurement (inventory, ASC 330): the carrying amount (1160 + 1170 on the
--   home as of the review date) against net realizable value = expected selling
--   price − cost to complete − cost to sell. The write-down is the excess; none
--   when net realizable value covers cost.
-- * A review is an immutable record of the assumptions, the evidence and the
--   numbers; a different member approves it, and only then does it post
--   (Dr 5070 inventory impairment / Cr 1160 or 1170). If the carrying amount
--   moved since the review was prepared, approval refuses: the review must be
--   prepared again on the current cost.
-- * A write-down is the home's new cost basis. It is never written back up when
--   the outlook recovers; a later review only writes down further.
-- * Owned homes earn at closing and never take a contract loss provision (the
--   provision is refused while capitalized cost exists), so a loss is recognized
--   once: through impairment.
-- * At the sale, the write-down is its own (negative) cost-of-sales component.

create table public.books_inventory_impairments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete restrict,
  as_of date not null,
  carrying_cents bigint not null check (carrying_cents > 0),
  selling_price_cents bigint not null check (selling_price_cents >= 0),
  cost_to_complete_cents bigint not null check (cost_to_complete_cents >= 0),
  cost_to_sell_cents bigint not null check (cost_to_sell_cents >= 0),
  net_realizable_cents bigint not null,
  write_down_cents bigint not null check (write_down_cents > 0),
  evidence_url text not null check (evidence_url like 'https://%'),
  assumptions text not null check (length(trim(assumptions)) between 10 and 4000),
  status text not null default 'proposed' check (status in ('proposed','approved','rejected')),
  prepared_by uuid not null references public.app_users(id),
  prepared_at timestamptz not null default clock_timestamp(),
  reviewed_by uuid references public.app_users(id),
  reviewed_at timestamptz,
  review_note text,
  journal_entry_id uuid references public.journal_entries(id) on delete restrict,
  constraint books_inventory_impairments_measure_check check (
    net_realizable_cents = selling_price_cents - cost_to_complete_cents - cost_to_sell_cents
    and write_down_cents = carrying_cents - net_realizable_cents),
  constraint books_inventory_impairments_review_check check ((status = 'proposed') = (reviewed_by is null)),
  constraint books_inventory_impairments_independent_check check (reviewed_by is null or reviewed_by <> prepared_by),
  constraint books_inventory_impairments_posted_check check ((status = 'approved') = (journal_entry_id is not null))
);
create index books_inventory_impairments_project_idx on public.books_inventory_impairments (org_id, project_id, as_of desc);
create unique index books_inventory_impairments_one_open_idx on public.books_inventory_impairments (project_id) where status = 'proposed';
create index books_inventory_impairments_project_fk_idx on public.books_inventory_impairments (project_id);
create index books_inventory_impairments_prepared_by_idx on public.books_inventory_impairments (prepared_by);
create index books_inventory_impairments_reviewed_by_idx on public.books_inventory_impairments (reviewed_by) where reviewed_by is not null;
create index books_inventory_impairments_entry_idx on public.books_inventory_impairments (journal_entry_id) where journal_entry_id is not null;
alter table public.books_inventory_impairments enable row level security;
create policy books_inventory_impairments_read on public.books_inventory_impairments
  for select to authenticated using (public.has_org_permission(org_id, 'books.read'));
grant select on public.books_inventory_impairments to authenticated;

create or replace function public.books_guard_inventory_impairment()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'Impairment reviews are kept'; end if;
  if old.status <> 'proposed' then raise exception 'A reviewed impairment cannot change; a write-down is the home''s new cost and is not written back up'; end if;
  if (new.org_id, new.project_id, new.as_of, new.carrying_cents, new.selling_price_cents, new.cost_to_complete_cents, new.cost_to_sell_cents, new.net_realizable_cents, new.write_down_cents, new.evidence_url, new.assumptions, new.prepared_by, new.prepared_at)
    is distinct from (old.org_id, old.project_id, old.as_of, old.carrying_cents, old.selling_price_cents, old.cost_to_complete_cents, old.cost_to_sell_cents, old.net_realizable_cents, old.write_down_cents, old.evidence_url, old.assumptions, old.prepared_by, old.prepared_at) then
    raise exception 'Only the review decision of an impairment can be recorded';
  end if;
  return new;
end;
$$;
revoke all on function public.books_guard_inventory_impairment() from public, anon, authenticated;
create trigger books_inventory_impairments_guard before update or delete on public.books_inventory_impairments
  for each row execute function public.books_guard_inventory_impairment();

-- The home's carrying amount: what sits in 1160 and 1170 on it as of a date.
create or replace function public.books_home_carrying_cents(p_org_id uuid, p_project_id uuid, p_as_of date)
returns bigint language sql stable set search_path = public as $$
  select coalesce(sum(l.debit_cents - l.credit_cents), 0)::bigint
  from public.journal_lines l
  join public.journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
  join public.gl_accounts a on a.id = l.account_id and a.org_id = l.org_id
  where l.org_id = p_org_id and l.project_id = p_project_id and a.code in ('1160','1170') and e.status in ('posted','reversed') and e.entry_date <= p_as_of;
$$;
revoke all on function public.books_home_carrying_cents(uuid,uuid,date) from public, anon, authenticated;
grant execute on function public.books_home_carrying_cents(uuid,uuid,date) to service_role;

create or replace function public.propose_books_inventory_impairment(
  p_org_id uuid, p_project_id uuid, p_as_of date, p_selling_price_cents bigint, p_cost_to_complete_cents bigint, p_cost_to_sell_cents bigint,
  p_evidence_url text, p_assumptions text, p_actor_id uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_settings public.project_financial_settings%rowtype; v_carrying bigint; v_nrv bigint; v_id uuid;
begin
  if p_actor_id is null or not exists(select 1 from public.app_users where id = p_actor_id) then raise exception 'A preparer is required'; end if;
  select * into v_settings from public.project_financial_settings where org_id = p_org_id and project_id = p_project_id and books_inventory_enabled;
  if not found or p_as_of < v_settings.books_inventory_effective_on then raise exception 'Impairment applies to a home the builder owns, from its inventory date'; end if;
  if v_settings.books_inventory_sold_on is not null and p_as_of >= v_settings.books_inventory_sold_on then raise exception 'The home is sold; its cost is already in cost of sales'; end if;
  if exists(select 1 from public.accounting_periods where org_id = p_org_id and status = 'closed' and p_as_of between period_start and period_end) then raise exception 'The review date is in a closed month'; end if;
  if least(p_selling_price_cents, p_cost_to_complete_cents, p_cost_to_sell_cents) < 0 then raise exception 'Amounts cannot be negative'; end if;
  v_carrying := public.books_home_carrying_cents(p_org_id, p_project_id, p_as_of);
  if v_carrying <= 0 then raise exception 'The home carries no cost to review'; end if;
  v_nrv := p_selling_price_cents - p_cost_to_complete_cents - p_cost_to_sell_cents;
  if v_carrying <= v_nrv then raise exception 'No write-down: the home''s net realizable value covers its cost'; end if;
  insert into public.books_inventory_impairments(org_id, project_id, as_of, carrying_cents, selling_price_cents, cost_to_complete_cents, cost_to_sell_cents, net_realizable_cents, write_down_cents, evidence_url, assumptions, prepared_by)
  values (p_org_id, p_project_id, p_as_of, v_carrying, p_selling_price_cents, p_cost_to_complete_cents, p_cost_to_sell_cents, v_nrv, v_carrying - v_nrv, p_evidence_url, trim(p_assumptions), p_actor_id)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.propose_books_inventory_impairment(uuid,uuid,date,bigint,bigint,bigint,text,text,uuid) from public, anon, authenticated;
grant execute on function public.propose_books_inventory_impairment(uuid,uuid,date,bigint,bigint,bigint,text,text,uuid) to service_role;

create or replace function public.review_books_inventory_impairment(p_org_id uuid, p_impairment_id uuid, p_approve boolean, p_note text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.books_inventory_impairments%rowtype; v_settings public.project_financial_settings%rowtype; v_policy integer; v_expense uuid; v_inventory uuid; v_entry uuid; v_dims jsonb;
begin
  select * into v from public.books_inventory_impairments where id = p_impairment_id and org_id = p_org_id for update;
  if not found then raise exception 'Impairment review not found'; end if;
  if v.status <> 'proposed' then raise exception 'This impairment has already been reviewed'; end if;
  if p_actor_id is null or p_actor_id = v.prepared_by then raise exception 'An impairment is approved by someone other than the person who prepared it'; end if;
  if not p_approve then
    if length(trim(coalesce(p_note, ''))) < 10 then raise exception 'Say why the impairment is rejected'; end if;
    update public.books_inventory_impairments set status = 'rejected', reviewed_by = p_actor_id, reviewed_at = clock_timestamp(), review_note = trim(p_note) where id = v.id;
    return jsonb_build_object('impairmentId', v.id, 'projectId', v.project_id, 'status', 'rejected', 'journalEntryId', null);
  end if;
  select * into v_settings from public.project_financial_settings where org_id = p_org_id and project_id = v.project_id for update;
  if v_settings.books_inventory_sold_on is not null and v.as_of >= v_settings.books_inventory_sold_on then raise exception 'The home is sold; its cost is already in cost of sales'; end if;
  if public.books_home_carrying_cents(p_org_id, v.project_id, v.as_of) <> v.carrying_cents then
    raise exception 'The home''s cost changed since this review was prepared; prepare it again on the current cost';
  end if;
  select active_policy_version into v_policy from public.books_settings where org_id = p_org_id;
  if v_policy is null then raise exception 'Books posting is not enabled'; end if;
  insert into public.gl_accounts(org_id, code, name, account_type, subtype, normal_balance, cash_flow_category, is_system, active)
    values (p_org_id, '5070', 'Inventory impairment', 'cogs', 'job_costs', 'debit', 'operating', true, true) on conflict (org_id, code) do nothing;
  -- 5070 is a cost-of-sales account identified by its code (chart policy v1 is
  -- immutable; a dedicated subtype waits for the next chart policy version).
  select id into v_expense from public.gl_accounts where org_id = p_org_id and code = '5070' and account_type = 'cogs' and name = 'Inventory impairment' and active;
  if v_expense is null then raise exception 'Account 5070 conflicts with the organization chart'; end if;
  select id into v_inventory from public.gl_accounts where org_id = p_org_id and active and code = case when v_settings.books_inventory_completed_on is not null and v.as_of >= v_settings.books_inventory_completed_on then '1170' else '1160' end;
  if v_inventory is null then raise exception 'Inventory accounts are missing'; end if;
  v_dims := jsonb_build_object('inventory_impairment_id', v.id, 'net_realizable_cents', v.net_realizable_cents, 'evidence_url', v.evidence_url);
  v_entry := public.post_books_journal_entry(p_org_id, jsonb_build_object('entry_date', v.as_of, 'entry_kind', 'adjusting', 'memo', 'Inventory written down to net realizable value',
    'posting_key', 'inventory_impairment:' || v.id, 'projection_version', 1, 'policy_version', v_policy, 'source_type', 'inventory_impairment', 'source_id', v.project_id, 'created_by', p_actor_id),
    jsonb_build_array(
      jsonb_build_object('line_no', 1, 'account_id', v_expense, 'project_id', v.project_id, 'debit_cents', v.write_down_cents, 'credit_cents', 0, 'dimensions', v_dims),
      jsonb_build_object('line_no', 2, 'account_id', v_inventory, 'project_id', v.project_id, 'debit_cents', 0, 'credit_cents', v.write_down_cents, 'dimensions', v_dims)));
  update public.books_inventory_impairments set status = 'approved', reviewed_by = p_actor_id, reviewed_at = clock_timestamp(), review_note = nullif(trim(coalesce(p_note, '')), ''), journal_entry_id = v_entry
    where id = v.id;
  return jsonb_build_object('impairmentId', v.id, 'projectId', v.project_id, 'status', 'approved', 'journalEntryId', v_entry);
end;
$$;
revoke all on function public.review_books_inventory_impairment(uuid,uuid,boolean,text,uuid) from public, anon, authenticated;
grant execute on function public.review_books_inventory_impairment(uuid,uuid,boolean,text,uuid) to service_role;

-- The loss and impairment schedule ties to the ledger: write-downs posted to
-- 5070 (before any year-end close moves them to retained earnings) equal the
-- approved reviews dated by then.
create or replace function public.books_impairment_control(p_org_id uuid, p_as_of date)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'ledgerCents', (select coalesce(sum(l.debit_cents - l.credit_cents), 0)::bigint from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id and e.org_id = l.org_id join public.gl_accounts a on a.id = l.account_id and a.org_id = l.org_id
      where l.org_id = p_org_id and a.code = '5070' and e.status in ('posted','reversed') and e.entry_date <= p_as_of
        and e.source_type is distinct from 'year_end_close'
        and not exists(select 1 from public.journal_entries o where o.id = e.reversal_of_entry_id and o.source_type = 'year_end_close')),
    'subledgerCents', (select coalesce(sum(write_down_cents), 0)::bigint from public.books_inventory_impairments where org_id = p_org_id and status = 'approved' and as_of <= p_as_of));
$$;
revoke all on function public.books_impairment_control(uuid,date) from public, anon, authenticated;
grant execute on function public.books_impairment_control(uuid,date) to service_role;

-- ==== 20261007235500_books_retire_native_entity_ledger ====
-- B14: the separate per-entity ledger (books_native_*, per-entity charts,
-- calendars, project-owner reviews) was never applied in production and was
-- retired on 2026-10-07: a legal entity is a segment of the one Books ledger
-- (docs/books-entities.md). Its migrations were removed before deploy; what
-- remains here settles the export layer the surviving migrations built on it.
--
-- Kept from that work: payroll labor ownership, the journal request
-- resolutions, ledger relationship keys, and export behavior that was not the
-- layer: row ids exported as text and invoice quantities as exact decimal text.

drop function if exists public.capture_books_export_snapshot_before_journal_resolutions(uuid) cascade;
drop function if exists public.capture_books_export_snapshot_before_exact_invoice_quantity(uuid) cascade;
drop function if exists public.capture_books_legacy_ownership_before_exact_invoice_quantity(uuid,uuid) cascade;
drop function if exists public.capture_books_legacy_ownership_evidence(uuid,uuid) cascade;

-- Exports are written and read only by the service.
revoke all on public.books_exports from public, anon, authenticated;
grant select, insert, update, delete on public.books_exports to service_role;

-- One complete export capture in one database snapshot.
create or replace function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public
as $$
declare
  v_table text;
  v_rows jsonb;
  v_tables jsonb := '{}'::jsonb;
begin
  if p_org_id is null then raise exception 'Export organization is required'; end if;
  foreach v_table in array array[
    'closings',
    'closing_checklist_items',
    'lot_takedowns',
    'lot_reservations',
    'budgets',
    'budget_lines',
    'commitments',
    'commitment_lines',
    'change_orders',
    'file_links',
    'project_financial_settings',
    'divisions',
    'communities',
    'community_phases',
    'lots',
    'contracts',
    'cost_codes',
    'time_entries',
    'warranty_requests',
    'warranty_service_visits',
    'warranty_backcharges',
    'org_funding_sources',
    'disbursements',
    'payment_runs',
    'payment_run_items',
    'payment_run_fee_charges',
    'receivable_adjustments',
    'books_deposit_batches',
    'books_deposit_batch_items',
    'receivable_payment_groups',
    'receivable_payment_group_items',
    'books_tax_adjustment_workpapers',
    'books_payroll_imports',
    'books_payroll_payment_reviews',
    'books_payroll_posting_proposals',
    'books_payroll_postings',
    'books_payroll_labor_ownership',
    'books_payroll_correction_sources',
    'books_payroll_correction_proposals',
    'books_payroll_correction_postings',
    'books_overhead_budgets',
    'books_overhead_budget_lines',
    'books_settings',
    'accounting_policies',
    'accounting_account_mappings',
    'gl_accounts',
    'books_projection_receipts',
    'accounting_facts',
    'journal_entries',
    'journal_lines',
    'accounting_periods',
    'accounting_reconciliation_runs',
    'accounting_reconciliation_items',
    'poc_snapshots',
    'books_comparison_runs',
    'books_comparison_items',
    'opening_balance_batches',
    'opening_balance_lines',
    'opening_balance_approvals',
    'bank_accounts',
    'bank_transactions',
    'bank_transaction_details',
    'bank_receipts',
    'bank_transaction_revisions',
    'bank_transaction_matches',
    'bank_reconciliations',
    'bank_reconciliation_items',
    'bank_rules',
    'coding_rules',
    'books_debt_instruments',
    'books_debt_events',
    'books_fixed_assets',
    'books_fixed_asset_events',
    'books_tax_jurisdictions',
    'books_tax_filings',
    'books_greenfield_launches',
    'books_journal_proposals',
    'books_cutover_runs',
    'books_cutover_approvals',
    'books_close_items',
    'recurring_posting_templates',
    'recurring_posting_lines',
    'financial_statement_snapshots',
    'tax_policy_versions',
    'companies',
    'contacts',
    'projects',
    'invoices',
    'invoice_lines',
    'payments',
    'payment_allocations',
    'payment_reversals',
    'vendor_bills',
    'bill_lines',
    'project_expenses',
    'project_expense_lines',
    'job_cost_entries',
    'billable_costs',
    'retainage',
    'doc_versions',
    'files',
    'books_journal_request_resolutions',
    'audit_log'
  ] loop
    execute format('select coalesce(jsonb_agg((to_jsonb(t) || jsonb_build_object(''id'', t.id::text)) order by t.id), ''[]''::jsonb) from public.%I t where t.org_id = $1', v_table)
      into v_rows using p_org_id;
    v_tables := v_tables || jsonb_build_object(v_table, v_rows);
  end loop;
  -- Exact decimal quantities, so restore never round-trips them through a float.
  select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('id', r.id::text, 'quantity', to_jsonb(r)->>'quantity') order by r.id), '[]'::jsonb)
    into v_rows from public.invoice_lines r where r.org_id = p_org_id;
  v_tables := jsonb_set(v_tables, '{invoice_lines}', v_rows);
  return jsonb_build_object('orgId', p_org_id, 'capturedAt', statement_timestamp(),
    'databaseSnapshot', pg_current_snapshot()::text, 'tables', v_tables);
end;
$$;
revoke all on function public.capture_books_export_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;
