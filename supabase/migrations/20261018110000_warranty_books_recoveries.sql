-- EP11-07: warranty money in the books reconciles to accepted work, and a reversal or a repeated
-- settlement cannot duplicate it.
--
-- * books_warranty_recovery_credited: the vendor-credit cost relief a request's backcharges have
--   posted (net of reversing bills) and the date the last of it took effect. One definition, read by
--   the recovery posting and by the month-end control.
-- * reconcile_books_warranty_recovery restores the reserve for credits up to what the reserve paid
--   for the request (never more), by the difference from what is already restored, so any number of
--   runs post nothing twice. Its entry carries `effective_on`, the date the change took effect.
-- * reverse_books_warranty_cost now re-reconciles the request in the same transaction: reversing an
--   approved cost takes back the recovery restored against it instead of leaving it to the next sweep.
-- * books_home_inventory_controls: warrantyReserve also ties recoveries (ledger restored against the
--   recoveries the posted vendor credits support).

create or replace function public.books_warranty_recovery_credited(p_org_id uuid, p_request_id uuid, p_as_of date)
returns table(credited_cents bigint, credited_on date)
language sql stable security definer set search_path='' as $$
  select greatest(-coalesce(sum(l.debit_cents-l.credit_cents),0),0)::bigint, max(e.entry_date)
  from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id and a.org_id=l.org_id
  where l.org_id=p_org_id and e.status in('posted','reversed') and e.entry_date<=p_as_of and a.account_type='cogs' and coalesce(e.source_id,(select original.source_id from public.journal_entries original where original.id=e.reversal_of_entry_id and original.org_id=e.org_id)) in (
    select vendor_credit_bill_id from public.warranty_backcharges where org_id=p_org_id and warranty_request_id=p_request_id and vendor_credit_bill_id is not null
    union all select (metadata->>'reversal_bill_id')::uuid from public.warranty_backcharges where org_id=p_org_id and warranty_request_id=p_request_id and metadata->>'reversal_bill_id' is not null
  );
$$;
revoke all on function public.books_warranty_recovery_credited(uuid,uuid,date) from public,anon,authenticated;
grant execute on function public.books_warranty_recovery_credited(uuid,uuid,date) to service_role;

create or replace function public.reconcile_books_warranty_recovery(p_org_id uuid,p_request_id uuid,p_date date)
returns uuid language plpgsql security definer set search_path='' as $$
declare project uuid; reserve uuid; expense uuid; covered bigint; covered_on date; credited bigint; credited_on date; restored bigint; delta bigint; revision integer; policy integer; result_id uuid; dimensions jsonb; effective date;
begin
 select project_id into project from public.warranty_requests where org_id=p_org_id and id=p_request_id for update;
 if not found then raise exception 'Warranty request not found'; end if;
 perform 1 from public.project_financial_settings where org_id=p_org_id and project_id=project for update;
 select id into reserve from public.gl_accounts where org_id=p_org_id and code='2260' and active;
 select id into expense from public.gl_accounts where org_id=p_org_id and code='5050' and active;
 select coalesce(sum(books_reserve_consumed_cents),0), max(books_cost_date) into covered, covered_on from public.warranty_service_visits where org_id=p_org_id and request_id=p_request_id and books_cost_approved_at is not null and books_cost_date<=p_date;
 select c.credited_cents, c.credited_on into credited, credited_on from public.books_warranty_recovery_credited(p_org_id,p_request_id,p_date) c;
 select coalesce(sum(l.credit_cents-l.debit_cents),0) into restored from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id where l.org_id=p_org_id and l.account_id=reserve and l.dimensions->>'warranty_recovery_request_id'=p_request_id::text and e.status in('posted','reversed') and e.entry_date<=p_date;
 delta:=least(covered,credited)-restored;
 if delta=0 then return null; end if;
 if reserve is null or expense is null then raise exception 'Warranty recovery accounts are missing'; end if;
 -- A recovery takes effect when the later of its cost approval and its credit did; taking one back, today.
 effective:=case when delta>0 then least(p_date,greatest(coalesce(covered_on,p_date),coalesce(credited_on,p_date))) else p_date end;
 select active_policy_version into policy from public.books_settings where org_id=p_org_id;
 select count(*)+1 into revision from public.journal_entries where org_id=p_org_id and source_type='warranty_reserve_recovery' and source_id=p_request_id;
 dimensions:=jsonb_build_object('warranty_reserve_adjustment',true,'warranty_recovery_request_id',p_request_id,'covered_cents',covered,'posted_recovery_cents',credited,'effective_on',effective);
 result_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p_date,'entry_kind','adjusting','memo','Reconcile reserve-backed warranty recovery','posting_key','warranty_recovery:'||p_request_id||':'||revision,'projection_version',1,'policy_version',policy,'source_type','warranty_reserve_recovery','source_id',p_request_id),
 jsonb_build_array(jsonb_build_object('line_no',1,'account_id',expense,'project_id',project,'debit_cents',greatest(delta,0),'credit_cents',greatest(-delta,0),'dimensions',dimensions),jsonb_build_object('line_no',2,'account_id',reserve,'project_id',project,'debit_cents',greatest(-delta,0),'credit_cents',greatest(delta,0),'dimensions',dimensions)));
 return result_id;
