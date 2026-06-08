-- Production receivables hardening and experimental Arc Autopilot foundation.
-- Financial mutations in this migration are row-locked and idempotent.

-- Historical test organizations contain duplicate invoice numbers. Preserve those
-- records, but serialize and reject every future duplicate insert or renumber.
create or replace function public.enforce_invoice_number_uniqueness()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.invoice_number is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(new.org_id::text || ':' || new.invoice_number, 0)
  );

  if exists (
    select 1
    from public.invoices
    where org_id = new.org_id
      and invoice_number = new.invoice_number
      and id <> new.id
  ) then
    raise exception 'Invoice number % already exists in this organization', new.invoice_number
      using errcode = '23505';
  end if;

  return new;
end;
$$;

drop trigger if exists invoices_enforce_number_uniqueness on public.invoices;
create trigger invoices_enforce_number_uniqueness
  before insert or update of org_id, invoice_number on public.invoices
  for each row execute function public.enforce_invoice_number_uniqueness();

create unique index if not exists invoices_token_uq
  on public.invoices (token)
  where token is not null;

do $$
begin
  if exists (
    select 1
    from public.payments
    where provider_payment_id is not null
    group by org_id, coalesce(provider, ''), provider_payment_id
    having count(*) > 1
  ) then
    raise exception
      'Duplicate provider payment identifiers exist. Resolve them before applying receivables hardening.';
  end if;
end;
$$;

create unique index if not exists payments_org_provider_payment_uq
  on public.payments (org_id, coalesce(provider, ''), provider_payment_id)
  where provider_payment_id is not null;
create unique index if not exists payments_org_idempotency_uq
  on public.payments (org_id, idempotency_key)
  where idempotency_key is not null;

alter table public.invoices
  drop constraint if exists invoices_status_check;
alter table public.invoices
  add constraint invoices_status_check
  check (status in ('draft', 'saved', 'sent', 'partial', 'paid', 'overdue', 'void'));

alter table public.payments
  drop constraint if exists payments_amount_positive_check;
alter table public.payments
  add constraint payments_amount_positive_check check (amount_cents > 0);

alter table public.payments
  drop constraint if exists payments_status_check;
alter table public.payments
  add constraint payments_status_check
  check (status in ('pending', 'processing', 'succeeded', 'completed', 'failed', 'canceled', 'refunded'));

create table if not exists public.payment_reversals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  payment_id uuid not null references public.payments(id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0),
  reversal_type text not null check (
    reversal_type in ('refund', 'ach_return', 'chargeback', 'dispute', 'correction')
  ),
  status text not null default 'succeeded' check (
    status in ('pending', 'succeeded', 'reversed', 'failed')
  ),
  provider_reversal_id text,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists payment_reversals_provider_uq
  on public.payment_reversals (org_id, provider_reversal_id)
  where provider_reversal_id is not null;
create index if not exists payment_reversals_invoice_idx
  on public.payment_reversals (org_id, invoice_id, status);

alter table public.payment_reversals enable row level security;
drop policy if exists payment_reversals_access on public.payment_reversals;
create policy payment_reversals_access
  on public.payment_reversals
  using (
    auth.role() = 'service_role'
    or (
      public.is_org_member(org_id)
      and (project_id is null or public.is_project_member(project_id) or public.is_org_admin_member(org_id))
    )
  )
  with check (
    auth.role() = 'service_role'
    or (
      public.is_org_member(org_id)
      and (project_id is null or public.is_project_member(project_id) or public.is_org_admin_member(org_id))
    )
  );
grant all on public.payment_reversals to authenticated, service_role;

drop trigger if exists payment_reversals_set_updated_at on public.payment_reversals;
create trigger payment_reversals_set_updated_at
  before update on public.payment_reversals
  for each row execute function public.tg_set_updated_at();

