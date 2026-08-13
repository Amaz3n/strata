-- Arc Books release hardening.
--
-- This migration is intentionally limited to invariants at the database seam:
-- 1. a posted journal can have exactly one reversal and the original receives a
--    queryable `reversed` state in the same transaction;
-- 2. posted entries cannot acquire new lines after posting;
-- 3. beginning a period close serializes against every journal insert into that
--    period; and
-- 4. child-line accounting edits advance their parent's projection watermark.
--
-- Functions are service-role only. Human RBAC remains in the calling services.

begin;

create unique index if not exists journal_entries_one_reversal_idx
  on public.journal_entries (org_id, reversal_of_entry_id)
  where reversal_of_entry_id is not null and status = 'posted';

create index if not exists accounting_facts_source_watermark_idx
  on public.accounting_facts (org_id, source_type, occurred_at desc);

-- The ordinary immutability guard permits one structural transition only: a
-- posted original may become `reversed` after its posted reversal exists.
create or replace function public.books_guard_posted_journal()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  parent_status text;
begin
  if tg_table_name = 'journal_entries' then
    if tg_op = 'UPDATE'
      and old.status = 'posted'
      and new.status = 'reversed'
      and (to_jsonb(new) - 'status') = (to_jsonb(old) - 'status')
      and exists (
        select 1
        from public.journal_entries reversal
        where reversal.org_id = old.org_id
          and reversal.reversal_of_entry_id = old.id
          and reversal.status = 'posted'
      ) then
      return new;
    end if;
    if old.status in ('posted', 'reversed') then
      raise exception 'Posted journal entries are immutable; create a reversal';
    end if;
  else
    select status into parent_status
    from public.journal_entries
    where id = coalesce(new.entry_id, old.entry_id);
    if parent_status in ('posted', 'reversed') then
      raise exception 'Posted journal lines are immutable; create a reversal';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists journal_lines_guard_posted on public.journal_lines;
create trigger journal_lines_guard_posted
  before insert or update or delete on public.journal_lines
  for each row execute function public.books_guard_posted_journal();

-- A period row is the serialization point shared by close and posting. The
-- key-share lock waits behind `begin_books_period_close`; conversely, close waits
-- for an in-flight posting transaction before it can mark the period reviewing.
create or replace function public.books_guard_period_posting()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  period_status text;
begin
  if new.period_id is null then
    return new;
  end if;

  select status into period_status
  from public.accounting_periods
  where id = new.period_id and org_id = new.org_id
  for key share;

  -- Revenue recognition is the one posting owned by the close transaction at the
  -- application layer. All ordinary operational/projector posts wait until close
  -- either completes or restores the prior status.
  if period_status = 'reviewing' and new.source_type is distinct from 'revenue_recognition' then
    raise exception 'Accounting period is reviewing and cannot accept operational postings';
  end if;
  if period_status = 'closed' then
    raise exception 'Accounting period is % and cannot accept postings', period_status;
  end if;
  return new;
end;
$$;

drop trigger if exists journal_entries_guard_period_posting on public.journal_entries;
create trigger journal_entries_guard_period_posting
  before insert on public.journal_entries
  for each row execute function public.books_guard_period_posting();

create or replace function public.begin_books_period_close(
  p_org_id uuid,
  p_period_id uuid
) returns text
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  prior_status text;
begin
  select status into prior_status
  from public.accounting_periods
  where id = p_period_id and org_id = p_org_id
  for update;

  if prior_status is null then
    raise exception 'Accounting period not found';
  end if;
  if prior_status = 'reviewing' then
    raise exception 'Accounting period close is already running';
  end if;
  if prior_status = 'closed' then
    raise exception 'Accounting period is already closed';
  end if;

  update public.accounting_periods
  set status = 'reviewing', updated_at = now()
  where id = p_period_id and org_id = p_org_id;

  return prior_status;
end;
$$;

create or replace function public.cancel_books_period_close(
  p_org_id uuid,
  p_period_id uuid,
  p_prior_status text
) returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if p_prior_status not in ('open', 'reopened') then
    raise exception 'Invalid prior accounting-period status';
  end if;

  update public.accounting_periods
  set status = p_prior_status, updated_at = now()
  where id = p_period_id
    and org_id = p_org_id
    and status = 'reviewing';
