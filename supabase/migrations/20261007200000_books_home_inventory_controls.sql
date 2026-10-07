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