create table if not exists public.billing_autopilot_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  billing_model text not null check (
    billing_model in (
      'fixed_price',
      'cost_plus_percent',
      'cost_plus_fixed_fee',
      'cost_plus_gmp',
      'time_and_materials'
    )
  ),
  status text not null default 'prepared' check (
    status in ('prepared', 'reviewing', 'approved', 'dismissed', 'superseded', 'failed')
  ),
  period_start date,
  period_end date,
  proposed_invoice_cents bigint not null default 0 check (proposed_invoice_cents >= 0),
  readiness_score integer not null default 0 check (readiness_score between 0 and 100),
  blocker_count integer not null default 0 check (blocker_count >= 0),
  summary jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  prepared_by uuid,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, idempotency_key)
);

create table if not exists public.billing_autopilot_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  run_id uuid not null references public.billing_autopilot_runs(id) on delete cascade,
  item_type text not null check (
    item_type in (
      'draw_ready',
      'draw_due',
      'approved_unbilled_cost',
      'fee_ready',
      'retainage_ready',
      'change_order_pending',
      'missing_proof',
      'progress_confirmation',
      'reconciliation_exception'
    )
  ),
  status text not null default 'suggested' check (
    status in ('suggested', 'needs_review', 'blocked', 'accepted', 'dismissed', 'executed')
  ),
  source_type text,
  source_id uuid,
  title text not null,
  description text,
  amount_cents bigint not null default 0,
  confidence numeric(5, 4),
  blocker_codes text[] not null default '{}',
  evidence jsonb not null default '[]'::jsonb,
  proposed_action jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists billing_autopilot_runs_project_idx
  on public.billing_autopilot_runs (org_id, project_id, created_at desc);
create index if not exists billing_autopilot_items_run_idx
  on public.billing_autopilot_items (run_id, status);

alter table public.billing_autopilot_runs enable row level security;
alter table public.billing_autopilot_items enable row level security;

drop policy if exists billing_autopilot_runs_access on public.billing_autopilot_runs;
create policy billing_autopilot_runs_access
  on public.billing_autopilot_runs
  using (
    auth.role() = 'service_role'
    or (
      public.is_org_member(org_id)
      and (public.is_project_member(project_id) or public.is_org_admin_member(org_id))
    )
  )
  with check (
    auth.role() = 'service_role'
    or (
      public.is_org_member(org_id)
      and (public.is_project_member(project_id) or public.is_org_admin_member(org_id))
    )
  );

drop policy if exists billing_autopilot_items_access on public.billing_autopilot_items;
create policy billing_autopilot_items_access
  on public.billing_autopilot_items
  using (
    auth.role() = 'service_role'
    or (
      public.is_org_member(org_id)
      and (public.is_project_member(project_id) or public.is_org_admin_member(org_id))
    )
  )
  with check (
    auth.role() = 'service_role'
    or (
      public.is_org_member(org_id)
      and (public.is_project_member(project_id) or public.is_org_admin_member(org_id))
    )
  );

grant all on public.billing_autopilot_runs to authenticated, service_role;
grant all on public.billing_autopilot_items to authenticated, service_role;

drop trigger if exists billing_autopilot_runs_set_updated_at on public.billing_autopilot_runs;
create trigger billing_autopilot_runs_set_updated_at
  before update on public.billing_autopilot_runs
  for each row execute function public.tg_set_updated_at();

drop trigger if exists billing_autopilot_items_set_updated_at on public.billing_autopilot_items;
create trigger billing_autopilot_items_set_updated_at
  before update on public.billing_autopilot_items
  for each row execute function public.tg_set_updated_at();

