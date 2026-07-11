-- Final commercial claims controls: separate internal PCO and executed OCO
-- numbering, pay-application lifecycle timestamps, and defensible delay evidence.
-- Additive only; intentionally pending production application.

alter table public.change_orders
  add column if not exists executed_change_order_number integer;

with ranked as (
  select id,
    row_number() over (
      partition by project_id
      order by approved_at nulls last, created_at, co_number, id
    )::integer as executed_number
  from public.change_orders
  where lifecycle = 'approved' or status = 'approved'
)
update public.change_orders co
set executed_change_order_number = ranked.executed_number
from ranked
where co.id = ranked.id
  and co.executed_change_order_number is null;

create unique index if not exists change_orders_project_executed_number_key
  on public.change_orders (project_id, executed_change_order_number)
  where executed_change_order_number is not null;

create or replace function public.assign_executed_change_order_number()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.executed_change_order_number is null
     and (new.lifecycle = 'approved' or new.status = 'approved') then
    perform pg_advisory_xact_lock(hashtextextended('oco:' || new.project_id::text, 0));
    select coalesce(max(co.executed_change_order_number), 0) + 1
      into new.executed_change_order_number
    from public.change_orders co
    where co.project_id = new.project_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_assign_executed_change_order_number on public.change_orders;
create trigger trg_assign_executed_change_order_number
  before insert or update of lifecycle, status on public.change_orders
  for each row execute function public.assign_executed_change_order_number();

comment on column public.change_orders.co_number is
  'Internal project PCO sequence, assigned at creation. Retained for API compatibility.';
comment on column public.change_orders.executed_change_order_number is
  'Contiguous owner-facing OCO sequence, assigned atomically when the change order is approved.';

alter table public.pay_applications
  add column if not exists paid_at timestamptz;

create or replace function public.reconcile_pay_application_invoice_status()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = 'paid' or coalesce(new.balance_due_cents, 1) = 0 then
    update public.pay_applications
    set status = 'paid', paid_at = coalesce(paid_at, now()), updated_at = now()
    where org_id = new.org_id and invoice_id = new.id and status <> 'void';
  elsif old.status = 'paid' and new.status <> 'paid' then
    update public.pay_applications
    set status = case when approved_at is not null then 'approved' else 'invoiced' end,
        paid_at = null,
        updated_at = now()
    where org_id = new.org_id and invoice_id = new.id and status = 'paid';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_reconcile_pay_application_invoice_status on public.invoices;
create trigger trg_reconcile_pay_application_invoice_status
  after update of status, balance_due_cents on public.invoices
  for each row
  when (old.status is distinct from new.status
    or old.balance_due_cents is distinct from new.balance_due_cents)
  execute function public.reconcile_pay_application_invoice_status();

update public.pay_applications pa
set status = 'paid', paid_at = coalesce(pa.paid_at, now()), updated_at = now()
from public.invoices i
where pa.invoice_id = i.id
  and pa.org_id = i.org_id
  and pa.status <> 'void'
  and (i.status = 'paid' or coalesce(i.balance_due_cents, 1) = 0);

alter table public.daily_report_delays
  add column if not exists delay_start_time time,
  add column if not exists delay_end_time time,
  add column if not exists owner_notice_sent boolean not null default false,
  add column if not exists owner_notice_date date,
  add column if not exists owner_notice_reference text;

alter table public.daily_report_delays
  drop constraint if exists daily_report_delays_time_window_check,
  add constraint daily_report_delays_time_window_check
    check (delay_start_time is null or delay_end_time is null or delay_end_time >= delay_start_time),
  drop constraint if exists daily_report_delays_owner_notice_check,
  add constraint daily_report_delays_owner_notice_check
    check (not owner_notice_sent or owner_notice_date is not null);

create index if not exists daily_report_delays_owner_notice_idx
  on public.daily_report_delays (org_id, project_id, owner_notice_sent, owner_notice_date desc);

comment on column public.daily_report_delays.owner_notice_reference is
  'Email subject/message id, certified-mail receipt, letter number, or other notice evidence reference.';
