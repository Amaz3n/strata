-- Every economic input of a projected source now invalidates that source.
--
-- The 10-minute projection run re-reads a source only when the source row's
-- updated_at moves, and posting status reads 'posted' while the receipt is at
-- least as new as the source. Inputs that live outside the source row — job
-- cost lines, revenue-basis and inventory settings, contracts, funding-source
-- mappings, chart accounts, the original payment behind a reversal, the invoice
-- behind a credit memo — changed money only at the nightly full run while the
-- source kept reading 'posted'. Each input now touches the sources it feeds, so
-- they read 'pending' immediately and repost on the next run. A reopened period
-- touches the sources its close had blocked, so they retry at once.
--
-- Project dimensions (division, community, lot) are reporting attributes whose
-- restatement policy belongs to B07 and are deliberately not touched here.
-- The functions are security definer: the person changing an input (a contract,
-- a mapping) may not be allowed to update the documents it feeds.

create or replace function public.books_touch_project_sources(p_org_id uuid, p_project_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if p_project_id is null then return; end if;
  update public.invoices set updated_at = clock_timestamp() where org_id = p_org_id and project_id = p_project_id;
  update public.vendor_bills set updated_at = clock_timestamp() where org_id = p_org_id and project_id = p_project_id;
  update public.project_expenses set updated_at = clock_timestamp() where org_id = p_org_id and project_id = p_project_id;
  update public.receivable_adjustments set updated_at = clock_timestamp() where org_id = p_org_id and project_id = p_project_id;
end;
$$;
revoke all on function public.books_touch_project_sources(uuid, uuid) from public, anon, authenticated;

-- Job cost lines are written after their bill or expense; the parent must see them.
create or replace function public.books_touch_source_from_job_cost()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare row_data public.job_cost_entries;
begin
  for row_data in select * from (select (case when tg_op = 'DELETE' then old else new end).*) r
    union all select * from (select old.*) o where tg_op = 'UPDATE' and old.source_id is distinct from new.source_id loop
    if row_data.source_type = 'vendor_bill_line' then
      update public.vendor_bills set updated_at = clock_timestamp()
      where org_id = row_data.org_id and id = (select bill_id from public.bill_lines where id::text = row_data.source_id);
    elsif row_data.source_type = 'project_expense_line' then
      update public.project_expenses set updated_at = clock_timestamp()
      where org_id = row_data.org_id and id = (select expense_id from public.project_expense_lines where id::text = row_data.source_id);
    elsif row_data.source_type = 'project_expense' then
      update public.project_expenses set updated_at = clock_timestamp() where org_id = row_data.org_id and id::text = row_data.source_id;
    end if;
  end loop;
  return null;
end;
$$;
revoke all on function public.books_touch_source_from_job_cost() from public, anon, authenticated;
create trigger books_touch_source_from_job_cost after insert or update or delete on public.job_cost_entries
for each row execute function public.books_touch_source_from_job_cost();

-- Revenue basis and owned-inventory policy decide how a project's documents post.
create or replace function public.books_touch_project_sources_from_settings()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.books_touch_project_sources(new.org_id, new.project_id);
  return null;
end;
$$;
revoke all on function public.books_touch_project_sources_from_settings() from public, anon, authenticated;
create trigger books_touch_project_sources after update on public.project_financial_settings
for each row when (
  old.billing_model is distinct from new.billing_model
  or old.fixed_price_billing_basis is distinct from new.fixed_price_billing_basis
  or old.books_inventory_enabled is distinct from new.books_inventory_enabled
  or old.books_inventory_effective_on is distinct from new.books_inventory_effective_on
  or old.books_inventory_completed_on is distinct from new.books_inventory_completed_on
  or old.books_inventory_sold_on is distinct from new.books_inventory_sold_on
) execute function public.books_touch_project_sources_from_settings();

create or replace function public.books_touch_project_sources_from_contract()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then perform public.books_touch_project_sources(old.org_id, old.project_id); end if;
  if tg_op in ('INSERT', 'UPDATE') and (tg_op = 'INSERT' or old.project_id is distinct from new.project_id) then
    perform public.books_touch_project_sources(new.org_id, new.project_id);
  end if;
  return null;
end;
$$;
revoke all on function public.books_touch_project_sources_from_contract() from public, anon, authenticated;
create trigger books_touch_project_sources_insert_delete after insert or delete on public.contracts
for each row execute function public.books_touch_project_sources_from_contract();
create trigger books_touch_project_sources_update after update on public.contracts
for each row when (
  old.project_id is distinct from new.project_id or old.status is distinct from new.status
  or old.contract_type is distinct from new.contract_type or old.effective_date is distinct from new.effective_date
  or old.parent_contract_id is distinct from new.parent_contract_id or old.fixed_fee_cents is distinct from new.fixed_fee_cents
  or old.gmp_cents is distinct from new.gmp_cents or old.open_book is distinct from new.open_book
  or old.requires_client_cost_approval is distinct from new.requires_client_cost_approval
  or old.snapshot is distinct from new.snapshot
) execute function public.books_touch_project_sources_from_contract();

create or replace function public.books_touch_project_sources_from_project()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.books_touch_project_sources(new.org_id, new.id);
  return null;
end;
$$;
revoke all on function public.books_touch_project_sources_from_project() from public, anon, authenticated;
create trigger books_touch_project_sources after update of property_type, status on public.projects
for each row when (old.property_type is distinct from new.property_type or old.status is distinct from new.status)
execute function public.books_touch_project_sources_from_project();

-- A funding source's ledger account decides which cash or card account pays.
create or replace function public.books_touch_sources_from_funding()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  update public.payments p set updated_at = clock_timestamp()
  where p.org_id = new.org_id and (
    p.metadata->>'funding_source_id' = new.id::text
    or p.metadata->>'disbursement_id' in (select d.id::text from public.disbursements d where d.org_id = new.org_id and d.funding_source_id = new.id)
    or p.metadata->>'payment_run_id' in (select r.id::text from public.payment_runs r where r.org_id = new.org_id and r.funding_source_id = new.id));
  update public.payment_run_fee_charges set updated_at = clock_timestamp() where org_id = new.org_id and funding_source_id = new.id;
  update public.project_expenses set updated_at = clock_timestamp() where org_id = new.org_id and metadata->>'funding_source_id' = new.id::text;
  return null;
end;
$$;
revoke all on function public.books_touch_sources_from_funding() from public, anon, authenticated;
create trigger books_touch_sources_from_funding after update of books_gl_account_id on public.org_funding_sources
for each row when (old.books_gl_account_id is distinct from new.books_gl_account_id)
execute function public.books_touch_sources_from_funding();

-- A chart account named on a document line or payment decides where it posts.
create or replace function public.books_touch_sources_from_gl_account()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare account text := new.id::text;
begin
  update public.vendor_bills b set updated_at = clock_timestamp() where b.org_id = new.org_id
    and exists (select 1 from public.bill_lines l where l.bill_id = b.id and l.metadata->>'arc_books_gl_account_id' = account);
  update public.project_expenses e set updated_at = clock_timestamp() where e.org_id = new.org_id
    and (e.metadata->>'books_payment_account_id' = account
      or exists (select 1 from public.project_expense_lines l where l.expense_id = e.id and l.metadata->>'arc_books_gl_account_id' = account));
  update public.invoices i set updated_at = clock_timestamp() where i.org_id = new.org_id
    and exists (select 1 from public.invoice_lines l where l.invoice_id = i.id and l.metadata->>'arc_books_gl_account_id' = account);
  update public.payments set updated_at = clock_timestamp() where org_id = new.org_id and metadata->>'books_payment_account_id' = account;
  return null;
end;
$$;
revoke all on function public.books_touch_sources_from_gl_account() from public, anon, authenticated;
create trigger books_touch_sources_from_gl_account after update on public.gl_accounts
for each row when (old.code is distinct from new.code or old.account_type is distinct from new.account_type
  or old.subtype is distinct from new.subtype or old.active is distinct from new.active)
execute function public.books_touch_sources_from_gl_account();

-- A reversal posts against its original payment's account.
create or replace function public.books_touch_reversals_from_payment()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  update public.payment_reversals set updated_at = clock_timestamp() where org_id = new.org_id and payment_id = new.id;
  return null;
end;
$$;
revoke all on function public.books_touch_reversals_from_payment() from public, anon, authenticated;
create trigger books_touch_reversals_from_payment after update of method, metadata on public.payments
for each row when (old.method is distinct from new.method or old.metadata is distinct from new.metadata)
execute function public.books_touch_reversals_from_payment();

-- A credit memo allocates over its invoice's lines; an invoice's kind decides
-- whether its receipts are deposits.
create or replace function public.books_touch_dependents_from_invoice()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  update public.receivable_adjustments set updated_at = clock_timestamp() where org_id = new.org_id and invoice_id = new.id;
  if old.metadata->>'invoice_kind' is distinct from new.metadata->>'invoice_kind' then
    update public.payments set updated_at = clock_timestamp() where org_id = new.org_id and invoice_id = new.id;
  end if;
  return null;
end;
$$;
revoke all on function public.books_touch_dependents_from_invoice() from public, anon, authenticated;
create trigger books_touch_dependents_from_invoice after update on public.invoices
for each row execute function public.books_touch_dependents_from_invoice();

-- Reopening a period retries the sources its close had blocked.
create or replace function public.books_touch_blocked_sources(p_org_id uuid)
returns integer language plpgsql security definer set search_path = pg_catalog, public as $$
declare item record; touched integer := 0;
begin
  for item in select entity_type, entity_id from public.accounting_reconciliation_items
    where org_id = p_org_id and status <> 'resolved' and category in ('projection_blocked_by_closed_period', 'projection_failed') loop
    if item.entity_type in ('invoice', 'retainage_release') then
      update public.invoices set updated_at = clock_timestamp() where org_id = p_org_id and id::text = item.entity_id::text;
    end if;
    if item.entity_type in ('vendor_bill', 'retainage_release') then
      update public.vendor_bills set updated_at = clock_timestamp() where org_id = p_org_id and id::text = item.entity_id::text;
    elsif item.entity_type = 'expense' then
      update public.project_expenses set updated_at = clock_timestamp() where org_id = p_org_id and id::text = item.entity_id::text;
    elsif item.entity_type in ('payment', 'bill_payment', 'invoice_payment', 'customer_deposit_receipt', 'customer_deposit_application') then
      update public.payments set updated_at = clock_timestamp() where org_id = p_org_id and id::text = item.entity_id::text;
    elsif item.entity_type in ('payment_reversal', 'customer_deposit_reversal') then
      update public.payment_reversals set updated_at = clock_timestamp() where org_id = p_org_id and id::text = item.entity_id::text;
    elsif item.entity_type = 'receivable_adjustment' then
      update public.receivable_adjustments set updated_at = clock_timestamp() where org_id = p_org_id and id::text = item.entity_id::text;
    end if;
    touched := touched + 1;
  end loop;
  return touched;
end;
$$;
revoke all on function public.books_touch_blocked_sources(uuid) from public, anon, authenticated;
grant execute on function public.books_touch_blocked_sources(uuid) to service_role;