create or replace function public.apply_invoice_payment_atomic(
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
  p_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices%rowtype;
  v_existing public.payments%rowtype;
  v_payment public.payments%rowtype;
  v_paid_cents bigint;
  v_balance_cents integer;
  v_next_status text;
begin
  if p_amount_cents <= 0 then
    raise exception 'Payment amount must be positive';
  end if;

  if p_status not in ('pending', 'processing', 'succeeded', 'completed', 'failed', 'canceled', 'refunded') then
    raise exception 'Unsupported payment status';
  end if;

  if p_idempotency_key is not null then
    select *
      into v_existing
      from public.payments
      where org_id = p_org_id
        and idempotency_key = p_idempotency_key
      limit 1;
    if v_existing.id is not null then
      return to_jsonb(v_existing);
    end if;
  end if;

  if p_provider_payment_id is not null then
    select *
      into v_existing
      from public.payments
      where org_id = p_org_id
        and coalesce(provider, '') = coalesce(p_provider, '')
        and provider_payment_id = p_provider_payment_id
      limit 1;
    if v_existing.id is not null then
      return to_jsonb(v_existing);
    end if;
  end if;

  select *
    into v_invoice
    from public.invoices
    where id = p_invoice_id
      and org_id = p_org_id
    for update;

  if v_invoice.id is null then
    raise exception 'Invoice not found or inaccessible';
  end if;
  if v_invoice.status = 'void' then
    raise exception 'Cannot apply payment to a void invoice';
  end if;

  select coalesce(sum(amount_cents), 0)
    into v_paid_cents
    from public.payments
    where org_id = p_org_id
      and invoice_id = p_invoice_id
      and status in ('processing', 'succeeded', 'completed');

  if p_status in ('processing', 'succeeded', 'completed')
    and p_amount_cents > greatest(coalesce(v_invoice.total_cents, 0) - v_paid_cents, 0) then
    raise exception 'Payment exceeds the outstanding invoice balance';
  end if;

  insert into public.payments (
    org_id,
    project_id,
    invoice_id,
    amount_cents,
    gross_cents,
    currency,
    method,
    provider,
    provider_payment_id,
    status,
    reference,
    fee_cents,
    net_cents,
    idempotency_key,
    metadata
  )
  values (
    p_org_id,
    v_invoice.project_id,
    p_invoice_id,
    p_amount_cents,
    coalesce(p_gross_cents, p_amount_cents),
    coalesce(nullif(p_currency, ''), 'usd'),
    p_method,
    p_provider,
    p_provider_payment_id,
    p_status,
    p_reference,
    coalesce(p_fee_cents, 0),
    coalesce(p_net_cents, coalesce(p_gross_cents, p_amount_cents) - coalesce(p_fee_cents, 0)),
    p_idempotency_key,
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning * into v_payment;

  if p_status in ('processing', 'succeeded', 'completed') then
    v_paid_cents := v_paid_cents + p_amount_cents;
  end if;

  v_balance_cents := greatest(coalesce(v_invoice.total_cents, 0) - v_paid_cents, 0);
  v_next_status := case
    when v_balance_cents = 0 and coalesce(v_invoice.total_cents, 0) > 0 then 'paid'
    when v_paid_cents > 0 then 'partial'
    when v_invoice.sent_at is null and not coalesce(v_invoice.client_visible, false)
      then case when v_invoice.status = 'draft' then 'draft' else 'saved' end
    when v_invoice.due_date is not null and v_invoice.due_date < current_date then 'overdue'
    else 'sent'
  end;

  update public.invoices
     set balance_due_cents = v_balance_cents,
         status = v_next_status
   where id = p_invoice_id
     and org_id = p_org_id;

  return to_jsonb(v_payment) || jsonb_build_object(
    'invoice_balance_due_cents', v_balance_cents,
    'invoice_status', v_next_status
  );
end;
$$;

grant execute on function public.apply_invoice_payment_atomic(
  uuid, uuid, integer, text, text, text, text, text, text,
  integer, integer, integer, text, jsonb
) to service_role;

create or replace function public.record_payment_reversal_atomic(
  p_org_id uuid,
  p_payment_id uuid,
  p_amount_cents integer,
  p_reversal_type text,
  p_provider_reversal_id text,
  p_reason text,
  p_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payments%rowtype;
  v_invoice public.invoices%rowtype;
  v_existing public.payment_reversals%rowtype;
  v_reversal public.payment_reversals%rowtype;
  v_reversed_for_payment bigint;
  v_net_paid bigint;
  v_balance integer;
  v_status text;
begin
  if p_amount_cents <= 0 then
    raise exception 'Reversal amount must be positive';
  end if;
  if p_reversal_type not in ('refund', 'ach_return', 'chargeback', 'dispute', 'correction') then
    raise exception 'Unsupported payment reversal type';
  end if;

  if p_provider_reversal_id is not null then
    select *
      into v_existing
      from public.payment_reversals
      where org_id = p_org_id
        and provider_reversal_id = p_provider_reversal_id
      limit 1;
    if v_existing.id is not null then
      return to_jsonb(v_existing);
    end if;
  end if;

  select *
    into v_payment
    from public.payments
    where id = p_payment_id
      and org_id = p_org_id
    for update;
  if v_payment.id is null or v_payment.invoice_id is null then
    raise exception 'Invoice payment not found';
  end if;

  select *
    into v_invoice
    from public.invoices
    where id = v_payment.invoice_id
      and org_id = p_org_id
    for update;
  if v_invoice.id is null then
    raise exception 'Invoice not found';
  end if;

  select coalesce(sum(amount_cents), 0)
    into v_reversed_for_payment
    from public.payment_reversals
    where org_id = p_org_id
      and payment_id = p_payment_id
      and status in ('pending', 'succeeded');

  if v_reversed_for_payment + p_amount_cents > v_payment.amount_cents then
    raise exception 'Reversal exceeds the original payment amount';
  end if;

  insert into public.payment_reversals (
    org_id, project_id, invoice_id, payment_id, amount_cents,
    reversal_type, status, provider_reversal_id, reason, metadata
  )
  values (
    p_org_id, v_payment.project_id, v_payment.invoice_id, v_payment.id, p_amount_cents,
    p_reversal_type, 'succeeded', p_provider_reversal_id, p_reason, coalesce(p_metadata, '{}'::jsonb)
  )
  returning * into v_reversal;

  if v_reversed_for_payment + p_amount_cents = v_payment.amount_cents then
    update public.payments
       set status = 'refunded'
     where id = v_payment.id
       and org_id = p_org_id;
  end if;

  select
    coalesce((
      select sum(amount_cents)
      from public.payments
      where org_id = p_org_id
        and invoice_id = v_invoice.id
        and status in ('processing', 'succeeded', 'completed', 'refunded')
    ), 0)
    -
    coalesce((
      select sum(amount_cents)
      from public.payment_reversals
      where org_id = p_org_id
        and invoice_id = v_invoice.id
        and status in ('pending', 'succeeded')
    ), 0)
    into v_net_paid;

  v_net_paid := greatest(v_net_paid, 0);
  v_balance := greatest(coalesce(v_invoice.total_cents, 0) - v_net_paid, 0);
  v_status := case
    when v_invoice.status = 'void' then 'void'
    when v_balance = 0 and coalesce(v_invoice.total_cents, 0) > 0 then 'paid'
    when v_net_paid > 0 then 'partial'
    when v_invoice.sent_at is null and not coalesce(v_invoice.client_visible, false)
      then case when v_invoice.status = 'draft' then 'draft' else 'saved' end
    when v_invoice.due_date is not null and v_invoice.due_date < current_date then 'overdue'
    else 'sent'
  end;

  update public.invoices
     set balance_due_cents = v_balance,
         status = v_status
   where id = v_invoice.id
     and org_id = p_org_id;

  return to_jsonb(v_reversal) || jsonb_build_object(
    'invoice_balance_due_cents', v_balance,
    'invoice_status', v_status
  );
end;
$$;

grant execute on function public.record_payment_reversal_atomic(
  uuid, uuid, integer, text, text, text, jsonb
) to service_role;

create or replace function public.resolve_payment_reversal_atomic(
  p_org_id uuid,
  p_provider_reversal_id text,
  p_outcome text,
  p_reason text,
  p_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reversal public.payment_reversals%rowtype;
  v_payment public.payments%rowtype;
  v_invoice public.invoices%rowtype;
  v_net_paid bigint;
  v_balance integer;
  v_status text;
begin
  if p_outcome not in ('succeeded', 'reversed') then
    raise exception 'Unsupported reversal outcome';
  end if;

  select *
    into v_reversal
    from public.payment_reversals
    where org_id = p_org_id
      and provider_reversal_id = p_provider_reversal_id
    for update;
  if v_reversal.id is null then
    raise exception 'Payment reversal not found';
  end if;

  update public.payment_reversals
     set status = p_outcome,
         reason = coalesce(p_reason, reason),
         metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_metadata, '{}'::jsonb)
   where id = v_reversal.id
  returning * into v_reversal;

  select *
    into v_payment
    from public.payments
    where id = v_reversal.payment_id
      and org_id = p_org_id
    for update;

  select *
    into v_invoice
    from public.invoices
    where id = v_reversal.invoice_id
      and org_id = p_org_id
    for update;

  if p_outcome = 'reversed' and v_payment.status = 'refunded' then
    update public.payments
       set status = 'succeeded'
     where id = v_payment.id
       and org_id = p_org_id;
  end if;

  select
    coalesce((
      select sum(amount_cents)
      from public.payments
      where org_id = p_org_id
        and invoice_id = v_invoice.id
        and status in ('processing', 'succeeded', 'completed', 'refunded')
    ), 0)
    -
    coalesce((
      select sum(amount_cents)
      from public.payment_reversals
      where org_id = p_org_id
        and invoice_id = v_invoice.id
        and status in ('pending', 'succeeded')
    ), 0)
    into v_net_paid;

  v_net_paid := greatest(v_net_paid, 0);
  v_balance := greatest(coalesce(v_invoice.total_cents, 0) - v_net_paid, 0);
  v_status := case
    when v_invoice.status = 'void' then 'void'
    when v_balance = 0 and coalesce(v_invoice.total_cents, 0) > 0 then 'paid'
    when v_net_paid > 0 then 'partial'
    when v_invoice.sent_at is null and not coalesce(v_invoice.client_visible, false)
      then case when v_invoice.status = 'draft' then 'draft' else 'saved' end
    when v_invoice.due_date is not null and v_invoice.due_date < current_date then 'overdue'
    else 'sent'
  end;

  update public.invoices
     set balance_due_cents = v_balance,
         status = v_status
   where id = v_invoice.id
     and org_id = p_org_id;

  return to_jsonb(v_reversal) || jsonb_build_object(
    'invoice_balance_due_cents', v_balance,
    'invoice_status', v_status
  );
end;
$$;

grant execute on function public.resolve_payment_reversal_atomic(
  uuid, text, text, text, jsonb
) to service_role;

create or replace function public.sync_retainage_release_invoice_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    if new.status = 'paid' then
      update public.retainage
         set status = 'paid',
             released_at = coalesce(released_at, now())
       where org_id = new.org_id
         and release_invoice_id = new.id
         and status in ('invoiced', 'released');
    elsif old.status = 'paid' and new.status <> 'void' then
      update public.retainage
         set status = 'invoiced'
       where org_id = new.org_id
         and release_invoice_id = new.id
         and status = 'paid';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_sync_retainage_release_status on public.invoices;
create trigger invoices_sync_retainage_release_status
  after update of status on public.invoices
  for each row execute function public.sync_retainage_release_invoice_status();

create or replace function public.restore_retainage_for_void_release_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.retainage%rowtype;
  v_source_id uuid;
begin
  if new.status = 'void' and old.status is distinct from 'void' then
    for v_row in
      select *
      from public.retainage
      where org_id = new.org_id
        and release_invoice_id = new.id
      for update
    loop
      v_source_id := null;
      if coalesce(v_row.metadata ->> 'partial_release', 'false') = 'true'
        and nullif(v_row.metadata ->> 'source_retainage_id', '') is not null then
        begin
          v_source_id := (v_row.metadata ->> 'source_retainage_id')::uuid;
        exception when invalid_text_representation then
          v_source_id := null;
        end;
      end if;

      if v_source_id is not null then
        update public.retainage
           set amount_cents = amount_cents + v_row.amount_cents,
               metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                 'last_release_voided_at', now(),
                 'last_voided_release_invoice_id', new.id
               )
         where id = v_source_id
           and org_id = new.org_id
           and status = 'held';
        if found then
          delete from public.retainage where id = v_row.id;
        else
          update public.retainage
             set status = 'held',
                 released_at = null,
                 release_invoice_id = null
           where id = v_row.id;
        end if;
      else
        update public.retainage
           set status = 'held',
               released_at = null,
               release_invoice_id = null
         where id = v_row.id;
      end if;
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_restore_retainage_on_void on public.invoices;
create trigger invoices_restore_retainage_on_void
  after update of status on public.invoices
  for each row execute function public.restore_retainage_for_void_release_invoice();

create or replace function public.release_project_retainage_atomic(
  p_org_id uuid,
  p_project_id uuid,
  p_actor_id uuid,
  p_amount_cents integer,
  p_invoice_number text,
  p_reservation_id uuid,
  p_title text,
  p_notes text,
  p_issue_date date,
  p_due_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice_id uuid;
  v_row public.retainage%rowtype;
  v_total_held bigint;
  v_remaining integer;
  v_release integer;
  v_released_row_id uuid;
begin
  if p_amount_cents <= 0 then
    raise exception 'Retainage release amount must be positive';
  end if;

  perform 1
    from public.projects
    where id = p_project_id and org_id = p_org_id
    for update;
  if not found then
    raise exception 'Project not found';
  end if;

  perform id
    from public.retainage
    where org_id = p_org_id
      and project_id = p_project_id
      and status = 'held'
    order by held_at, id
    for update;

  select coalesce(sum(amount_cents), 0)
    into v_total_held
    from public.retainage
    where org_id = p_org_id
      and project_id = p_project_id
      and status = 'held';

  if p_amount_cents > v_total_held then
    raise exception 'Retainage release exceeds the held balance';
  end if;

  insert into public.invoices (
    org_id, project_id, token, invoice_number, title, status,
    issue_date, due_date, notes, client_visible,
    subtotal_cents, tax_cents, total_cents, balance_due_cents,
    metadata, sent_at
  )
  values (
    p_org_id, p_project_id, gen_random_uuid()::text, p_invoice_number, p_title, 'sent',
    coalesce(p_issue_date, current_date), p_due_date, p_notes, true,
    p_amount_cents, 0, p_amount_cents, p_amount_cents,
    jsonb_build_object(
      'source_type', 'retainage_release',
      'retainage_release_cents', p_amount_cents,
      'created_by', p_actor_id,
      'lines', jsonb_build_array(jsonb_build_object(
        'description', p_title,
        'quantity', 1,
        'unit', 'release',
        'unit_cost_cents', p_amount_cents,
        'taxable', false
      )),
      'totals', jsonb_build_object(
        'subtotal_cents', p_amount_cents,
        'tax_cents', 0,
        'total_cents', p_amount_cents,
        'balance_due_cents', p_amount_cents
      )
    ),
    now()
  )
  returning id into v_invoice_id;

  insert into public.invoice_lines (
    org_id, invoice_id, description, quantity, unit, unit_price_cents, metadata
  )
  values (
    p_org_id, v_invoice_id, p_title, 1, 'release', p_amount_cents,
    jsonb_build_object('taxable', false, 'system_generated_kind', 'retainage_release')
  );

  v_remaining := p_amount_cents;
  for v_row in
    select *
    from public.retainage
    where org_id = p_org_id
      and project_id = p_project_id
      and status = 'held'
    order by held_at, id
    for update
  loop
    exit when v_remaining <= 0;
    v_release := least(v_row.amount_cents, v_remaining);

    if v_release = v_row.amount_cents then
      update public.retainage
         set status = 'invoiced',
             released_at = now(),
             release_invoice_id = v_invoice_id
       where id = v_row.id;
    else
      insert into public.retainage (
        org_id, project_id, contract_id, invoice_id, amount_cents,
        status, held_at, released_at, release_invoice_id, metadata
      )
      values (
        v_row.org_id, v_row.project_id, v_row.contract_id, v_row.invoice_id, v_release,
        'invoiced', v_row.held_at, now(), v_invoice_id,
        coalesce(v_row.metadata, '{}'::jsonb) || jsonb_build_object(
          'source_retainage_id', v_row.id,
          'partial_release', true
        )
      )
      returning id into v_released_row_id;

      update public.retainage
         set amount_cents = amount_cents - v_release,
             metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
               'last_partial_release_invoice_id', v_invoice_id,
               'last_partial_release_at', now()
             )
       where id = v_row.id;
    end if;
    v_remaining := v_remaining - v_release;
  end loop;

  if v_remaining <> 0 then
    raise exception 'Retainage release allocation failed';
  end if;

  if p_reservation_id is not null then
    update public.qbo_invoice_reservations
       set status = 'used',
           used_by_invoice_id = v_invoice_id
     where org_id = p_org_id
       and id = p_reservation_id
       and status = 'reserved';
  end if;

  return jsonb_build_object(
    'invoice_id', v_invoice_id,
    'released_cents', p_amount_cents
  );
end;
$$;

grant execute on function public.release_project_retainage_atomic(
  uuid, uuid, uuid, integer, text, uuid, text, text, date, date
) to service_role;

create or replace function public.apply_invoice_late_fee_atomic(
  p_org_id uuid,
  p_invoice_id uuid,
  p_rule_id uuid,
  p_amount_cents integer,
  p_days_overdue integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices%rowtype;
  v_application_number integer;
  v_line_id uuid;
begin
  if p_amount_cents <= 0 then
    raise exception 'Late fee amount must be positive';
  end if;

  select *
    into v_invoice
    from public.invoices
    where id = p_invoice_id
      and org_id = p_org_id
    for update;

  if v_invoice.id is null or v_invoice.status not in ('sent', 'partial', 'overdue') then
    raise exception 'Invoice is not eligible for a late fee';
  end if;

  select coalesce(max(application_number), 0) + 1
    into v_application_number
    from public.late_fee_applications
    where invoice_id = p_invoice_id
      and late_fee_rule_id = p_rule_id;

  insert into public.invoice_lines (
    org_id, invoice_id, description, quantity, unit, unit_price_cents, metadata
  )
  values (
    p_org_id,
    p_invoice_id,
    format('Late Fee (%s days overdue)', p_days_overdue),
    1,
    'fee',
    p_amount_cents,
    jsonb_build_object(
      'taxable', false,
      'late_fee_rule_id', p_rule_id,
      'days_overdue', p_days_overdue,
      'system_generated_kind', 'late_fee'
    )
  )
  returning id into v_line_id;

  insert into public.late_fee_applications (
    org_id, invoice_id, late_fee_rule_id, invoice_line_id,
    amount_cents, application_number
  )
  values (
    p_org_id, p_invoice_id, p_rule_id, v_line_id,
    p_amount_cents, v_application_number
  );

  update public.invoices
     set subtotal_cents = coalesce(subtotal_cents, total_cents, 0) + p_amount_cents,
         total_cents = coalesce(total_cents, 0) + p_amount_cents,
         balance_due_cents = coalesce(balance_due_cents, 0) + p_amount_cents,
         status = 'overdue',
         metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'latest_late_fee_applied_at', now()
         )
   where id = p_invoice_id
     and org_id = p_org_id;

  return jsonb_build_object(
    'invoice_id', p_invoice_id,
    'invoice_line_id', v_line_id,
    'application_number', v_application_number,
    'amount_cents', p_amount_cents
  );
end;
$$;

grant execute on function public.apply_invoice_late_fee_atomic(
  uuid, uuid, uuid, integer, integer
) to service_role;