end;
$$;
revoke all on function public.reconcile_books_warranty_recovery(uuid,uuid,date) from public,anon,authenticated;
grant execute on function public.reconcile_books_warranty_recovery(uuid,uuid,date) to service_role;

create or replace function public.reverse_books_warranty_cost(p_org_id uuid,p_visit_id uuid,p_date date,p_reason text,p_actor_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare visit public.warranty_service_visits%rowtype; original public.journal_entries%rowtype; lines jsonb;
begin
 select * into visit from public.warranty_service_visits where org_id=p_org_id and id=p_visit_id for update;
 if not found then raise exception 'Visit not found'; end if;
 if visit.books_cost_approved_at is null then return; end if;
 if p_date<visit.books_cost_date or length(btrim(p_reason))<10 then raise exception 'A reversal date and explanation are required'; end if;
 if visit.books_cost_journal_entry_id is not null then
   select * into original from public.journal_entries where org_id=p_org_id and id=visit.books_cost_journal_entry_id;
   select jsonb_agg(jsonb_build_object('line_no',l.line_no,'account_id',l.account_id,'project_id',l.project_id,'company_id',l.company_id,'debit_cents',l.credit_cents,'credit_cents',l.debit_cents,'description',p_reason,'dimensions',l.dimensions) order by l.line_no) into lines from public.journal_lines l where l.org_id=p_org_id and l.entry_id=original.id;
   perform public.reverse_books_journal_entry(p_org_id,original.id,jsonb_build_object('entry_date',p_date,'entry_kind','reversal','memo','Reverse warranty approval: '||p_reason,'posting_key','reverse_warranty_cost:'||original.id,'projection_version',original.projection_version,'policy_version',original.policy_version,'reversal_of_entry_id',original.id,'created_by',p_actor_id),lines);
 end if;
 update public.warranty_service_visits set metadata=metadata||jsonb_build_object('books_cost_review_history',coalesce(metadata->'books_cost_review_history','[]'::jsonb)||jsonb_build_array(jsonb_build_object('sources',books_cost_sources,'approved_at',books_cost_approved_at,'approved_by',books_cost_approved_by,'cost_cents',books_approved_cost_cents,'journal_entry_id',books_cost_journal_entry_id,'reversed_on',p_date,'reason',p_reason))),books_cost_sources='[]',books_approved_cost_cents=0,books_reserve_consumed_cents=0,books_cost_approved_by=null,books_cost_approved_at=null,books_cost_date=null,books_cost_evidence_url=null,books_cost_journal_entry_id=null,updated_at=now() where org_id=p_org_id and id=p_visit_id;
 -- A recovery restored against this cost goes back with it, in this transaction.
 if visit.request_id is not null then perform public.reconcile_books_warranty_recovery(p_org_id,visit.request_id,p_date); end if;
end;
$$;
revoke all on function public.reverse_books_warranty_cost(uuid,uuid,date,text,uuid) from public,anon,authenticated;
grant execute on function public.reverse_books_warranty_cost(uuid,uuid,date,text,uuid) to service_role;

create or replace function public.books_home_inventory_controls(p_org_id uuid, p_as_of date)
returns jsonb language sql stable security definer set search_path = public as $$
  with lines as (
    select a.code, l.project_id, l.legal_entity_id, l.dimensions, e.source_type, e.source_id, e.reversal_of_entry_id, (l.debit_cents - l.credit_cents)::bigint as net
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
    join public.gl_accounts a on a.id = l.account_id and a.org_id = l.org_id
    where l.org_id = p_org_id and e.status in ('posted','reversed') and e.entry_date <= p_as_of and a.code in ('1120','1170','2260')
  ), land_ledger as (
    select dimensions->>'lot_id' as lot_id, sum(net)::bigint as cents from lines where code = '1120' group by 1
  ), land_ledger_by_company as (
    select dimensions->>'lot_id' as lot_id, legal_entity_id, sum(net)::bigint as cents from lines where code = '1120' group by 1, 2
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
  ), completed_ledger_by_company as (
    select project_id, legal_entity_id, sum(net)::bigint as cents from lines where code = '1170' group by 1, 2
  ), completed_rows as (
    select coalesce(h.project_id, c.project_id) as project_id, h.completed_on, coalesce(c.cents, 0) as cents, h.project_id is not null as held
    from held h full join completed_ledger c on c.project_id = h.project_id
  ), consumed_ledger as (
    select coalesce(sum(net), 0)::bigint as cents from lines where code = '2260'
      and (source_type = 'warranty_reserve_consumption' or exists(select 1 from public.journal_entries o where o.id = reversal_of_entry_id and o.source_type = 'warranty_reserve_consumption'))
  ), recovered_ledger as (
    -- A recovery entry is posted when the sweep runs but takes effect on the date its vendor credit or
    -- cost approval did (`effective_on`), so a month-end tie-out run later still reads it in its month.
    select coalesce(-sum(l.debit_cents - l.credit_cents), 0)::bigint as cents
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
    join public.gl_accounts a on a.id = l.account_id and a.org_id = l.org_id
    where l.org_id = p_org_id and e.status in ('posted','reversed') and a.code = '2260' and e.source_type = 'warranty_reserve_recovery'
      and coalesce((l.dimensions->>'effective_on')::date, e.entry_date) <= p_as_of
  ), recovered_subledger as (
    select coalesce(sum(least(c.covered, cr.credited_cents)), 0)::bigint as cents
    from (select v.request_id, sum(v.books_reserve_consumed_cents)::bigint as covered from public.warranty_service_visits v
      where v.org_id = p_org_id and v.books_cost_approved_at is not null and v.books_cost_date <= p_as_of group by v.request_id) c
    cross join lateral public.books_warranty_recovery_credited(p_org_id, c.request_id, p_as_of) cr
    where exists(select 1 from public.warranty_backcharges b where b.org_id = p_org_id and b.warranty_request_id = c.request_id and b.vendor_credit_bill_id is not null)
  )
  select jsonb_build_object(
    'land', jsonb_build_object(
      'ledgerCents', (select coalesce(sum(ledger_cents), 0) from land_rows),
      'subledgerCents', (select coalesce(sum(subledger_cents), 0) from land_rows),
      'exceptions', coalesce((select jsonb_agg(jsonb_build_object('lotId', lot_id, 'lotNumber', lot_number, 'ledgerCents', ledger_cents, 'basisCents', subledger_cents) order by lot_number) from land_rows where ledger_cents <> subledger_cents), '[]'::jsonb),
      'holdings', coalesce((select jsonb_agg(jsonb_build_object('lotId', r.lot_id, 'lotNumber', r.lot_number, 'basisCents', r.subledger_cents,
          'ledger', coalesce((select jsonb_agg(jsonb_build_object('legalEntityId', b.legal_entity_id, 'cents', b.cents) order by b.legal_entity_id)
            from land_ledger_by_company b where b.lot_id is not distinct from r.lot_id and b.cents <> 0), '[]'::jsonb)) order by r.lot_number, r.lot_id)
        from land_rows r), '[]'::jsonb)),
    'completedHomes', jsonb_build_object(
      'ledgerCents', (select coalesce(sum(cents), 0) from completed_rows),
      'heldCents', (select coalesce(sum(cents), 0) from completed_rows where held),
      'homes', coalesce((select jsonb_agg(jsonb_build_object('projectId', project_id, 'completedOn', completed_on, 'ageDays', p_as_of - completed_on, 'cents', cents) order by completed_on, project_id) from completed_rows where held), '[]'::jsonb),
      'exceptions', coalesce((select jsonb_agg(jsonb_build_object('projectId', project_id, 'cents', cents)) from completed_rows where not held and cents <> 0), '[]'::jsonb),
      'holdings', coalesce((select jsonb_agg(jsonb_build_object('projectId', r.project_id, 'held', r.held,
          'ledger', coalesce((select jsonb_agg(jsonb_build_object('legalEntityId', b.legal_entity_id, 'cents', b.cents) order by b.legal_entity_id)
            from completed_ledger_by_company b where b.project_id is not distinct from r.project_id and b.cents <> 0), '[]'::jsonb)) order by r.project_id)
        from completed_rows r), '[]'::jsonb)),
    'warrantyReserve', jsonb_build_object(
      'ledgerCents', (select cents from consumed_ledger),
      'subledgerCents', (select coalesce(sum(v.books_reserve_consumed_cents), 0)::bigint from public.warranty_service_visits v
        where v.org_id = p_org_id and v.books_cost_approved_at is not null and v.books_cost_date <= p_as_of),
      'recoveryLedgerCents', (select cents from recovered_ledger),
      'recoverySubledgerCents', (select cents from recovered_subledger))
  );
$$;
revoke all on function public.books_home_inventory_controls(uuid, date) from public, anon, authenticated;
grant execute on function public.books_home_inventory_controls(uuid, date) to service_role;
