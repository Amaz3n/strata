begin;

create table if not exists public.receivable_adjustments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  adjustment_type text not null check (adjustment_type in ('credit_memo', 'write_off')),
  status text not null default 'posted' check (status in ('posted', 'void')),
  amount_cents integer not null check (amount_cents > 0),
  tax_cents integer not null default 0 check (tax_cents >= 0 and tax_cents <= amount_cents),
  effective_date date not null default current_date,
  reason text not null check (length(trim(reason)) > 0),
  idempotency_key text,
  created_by uuid references auth.users(id) on delete set null,
  voided_by uuid references auth.users(id) on delete set null,
  voided_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists receivable_adjustments_idempotency_idx
  on public.receivable_adjustments (org_id, idempotency_key);
create index if not exists receivable_adjustments_invoice_timeline_idx
  on public.receivable_adjustments (org_id, invoice_id, created_at desc);
create index if not exists receivable_adjustments_projection_idx
  on public.receivable_adjustments (org_id, updated_at, id);

alter table public.receivable_adjustments enable row level security;
drop policy if exists receivable_adjustments_access on public.receivable_adjustments;
create policy receivable_adjustments_access on public.receivable_adjustments
  using (auth.role() = 'service_role' or public.is_org_member(org_id))
  with check (auth.role() = 'service_role' or public.is_org_member(org_id));
grant select on public.receivable_adjustments to authenticated;
grant select, insert, update on public.receivable_adjustments to service_role;

-- A posted credit or write-off clears AR exactly like a settled receipt for
-- operational balance purposes, while remaining its own accounting source.
create or replace function public.invoice_paid_cents(
  p_org_id uuid,
  p_invoice_id uuid
) returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select greatest(
    coalesce((
      select sum(amount_cents)
      from public.payments
      where org_id = p_org_id
        and invoice_id = p_invoice_id
        and status in ('succeeded', 'completed', 'paid', 'refunded')
    ), 0)
    + coalesce((
      select sum(pa.amount_cents)
      from public.payment_allocations pa
      join public.payments p on p.id = pa.payment_id and p.org_id = pa.org_id
      where pa.org_id = p_org_id
        and pa.invoice_id = p_invoice_id
        and p.status in ('succeeded', 'completed', 'paid', 'refunded')
    ), 0)
    - coalesce((
      select sum(amount_cents)
      from public.payment_reversals
      where org_id = p_org_id
        and invoice_id = p_invoice_id
        and status = 'succeeded'
    ), 0)
    + coalesce((
      select sum(amount_cents)
      from public.receivable_adjustments
      where org_id = p_org_id
        and invoice_id = p_invoice_id
        and status = 'posted'
    ), 0)
  , 0);
$$;

revoke all on function public.invoice_paid_cents(uuid, uuid) from public, anon, authenticated;
grant execute on function public.invoice_paid_cents(uuid, uuid) to service_role;

