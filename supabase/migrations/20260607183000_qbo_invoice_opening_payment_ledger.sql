-- Represent paid amounts imported from QBO as explicit opening payment rows.
-- This keeps invoice balances reconstructible before Arc records new payments.

create or replace function public.sync_qbo_invoice_opening_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_other_paid bigint;
  v_reversed bigint;
  v_opening_cents integer;
  v_existing_id uuid;
begin
  if new.qbo_id is null or new.status = 'void' then
    return new;
  end if;

  select coalesce(sum(amount_cents), 0)
    into v_other_paid
    from public.payments
    where org_id = new.org_id
      and invoice_id = new.id
      and provider is distinct from 'qbo_opening_balance'
      and status in ('processing', 'succeeded', 'completed', 'refunded');

  select coalesce(sum(amount_cents), 0)
    into v_reversed
    from public.payment_reversals
    where org_id = new.org_id
      and invoice_id = new.id
      and status in ('pending', 'succeeded');

  v_opening_cents := greatest(
    coalesce(new.total_cents, 0)
      - coalesce(new.balance_due_cents, new.total_cents, 0)
      - greatest(v_other_paid - v_reversed, 0),
    0
  );

  select id
    into v_existing_id
    from public.payments
    where org_id = new.org_id
      and invoice_id = new.id
      and provider = 'qbo_opening_balance'
    limit 1
    for update;

  if v_opening_cents > 0 and v_existing_id is null then
    insert into public.payments (
      org_id, project_id, invoice_id, amount_cents, gross_cents, currency,
      method, provider, status, reference, fee_cents, net_cents,
      idempotency_key, metadata, received_at
    )
    values (
      new.org_id, new.project_id, new.id, v_opening_cents, v_opening_cents,
      coalesce(new.currency, 'usd'), 'opening_balance', 'qbo_opening_balance',
      'completed', 'Imported paid balance from QuickBooks', 0, v_opening_cents,
      'qbo-opening-balance:' || new.id::text,
      jsonb_build_object(
        'system_generated', true,
        'source', 'qbo_invoice_balance',
        'qbo_invoice_id', new.qbo_id
      ),
      coalesce(new.qbo_synced_at, new.updated_at, now())
    );
  elsif v_opening_cents > 0 then
    update public.payments
       set amount_cents = v_opening_cents,
           gross_cents = v_opening_cents,
           net_cents = v_opening_cents,
           currency = coalesce(new.currency, currency, 'usd'),
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
             'qbo_invoice_id', new.qbo_id,
             'last_reconciled_at', now()
           )
     where id = v_existing_id;
  elsif v_existing_id is not null then
    delete from public.payments where id = v_existing_id;
  end if;

  return new;
end;
$$;

drop trigger if exists invoices_sync_qbo_opening_payment on public.invoices;
create trigger invoices_sync_qbo_opening_payment
  after insert or update of qbo_id, total_cents, balance_due_cents, status
  on public.invoices
  for each row execute function public.sync_qbo_invoice_opening_payment();

-- Backfill existing QBO invoices without altering their invoice facts.
update public.invoices
   set balance_due_cents = balance_due_cents
 where qbo_id is not null
   and status <> 'void';
