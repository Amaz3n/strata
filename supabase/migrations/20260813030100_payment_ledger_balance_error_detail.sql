-- Say what is actually wrong with an unbalanced payment ledger transaction.
--
-- PENDING — NOT APPLIED. Written by an agent; needs human review and approval
-- before it is run against the linked project.
--
-- The balance check counted and summed only the entries matching the
-- transaction's currency, so an entry denominated in anything else was dropped
-- from the arithmetic and then silently inserted anyway by the unfiltered
-- INSERT below it. The caller was told "Ledger transaction is not balanced",
-- which is true of the surviving subset and useless as a diagnosis: the entries
-- the caller passed balance perfectly, and the real fault is a currency that
-- does not belong to this transaction.
--
-- Three distinct failures, three distinct messages, and a currency mismatch is
-- now rejected outright rather than half-recorded. Behaviour for every existing
-- caller is unchanged — they all pass a single currency — so this only changes
-- what happens on the path that used to corrupt the entry set.

begin;

create or replace function public.post_payment_ledger_transaction_atomic(
  p_org_id uuid,
  p_disbursement_id uuid,
  p_provider_event_id uuid,
  p_source_type text,
  p_source_id uuid,
  p_transaction_type text,
  p_currency text,
  p_idempotency_key text,
  p_reverses_transaction_id uuid,
  p_description text,
  p_effective_at timestamptz,
  p_entries jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transaction public.payment_ledger_transactions%rowtype;
  v_debits bigint;
  v_credits bigint;
  v_entry_count integer;
  v_supplied_count integer;
  v_foreign_currencies text;
begin
  if jsonb_typeof(p_entries) <> 'array' then raise exception 'Ledger entries must be an array'; end if;

  select count(*)::integer,
    string_agg(distinct lower(entry.currency), ', ')
      filter (where lower(entry.currency) is distinct from lower(p_currency))
  into v_supplied_count, v_foreign_currencies
  from jsonb_to_recordset(p_entries) as entry(account_code text, direction text, amount_cents bigint, currency text);

  if v_foreign_currencies is not null then
    raise exception 'Ledger transaction is in % but carries entries in %; a transaction cannot mix currencies',
      lower(p_currency), v_foreign_currencies;
  end if;

  select count(*)::integer,
    coalesce(sum(case when direction = 'debit' then amount_cents else 0 end), 0),
    coalesce(sum(case when direction = 'credit' then amount_cents else 0 end), 0)
  into v_entry_count, v_debits, v_credits
  from jsonb_to_recordset(p_entries) as entry(account_code text, direction text, amount_cents bigint, currency text)
  where direction in ('debit','credit') and amount_cents > 0;

  if v_entry_count < v_supplied_count then
    raise exception 'Ledger transaction has % entr(y/ies) that are neither a positive debit nor a positive credit', v_supplied_count - v_entry_count;
  end if;
  if v_entry_count < 2 then
    raise exception 'Ledger transaction needs at least two entries, got %', v_entry_count;
  end if;
  if v_debits <> v_credits then
    raise exception 'Ledger transaction is not balanced: % in debits against % in credits', v_debits, v_credits;
  end if;

  select * into v_transaction from public.payment_ledger_transactions
  where org_id = p_org_id and idempotency_key = p_idempotency_key;
  if v_transaction.id is not null then
    return to_jsonb(v_transaction) || jsonb_build_object('duplicate', true);
  end if;

  insert into public.payment_ledger_transactions (
    org_id, disbursement_id, provider_event_id, source_type, source_id,
    transaction_type, currency, idempotency_key, reverses_transaction_id,
    description, effective_at
  ) values (
    p_org_id, p_disbursement_id, p_provider_event_id, p_source_type, p_source_id,
    p_transaction_type, lower(p_currency), p_idempotency_key, p_reverses_transaction_id,
    p_description, p_effective_at
  ) returning * into v_transaction;

  insert into public.payment_ledger_entries (org_id, transaction_id, account_code, direction, amount_cents, currency)
  select p_org_id, v_transaction.id, account_code, direction, amount_cents, lower(currency)
  from jsonb_to_recordset(p_entries) as entry(account_code text, direction text, amount_cents bigint, currency text);
  return to_jsonb(v_transaction) || jsonb_build_object('duplicate', false);
end;
$$;

revoke all on function public.post_payment_ledger_transaction_atomic(uuid,uuid,uuid,text,uuid,text,text,text,uuid,text,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.post_payment_ledger_transaction_atomic(uuid,uuid,uuid,text,uuid,text,text,text,uuid,text,timestamptz,jsonb) to service_role;

commit;