create or replace function public.create_receivable_adjustment_atomic(
  p_org_id uuid,
  p_invoice_id uuid,
  p_adjustment_type text,
  p_amount_cents integer,
  p_tax_cents integer,
  p_effective_date date,
  p_reason text,
  p_actor_id uuid,
  p_idempotency_key text default null,
  p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_invoice public.invoices%rowtype;
  v_adjustment public.receivable_adjustments%rowtype;
  v_open_cents integer;
  v_prior_tax_cents integer;
begin
  if p_adjustment_type not in ('credit_memo', 'write_off') then
    raise exception 'Unsupported receivable adjustment type';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Adjustment amount must be positive';
  end if;
  if coalesce(p_tax_cents, 0) < 0 or coalesce(p_tax_cents, 0) > p_amount_cents then
    raise exception 'Adjustment tax amount is invalid';
  end if;
  if p_adjustment_type = 'write_off' and coalesce(p_tax_cents, 0) <> 0 then
    raise exception 'A write-off cannot reverse sales tax';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'Adjustment reason is required';
  end if;

  if p_idempotency_key is not null then
    select * into v_adjustment
    from public.receivable_adjustments
    where org_id = p_org_id and idempotency_key = p_idempotency_key;
    if v_adjustment.id is not null then return to_jsonb(v_adjustment); end if;
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and org_id = p_org_id
  for update;
  if v_invoice.id is null then raise exception 'Invoice not found'; end if;
  if v_invoice.status in ('draft', 'saved', 'void') or v_invoice.client_visible is not true then
    raise exception 'Only an issued, active invoice can be adjusted';
  end if;
  if (v_invoice.metadata ->> 'invoice_kind') = 'earnest_deposit' then
    raise exception 'Deposit refunds must use the customer deposit workflow';
  end if;

  select coalesce(sum(tax_cents), 0) into v_prior_tax_cents
  from public.receivable_adjustments
  where org_id = p_org_id and invoice_id = p_invoice_id
    and adjustment_type = 'credit_memo' and status = 'posted';
  if p_adjustment_type = 'credit_memo'
    and v_prior_tax_cents + coalesce(p_tax_cents, 0) > coalesce(v_invoice.tax_cents, 0) then
    raise exception 'Credit memo reverses more sales tax than the invoice charged';
  end if;

  v_open_cents := greatest(coalesce(v_invoice.total_cents, 0) - public.invoice_paid_cents(p_org_id, p_invoice_id), 0);
  if p_amount_cents > v_open_cents then
    raise exception 'Adjustment exceeds the open invoice balance';
  end if;

  insert into public.receivable_adjustments (
    org_id, project_id, invoice_id, adjustment_type, status, amount_cents,
    tax_cents, effective_date, reason, idempotency_key, created_by, metadata
  ) values (
    p_org_id, v_invoice.project_id, p_invoice_id, p_adjustment_type, 'posted',
    p_amount_cents, coalesce(p_tax_cents, 0), coalesce(p_effective_date, current_date),
    trim(p_reason), p_idempotency_key, p_actor_id, coalesce(p_metadata, '{}'::jsonb)
  ) returning * into v_adjustment;

  perform public.recalc_invoice_balance_atomic(p_org_id, p_invoice_id);
  update public.invoices
  set qbo_sync_status = case when qbo_id is not null then 'needs_review' else qbo_sync_status end
  where id = p_invoice_id and org_id = p_org_id;
  return to_jsonb(v_adjustment);
end;
$$;

create or replace function public.void_receivable_adjustment_atomic(
  p_org_id uuid,
  p_adjustment_id uuid,
  p_actor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_adjustment public.receivable_adjustments%rowtype;
begin
  select * into v_adjustment
  from public.receivable_adjustments
  where id = p_adjustment_id and org_id = p_org_id
  for update;
  if v_adjustment.id is null then raise exception 'Receivable adjustment not found'; end if;
  if v_adjustment.status = 'void' then return to_jsonb(v_adjustment); end if;

  update public.receivable_adjustments
  set status = 'void', voided_by = p_actor_id, voided_at = now(), updated_at = now()
  where id = p_adjustment_id and org_id = p_org_id
  returning * into v_adjustment;

  perform public.recalc_invoice_balance_atomic(p_org_id, v_adjustment.invoice_id);
  update public.invoices
  set qbo_sync_status = case when qbo_id is not null then 'needs_review' else qbo_sync_status end
  where id = v_adjustment.invoice_id and org_id = p_org_id;
  return to_jsonb(v_adjustment);
end;
$$;

revoke all on function public.create_receivable_adjustment_atomic(uuid, uuid, text, integer, integer, date, text, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.void_receivable_adjustment_atomic(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_receivable_adjustment_atomic(uuid, uuid, text, integer, integer, date, text, uuid, text, jsonb) to service_role;
grant execute on function public.void_receivable_adjustment_atomic(uuid, uuid, uuid) to service_role;

insert into public.gl_accounts (
  org_id, code, name, account_type, subtype, normal_balance,
  cash_flow_category, is_system, active
)
select settings.org_id, '6090', 'Bad debt expense', 'expense', 'other_expense', 'debit',
  'operating', true, true
from public.books_settings settings
on conflict (org_id, code) do nothing;

commit;