end;
$$;

-- One RPC owns the complete reversal transaction: lock the original, re-use an
-- existing reversal when a retry races, post the mirror, then mark the original.
create or replace function public.reverse_books_journal_entry(
  p_org_id uuid,
  p_original_entry_id uuid,
  p_entry jsonb,
  p_lines jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  original_status text;
  reversal_id uuid;
begin
  select status into original_status
  from public.journal_entries
  where id = p_original_entry_id and org_id = p_org_id
  for update;

  if original_status is null then
    raise exception 'Original journal entry not found';
  end if;

  select id into reversal_id
  from public.journal_entries
  where org_id = p_org_id
    and reversal_of_entry_id = p_original_entry_id
    and status = 'posted'
  limit 1;

  if reversal_id is not null then
    if original_status = 'posted' then
      update public.journal_entries set status = 'reversed'
      where id = p_original_entry_id and org_id = p_org_id;
    end if;
    return jsonb_build_object('id', reversal_id, 'created', false);
  end if;

  if original_status <> 'posted' then
    raise exception 'Only a posted journal entry can be reversed';
  end if;
  if p_entry ->> 'entry_kind' <> 'reversal'
    or nullif(p_entry ->> 'reversal_of_entry_id', '')::uuid is distinct from p_original_entry_id then
    raise exception 'Reversal payload does not identify the original entry';
  end if;

  reversal_id := public.post_books_journal_entry(p_org_id, p_entry, p_lines);

  update public.journal_entries
  set status = 'reversed'
  where id = p_original_entry_id and org_id = p_org_id;

  return jsonb_build_object('id', reversal_id, 'created', true);
end;
$$;

-- Keep a payment and its provider fee/timing fields in the same transaction.
-- The existing RPC remains the single invoice-balance implementation; this
-- wrapper only completes the payment row before returning it to the projector.
create or replace function public.apply_invoice_payment_with_details_atomic(
  p_org_id uuid,
  p_invoice_id uuid,
  p_amount_cents integer,
  p_currency text,
  p_method text,
  p_provider text,
  p_provider_payment_id text,
  p_status text,
  p_reference text,
  p_fee_cents integer,
  p_gross_cents integer,
  p_net_cents integer,
  p_idempotency_key text,
  p_metadata jsonb,
  p_received_at timestamptz,
  p_provider_charge_id text,
  p_connected_account_id text,
  p_processor_fee_cents integer,
  p_platform_fee_cents integer,
  p_application_fee_cents integer,
  p_provider_balance_transaction_id text,
  p_provider_transfer_id text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  payment_result jsonb;
  payment_id uuid;
  payment_row public.payments%rowtype;
begin
  payment_result := public.apply_invoice_payment_atomic(
    p_org_id,
    p_invoice_id,
    p_amount_cents,
    p_currency,
    p_method,
    p_provider,
    p_provider_payment_id,
    p_status,
    p_reference,
    p_fee_cents,
    p_gross_cents,
    p_net_cents,
    p_idempotency_key,
    p_metadata
  );
  payment_id := (payment_result ->> 'id')::uuid;

  update public.payments
  set received_at = coalesce(p_received_at, received_at),
      provider_charge_id = p_provider_charge_id,
      connected_account_id = p_connected_account_id,
      processor_fee_cents = coalesce(p_processor_fee_cents, 0),
      platform_fee_cents = coalesce(p_platform_fee_cents, 0),
      application_fee_cents = coalesce(p_application_fee_cents, 0),
      provider_balance_transaction_id = p_provider_balance_transaction_id,
      provider_transfer_id = p_provider_transfer_id
  where id = payment_id and org_id = p_org_id
  returning * into payment_row;

  if payment_row.id is null then
    raise exception 'Atomic payment details could not be persisted';
  end if;
  return to_jsonb(payment_row)
    || (payment_result - 'id');
end;
$$;

-- A source revision is one accounting event. Reversing the prior entry, saving
-- the next immutable fact and posting its replacement cannot be three commits:
-- a worker crash between them would expose a temporarily wrong official ledger.
create or replace function public.project_books_fact_and_journal_atomic(
  p_org_id uuid,
  p_expected_fact_id uuid,
  p_fact jsonb,
  p_entry jsonb,
  p_lines jsonb,
  p_reversal_date date,
  p_reversal_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  latest_fact public.accounting_facts%rowtype;
  projected_fact_id uuid;
  projected_journal_id uuid;
  prior_entry record;
  reversal_entry jsonb;
  reversal_lines jsonb;
  resolved_reversal_date date;
  created boolean := false;
  superseded boolean := false;
  journal_created boolean := false;
begin
  if jsonb_typeof(p_fact) <> 'object' or jsonb_typeof(p_entry) <> 'object'
    or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Projection requires fact, entry and line payloads';
  end if;

  -- One projector may revise a source at a time, even when both workers read the
  -- same prior version before entering this function.
  perform pg_advisory_xact_lock(hashtextextended(
    p_org_id::text || ':' || (p_fact ->> 'source_type') || ':' || (p_fact ->> 'source_id'),
    0
  ));

  select * into latest_fact
  from public.accounting_facts
  where org_id = p_org_id
    and source_type = p_fact ->> 'source_type'
    and source_id = (p_fact ->> 'source_id')::uuid
  order by source_version desc
  limit 1
  for update;

  if latest_fact.id is not null and latest_fact.payload_hash = p_fact ->> 'payload_hash' then
    projected_fact_id := latest_fact.id;
  else
    if latest_fact.id is distinct from p_expected_fact_id then
      raise exception 'Projection source changed concurrently; retry from the latest fact';
    end if;

    if latest_fact.id is not null then
      superseded := true;
      for prior_entry in
        select entry.*, period.status as period_status
        from public.journal_entries entry
        left join public.accounting_periods period on period.id = entry.period_id
        where entry.org_id = p_org_id
          and entry.fact_id = latest_fact.id
          and entry.status = 'posted'
        order by entry.created_at
      loop
        resolved_reversal_date := case
          when prior_entry.period_status = 'closed' then p_reversal_date
          else prior_entry.entry_date
        end;
        select jsonb_agg(jsonb_build_object(
          'line_no', line.line_no,
          'account_id', line.account_id,
          'project_id', line.project_id,
          'company_id', line.company_id,
          'description', line.description,
          'debit_cents', line.credit_cents,
          'credit_cents', line.debit_cents,
          'dimensions', line.dimensions
        ) order by line.line_no)
        into reversal_lines
        from public.journal_lines line
        where line.org_id = p_org_id and line.entry_id = prior_entry.id;

        reversal_entry := jsonb_build_object(
          'fact_id', null,
          'entry_date', resolved_reversal_date,
          'entry_kind', 'reversal',
          'memo', 'Reversal of ' || prior_entry.memo || ': ' || p_reversal_reason,
          'posting_key', 'reversal:' || prior_entry.id || ':' || md5(resolved_reversal_date::text || ':' || p_reversal_reason),
          'projection_version', prior_entry.projection_version,
          'policy_version', prior_entry.policy_version,
          'source_type', null,
          'source_id', null,
          'reversal_of_entry_id', prior_entry.id,
          'created_by', null
        );
        perform public.reverse_books_journal_entry(
          p_org_id,
          prior_entry.id,
          reversal_entry,
          coalesce(reversal_lines, '[]'::jsonb)
        );
      end loop;
    end if;

    insert into public.accounting_facts (
      org_id, source_type, source_id, source_version, fact_kind, occurred_at,
      accounting_date, payload, payload_hash, policy_version,
      supersedes_fact_id, idempotency_key, created_by
    ) values (
      p_org_id,
      p_fact ->> 'source_type',
      (p_fact ->> 'source_id')::uuid,
      (p_fact ->> 'source_version')::integer,
      p_fact ->> 'fact_kind',
      (p_fact ->> 'occurred_at')::timestamptz,
      (p_fact ->> 'accounting_date')::date,
      p_fact -> 'payload',
      p_fact ->> 'payload_hash',
      (p_fact ->> 'policy_version')::integer,
      latest_fact.id,
      p_fact ->> 'idempotency_key',
      nullif(p_fact ->> 'created_by', '')::uuid
    )
    returning id into projected_fact_id;
    created := true;
  end if;

  select entry.id into projected_journal_id
  from public.journal_entries entry
  where entry.org_id = p_org_id and entry.fact_id = projected_fact_id and entry.status = 'posted'
  order by created_at desc
  limit 1;
  if projected_journal_id is null then
    projected_journal_id := public.post_books_journal_entry(
      p_org_id,
      jsonb_set(p_entry, '{fact_id}', to_jsonb(projected_fact_id::text), true),
      p_lines
    );
    journal_created := true;
  end if;

  return jsonb_build_object(
    'fact_id', projected_fact_id,
    'journal_id', projected_journal_id,
    'created', created,
    'journal_created', journal_created,
    'superseded', superseded,
    'source_version', (select source_version from public.accounting_facts where id = projected_fact_id)
  );
end;
$$;

-- Child accounting edits must invalidate the parent's fact even when the parent
-- document itself was untouched. These triggers make parent `updated_at` the
-- reliable per-source cursor the projector expects.
create or replace function public.books_touch_vendor_bill_from_line()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if tg_op = 'DELETE' then
    update public.vendor_bills set updated_at = now() where id = old.bill_id;
    return old;
  end if;
  update public.vendor_bills set updated_at = now() where id = new.bill_id;
  if tg_op = 'UPDATE' and old.bill_id is distinct from new.bill_id then
    update public.vendor_bills set updated_at = now() where id = old.bill_id;
  end if;
  return new;
end;
$$;

create or replace function public.books_touch_expense_from_line()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if tg_op = 'DELETE' then
    update public.project_expenses set updated_at = now() where id = old.expense_id;
    return old;
  end if;
  update public.project_expenses set updated_at = now() where id = new.expense_id;
  if tg_op = 'UPDATE' and old.expense_id is distinct from new.expense_id then
    update public.project_expenses set updated_at = now() where id = old.expense_id;
  end if;
  return new;
end;
$$;

create or replace function public.books_touch_invoice_from_retainage()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if tg_op = 'DELETE' then
    update public.invoices set updated_at = now()
    where id in (old.invoice_id, old.release_invoice_id);
    return old;
  end if;
  update public.invoices set updated_at = now()
  where id in (new.invoice_id, new.release_invoice_id);
  if tg_op = 'UPDATE' then
    update public.invoices set updated_at = now()
    where id in (old.invoice_id, old.release_invoice_id)
      and id is distinct from new.invoice_id
      and id is distinct from new.release_invoice_id;
  end if;
  return new;
end;
$$;

drop trigger if exists bill_lines_touch_books_parent on public.bill_lines;
create trigger bill_lines_touch_books_parent
  after insert or update or delete on public.bill_lines
  for each row execute function public.books_touch_vendor_bill_from_line();

drop trigger if exists project_expense_lines_touch_books_parent on public.project_expense_lines;
create trigger project_expense_lines_touch_books_parent
  after insert or update or delete on public.project_expense_lines
  for each row execute function public.books_touch_expense_from_line();

drop trigger if exists retainage_touch_books_parent on public.retainage;
create trigger retainage_touch_books_parent
  after insert or update or delete on public.retainage
  for each row execute function public.books_touch_invoice_from_retainage();

-- Apply an earnest/customer deposit to a later receivable without inventing a
-- second cash receipt. The source deposit, its refunds, prior applications, and
-- the target invoice are validated under one advisory/row-lock transaction.
create or replace function public.apply_customer_deposit_atomic(
  p_org_id uuid,
  p_deposit_payment_id uuid,
  p_target_invoice_id uuid,
  p_amount_cents integer,
  p_actor_id uuid,
  p_received_at timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  deposit_payment public.payments%rowtype;
  deposit_invoice public.invoices%rowtype;
  target_invoice public.invoices%rowtype;
  refunded_cents bigint;
  applied_cents bigint;
  result jsonb;
begin
  if p_amount_cents <= 0 then raise exception 'Deposit application must be positive'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':deposit:' || p_deposit_payment_id::text, 0));
  select * into deposit_payment from public.payments
  where id = p_deposit_payment_id and org_id = p_org_id
  for update;
  if not found or deposit_payment.status not in ('succeeded', 'completed') or deposit_payment.invoice_id is null then
    raise exception 'The source payment is not an available customer deposit';
  end if;

  select * into deposit_invoice from public.invoices
  where id = deposit_payment.invoice_id and org_id = p_org_id;
  if not found or coalesce(deposit_invoice.metadata ->> 'invoice_kind', '') <> 'earnest_deposit' then
    raise exception 'The source payment is not tied to an earnest-deposit invoice';
  end if;
  if p_target_invoice_id = deposit_invoice.id then
    raise exception 'A deposit cannot be applied to its own collection request';
  end if;
  select * into target_invoice from public.invoices
  where id = p_target_invoice_id and org_id = p_org_id for update;
  if not found or target_invoice.status not in ('sent','partial','overdue') then
    raise exception 'The target invoice is not open for payment';
  end if;
  if nullif(deposit_invoice.metadata ->> 'customer_id', '') is not null
    and nullif(target_invoice.metadata ->> 'customer_id', '')
      is distinct from nullif(deposit_invoice.metadata ->> 'customer_id', '') then
    raise exception 'A customer deposit can only be applied to that customer''s invoice';
  end if;
  if deposit_invoice.project_id is not null and target_invoice.project_id is distinct from deposit_invoice.project_id then
    raise exception 'A project deposit can only be applied within that project';
  end if;

  select coalesce(sum(amount_cents), 0) into refunded_cents
  from public.payment_reversals
  where org_id = p_org_id and payment_id = p_deposit_payment_id and status = 'succeeded';
  select coalesce(sum(amount_cents), 0) into applied_cents
  from public.payments
  where org_id = p_org_id
    and status in ('succeeded', 'completed')
    and metadata ->> 'deposit_payment_id' = p_deposit_payment_id::text;
  if applied_cents + refunded_cents + p_amount_cents > deposit_payment.amount_cents then
    raise exception 'Deposit application exceeds the unapplied deposit balance';
  end if;

  result := public.apply_invoice_payment_with_details_atomic(
    p_org_id, p_target_invoice_id, p_amount_cents, deposit_payment.currency,
    'credit', 'arc_books', 'deposit:' || p_deposit_payment_id::text || ':' || p_target_invoice_id::text,
    'succeeded', 'Customer deposit application', 0, p_amount_cents, p_amount_cents,
    'deposit:' || p_deposit_payment_id::text || ':' || p_target_invoice_id::text,
    jsonb_build_object(
      'customer_deposit_application', true,
      'deposit_payment_id', p_deposit_payment_id,
      'deposit_invoice_id', deposit_payment.invoice_id,
      'applied_by', p_actor_id
    ), p_received_at, null, null, 0, 0, 0, null, null
  );
  return result;
end;
$$;

revoke all on function public.begin_books_period_close(uuid, uuid) from public, anon, authenticated;
revoke all on function public.cancel_books_period_close(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.reverse_books_journal_entry(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.apply_invoice_payment_with_details_atomic(uuid, uuid, integer, text, text, text, text, text, text, integer, integer, integer, text, jsonb, timestamptz, text, text, integer, integer, integer, text, text) from public, anon, authenticated;
revoke all on function public.project_books_fact_and_journal_atomic(uuid, uuid, jsonb, jsonb, jsonb, date, text) from public, anon, authenticated;
revoke all on function public.apply_customer_deposit_atomic(uuid, uuid, uuid, integer, uuid, timestamptz) from public, anon, authenticated;

grant execute on function public.begin_books_period_close(uuid, uuid) to service_role;
grant execute on function public.cancel_books_period_close(uuid, uuid, text) to service_role;
grant execute on function public.reverse_books_journal_entry(uuid, uuid, jsonb, jsonb) to service_role;
grant execute on function public.apply_invoice_payment_with_details_atomic(uuid, uuid, integer, text, text, text, text, text, text, integer, integer, integer, text, jsonb, timestamptz, text, text, integer, integer, integer, text, text) to service_role;
grant execute on function public.project_books_fact_and_journal_atomic(uuid, uuid, jsonb, jsonb, jsonb, date, text) to service_role;
grant execute on function public.apply_customer_deposit_atomic(uuid, uuid, uuid, integer, uuid, timestamptz) to service_role;

revoke all on function public.books_guard_period_posting() from public, anon, authenticated;
revoke all on function public.books_touch_vendor_bill_from_line() from public, anon, authenticated;
revoke all on function public.books_touch_expense_from_line() from public, anon, authenticated;
revoke all on function public.books_touch_invoice_from_retainage() from public, anon, authenticated;

commit;
