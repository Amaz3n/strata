-- EP05-06 Commission controls.
--
-- A purchase agreement carries a commission plan: the co-op broker (a percent of
-- the authorized price, or flat) and internal sales-consultant comp. The plan is
-- proposed by sales and approved by a second person before the agreement is
-- signed; "no commissions" is an explicit plan with no lines. Settlement turns
-- the approved plan into obligations exactly once per closing and plan line:
-- brokers and 1099 consultants become pending AP bills (AP still approves the
-- release), W-2 consultants accrue for payroll. A reversed closing clears what
-- was never paid and claws back what was (an open vendor credit, or a payroll
-- deduction), so a commission is never paid twice.
--
-- 1. Books: subtypes and accounts 6100 Sales commissions / 2240 Accrued commissions.
-- 2. sales_commission_plans + sales_commission_plan_lines (the approved terms).
-- 3. sales_commission_obligations (what settlement owes; the exactly-once key).
-- 4. Guards: terms are immutable once proposed, approval is a second person who
--    is not a payee, commission bills cannot be edited outside these functions,
--    a voided agreement voids its plan.
-- 5. Functions: propose (as the member), record payables, unwind, payroll paid.
-- 6. Row security: a consultant never reads another consultant's comp.
-- 7. RBAC: sales.commission_manage, sales.commission_approve.

-- ---------------------------------------------------------------------------
-- 1. Books accounts.
-- ---------------------------------------------------------------------------

alter table public.gl_accounts
  drop constraint if exists gl_accounts_subtype_check;
alter table public.gl_accounts
  add constraint gl_accounts_subtype_check check (subtype in (
    'cash', 'undeposited_funds', 'accounts_receivable', 'retainage_receivable',
    'costs_in_excess', 'work_in_progress', 'prepaid_expenses', 'fixed_assets',
    'accumulated_depreciation', 'other_asset', 'accounts_payable',
    'retainage_payable', 'credit_card', 'payroll_clearing', 'sales_use_tax',
    'customer_deposits', 'billings_in_excess', 'current_debt', 'long_term_debt',
    'other_liability', 'owner_equity', 'owner_contributions',
    'owner_distributions', 'retained_earnings', 'construction_revenue',
    'other_revenue', 'early_pay_discount', 'payment_fee_recovery', 'job_costs',
    'subcontractor_costs', 'material_costs', 'direct_labor', 'equipment_costs',
    'warranty_costs', 'rent', 'insurance', 'software', 'professional_fees',
    'utilities', 'bank_fees', 'interest', 'payroll', 'depreciation', 'other_expense',
    'expected_contract_loss_reserve', 'expected_contract_loss_expense',
    'sales_commissions', 'accrued_commissions'
  ));

-- A commission is a selling expense of the period, never home inventory and never
-- construction cost. Existing Books orgs get the accounts; new orgs get them from
-- CONSTRUCTION_CHART_TEMPLATE (lib/services/books/chart-of-accounts.ts).
insert into public.gl_accounts (org_id, code, name, account_type, subtype, normal_balance, cash_flow_category, is_system, active)
select s.org_id, a.code, a.name, a.account_type, a.subtype, a.normal_balance, 'operating', true, true
from public.books_settings s
cross join (values
  ('6100', 'Sales commissions', 'expense', 'sales_commissions', 'debit'),
  ('2240', 'Accrued commissions', 'liability', 'accrued_commissions', 'credit')
) a(code, name, account_type, subtype, normal_balance)
on conflict (org_id, code) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Plans and their lines.
-- ---------------------------------------------------------------------------

create table if not exists public.sales_commission_plans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  contract_id uuid not null references public.contracts(id) on delete cascade,
  revision integer not null,
  status text not null default 'proposed',
  coop_broker text not null,
  line_count smallint not null,
  proposed_by uuid not null references public.app_users(id),
  proposed_at timestamptz not null default now(),
  approved_by uuid references public.app_users(id),
  approved_at timestamptz,
  approval_note text,
  ended_at timestamptz,
  end_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_commission_plans_revision_check check (revision > 0),
  constraint sales_commission_plans_status_check check (status in ('proposed', 'approved', 'superseded', 'void')),
  constraint sales_commission_plans_coop_check check (coop_broker in ('none', 'broker')),
  constraint sales_commission_plans_line_count_check check (line_count between 0 and 10),
  constraint sales_commission_plans_approved_check
    check (status <> 'approved' or (approved_by is not null and approved_at is not null)),
  constraint sales_commission_plans_note_check check (approval_note is null or length(approval_note) <= 1000),
  constraint sales_commission_plans_ended_check
    check ((status in ('superseded', 'void')) = (ended_at is not null)
       and (ended_at is null or length(btrim(coalesce(end_reason, ''))) between 8 and 1000)),
  constraint sales_commission_plans_contract_revision_key unique (contract_id, revision)
);

-- One live plan per agreement; a revision supersedes the previous one.
create unique index if not exists sales_commission_plans_live_key
  on public.sales_commission_plans (contract_id) where status in ('proposed', 'approved');
create index if not exists sales_commission_plans_org_project_idx on public.sales_commission_plans (org_id, project_id);
create index if not exists sales_commission_plans_org_contract_idx on public.sales_commission_plans (org_id, contract_id);
create index if not exists sales_commission_plans_org_waiting_idx
  on public.sales_commission_plans (org_id, proposed_at) where status = 'proposed';
create index if not exists sales_commission_plans_project_idx on public.sales_commission_plans (project_id);
create index if not exists sales_commission_plans_proposed_by_idx on public.sales_commission_plans (proposed_by);
create index if not exists sales_commission_plans_approved_by_idx
  on public.sales_commission_plans (approved_by) where approved_by is not null;

comment on table public.sales_commission_plans is
  'Commission terms of one purchase agreement. proposed -> approved by a second person holding sales.commission_approve who is neither the proposer nor a payee; a revision supersedes; voiding the agreement voids it. A plan with no lines is the explicit "no commissions" declaration. Written through propose_sales_commission_plan (lib/services/sales-commissions.ts).';

create table if not exists public.sales_commission_plan_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  plan_id uuid not null references public.sales_commission_plans(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  line_no smallint not null,
  kind text not null,
  payout_channel text not null,
  payee_company_id uuid references public.companies(id),
  payee_user_id uuid references public.app_users(id),
  agent_name text,
  basis text not null,
  rate_bps integer,
  flat_cents bigint,
  created_at timestamptz not null default now(),
  constraint sales_commission_plan_lines_line_no_check check (line_no between 1 and 10),
  constraint sales_commission_plan_lines_kind_check check (kind in ('coop_broker', 'sales_consultant')),
  constraint sales_commission_plan_lines_channel_check check (payout_channel in ('accounts_payable', 'payroll')),
  constraint sales_commission_plan_lines_basis_check check (basis in ('percent_of_authorized_price', 'flat')),
  -- Rates are basis points: 2.5% is 250. Fifteen percent is a typo, not a commission.
  constraint sales_commission_plan_lines_amount_check check (
    (basis = 'percent_of_authorized_price' and rate_bps between 1 and 1500 and flat_cents is null)
    or (basis = 'flat' and flat_cents > 0 and rate_bps is null)
  ),
  -- A broker is paid as a vendor; a consultant is a member (paid through payroll,
  -- or as a 1099 vendor through their own company), so a payee can be recognized
  -- when it comes to approving.
  constraint sales_commission_plan_lines_payee_check check (
    (kind = 'coop_broker' and payout_channel = 'accounts_payable' and payee_company_id is not null and payee_user_id is null)
    or (kind = 'sales_consultant' and payee_user_id is not null
        and ((payout_channel = 'accounts_payable') = (payee_company_id is not null)))
  ),
  constraint sales_commission_plan_lines_agent_check check (agent_name is null or length(btrim(agent_name)) between 1 and 200),
  constraint sales_commission_plan_lines_plan_line_key unique (plan_id, line_no)
);

create index if not exists sales_commission_plan_lines_org_project_idx on public.sales_commission_plan_lines (org_id, project_id);
create index if not exists sales_commission_plan_lines_project_idx on public.sales_commission_plan_lines (project_id);
create index if not exists sales_commission_plan_lines_payee_company_idx
  on public.sales_commission_plan_lines (payee_company_id) where payee_company_id is not null;
create index if not exists sales_commission_plan_lines_payee_user_idx
  on public.sales_commission_plan_lines (payee_user_id) where payee_user_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Obligations: what a settlement owes.
-- ---------------------------------------------------------------------------

create table if not exists public.sales_commission_obligations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete restrict,
  closing_id uuid not null references public.closings(id) on delete restrict,
  contract_id uuid not null references public.contracts(id) on delete restrict,
  plan_id uuid not null references public.sales_commission_plans(id) on delete restrict,
  plan_line_id uuid not null references public.sales_commission_plan_lines(id) on delete restrict,
  line_no smallint not null,
  kind text not null,
  payout_channel text not null,
  payee_company_id uuid references public.companies(id),
  payee_user_id uuid references public.app_users(id),
  basis_price_cents bigint not null,
  rate_bps integer,
  flat_cents bigint,
  amount_cents bigint not null,
  evidence_digest text not null,
  status text not null default 'open',
  vendor_bill_id uuid references public.vendor_bills(id) on delete restrict,
  reversal_credit_bill_id uuid references public.vendor_bills(id) on delete restrict,
  adjusts_obligation_id uuid references public.sales_commission_obligations(id) on delete restrict,
  payroll_reference text,
  paid_on date,
  ended_at timestamptz,
  end_reason text,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_commission_obligations_kind_check check (kind in ('coop_broker', 'sales_consultant')),
  constraint sales_commission_obligations_channel_check check (payout_channel in ('accounts_payable', 'payroll')),
  constraint sales_commission_obligations_status_check check (status in ('open', 'cleared', 'reversed')),
  constraint sales_commission_obligations_basis_check check (basis_price_cents >= 0),
  constraint sales_commission_obligations_digest_check check (evidence_digest ~ '^[a-f0-9]{64}$'),
  -- A payroll clawback is a negative row adjusting the paid one; everything else is owed.
  constraint sales_commission_obligations_amount_check check (
    (adjusts_obligation_id is null and amount_cents > 0)
    or (adjusts_obligation_id is not null and amount_cents < 0 and payout_channel = 'payroll')
  ),
  constraint sales_commission_obligations_bill_check check (
    (payout_channel = 'accounts_payable') = (vendor_bill_id is not null)
  ),
  constraint sales_commission_obligations_reversal_check check (
    reversal_credit_bill_id is null or (payout_channel = 'accounts_payable' and status = 'reversed')
  ),
  constraint sales_commission_obligations_payroll_check check (
    (payroll_reference is null) = (paid_on is null)
    and (payroll_reference is null or (payout_channel = 'payroll' and length(btrim(payroll_reference)) between 1 and 200))
  ),
  constraint sales_commission_obligations_ended_check check (
    (status = 'open') = (ended_at is null)
    and (ended_at is null or length(btrim(coalesce(end_reason, ''))) between 8 and 2000)
  )
);

-- The exactly-once key: one obligation per closing and plan line. A resale is a new
-- closing and owes again; a retried or concurrent settlement finds the first row.
create unique index if not exists sales_commission_obligations_closing_line_key
  on public.sales_commission_obligations (closing_id, plan_line_id) where adjusts_obligation_id is null;
create unique index if not exists sales_commission_obligations_bill_key
  on public.sales_commission_obligations (vendor_bill_id) where vendor_bill_id is not null;
create unique index if not exists sales_commission_obligations_credit_key
  on public.sales_commission_obligations (reversal_credit_bill_id) where reversal_credit_bill_id is not null;
create unique index if not exists sales_commission_obligations_adjusts_key
  on public.sales_commission_obligations (adjusts_obligation_id) where adjusts_obligation_id is not null;
create index if not exists sales_commission_obligations_org_project_idx on public.sales_commission_obligations (org_id, project_id);
create index if not exists sales_commission_obligations_org_closing_idx on public.sales_commission_obligations (org_id, closing_id);
create index if not exists sales_commission_obligations_org_payroll_idx
  on public.sales_commission_obligations (org_id, created_at) where payout_channel = 'payroll' and paid_on is null and status = 'open';
create index if not exists sales_commission_obligations_project_idx on public.sales_commission_obligations (project_id);
create index if not exists sales_commission_obligations_contract_idx on public.sales_commission_obligations (contract_id);
create index if not exists sales_commission_obligations_plan_idx on public.sales_commission_obligations (plan_id);
create index if not exists sales_commission_obligations_plan_line_idx on public.sales_commission_obligations (plan_line_id);
create index if not exists sales_commission_obligations_payee_company_idx
  on public.sales_commission_obligations (payee_company_id) where payee_company_id is not null;
create index if not exists sales_commission_obligations_payee_user_idx
  on public.sales_commission_obligations (payee_user_id) where payee_user_id is not null;
create index if not exists sales_commission_obligations_created_by_idx
  on public.sales_commission_obligations (created_by) where created_by is not null;

comment on table public.sales_commission_obligations is
  'Commission owed by one recorded closing for one approved plan line, created once by record_sales_commission_payables. open -> cleared (removed before any payment) | reversed (clawed back after payment: an open vendor credit, or a negative payroll adjustment row).';

drop trigger if exists sales_commission_plans_set_updated_at on public.sales_commission_plans;
create trigger sales_commission_plans_set_updated_at
  before update on public.sales_commission_plans
  for each row execute function public.tg_set_updated_at();

drop trigger if exists sales_commission_obligations_set_updated_at on public.sales_commission_obligations;
create trigger sales_commission_obligations_set_updated_at
  before update on public.sales_commission_obligations
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Guards.
-- ---------------------------------------------------------------------------

-- Terms are frozen once proposed. Approval is a second person: never the proposer
-- and never a payee. A plan cannot end once settlement recorded what it owes, nor
-- after the home has closed on it -- that is the closing reversal's job.
create or replace function public.guard_sales_commission_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member boolean := (select auth.role()) is distinct from 'service_role';
  v_lines integer;
begin
  if row(new.org_id, new.project_id, new.contract_id, new.revision, new.coop_broker, new.line_count, new.proposed_by, new.proposed_at)
     is distinct from row(old.org_id, old.project_id, old.contract_id, old.revision, old.coop_broker, old.line_count, old.proposed_by, old.proposed_at) then
    raise exception 'Commission terms cannot be edited; revise the plan instead' using errcode = '42501';
  end if;
  if old.status in ('superseded', 'void') then
    raise exception 'This commission plan is final' using errcode = '42501';
  end if;
  if new.status = old.status then
    if row(new.approved_by, new.approved_at, new.approval_note, new.ended_at, new.end_reason)
       is distinct from row(old.approved_by, old.approved_at, old.approval_note, old.ended_at, old.end_reason) then
      raise exception 'A commission decision cannot be edited' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.status = 'approved' then
    if old.status <> 'proposed' then
      raise exception 'Only proposed commission terms can be approved' using errcode = '42501';
    end if;
    if v_member then
      if new.approved_by is distinct from (select auth.uid()) then
        raise exception 'An approval is recorded in the approver''s own name' using errcode = '42501';
      end if;
      if old.line_count > 0 and not public.has_org_permission(new.org_id, 'sales.commission_approve') then
        raise exception 'Approving commission terms needs sales.commission_approve' using errcode = '42501';
      end if;
      if old.line_count = 0
         and not (public.has_org_permission(new.org_id, 'sales.commission_manage')
                  or public.has_org_permission(new.org_id, 'sales.commission_approve')) then
        raise exception 'Declaring no commissions needs sales.commission_manage' using errcode = '42501';
      end if;
    end if;
    if old.line_count > 0 then
      if new.approved_by = old.proposed_by then
        raise exception 'The person who proposed commission terms cannot approve them' using errcode = '42501';
      end if;
      if exists (
        select 1 from public.sales_commission_plan_lines l
        where l.plan_id = old.id and l.payee_user_id = new.approved_by
      ) then
        raise exception 'A payee cannot approve their own commission' using errcode = '42501';
      end if;
    end if;
    select count(*) into v_lines from public.sales_commission_plan_lines where plan_id = old.id;
    if v_lines <> old.line_count then
      raise exception 'The commission plan is incomplete; propose it again' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.status in ('superseded', 'void') then
    if v_member
       and coalesce(current_setting('arc.commission_plan_void', true), '') is distinct from old.contract_id::text
       and not (public.has_org_permission(new.org_id, 'sales.commission_manage')
                or public.has_org_permission(new.org_id, 'sales.commission_approve')) then
      raise exception 'Revising commission terms needs sales.commission_manage' using errcode = '42501';
    end if;
    if exists (select 1 from public.sales_commission_obligations o where o.plan_id = old.id) then
      raise exception 'Commissions were already recorded for this agreement; reverse the closing to adjust them' using errcode = '42501';
    end if;
    if exists (
      select 1 from public.closings c
      where c.org_id = old.org_id and c.project_id = old.project_id and c.status = 'closed'
        and c.settlement->>'contractId' = old.contract_id::text
    ) then
      raise exception 'This home has closed; adjust commissions through the closing reversal' using errcode = '42501';
    end if;
    new.ended_at := coalesce(new.ended_at, now());
    return new;
  end if;

  raise exception 'A commission plan cannot move from % to %', old.status, new.status using errcode = '42501';
end;
$$;

revoke all on function public.guard_sales_commission_plan() from public, anon, authenticated;

drop trigger if exists sales_commission_plans_guard on public.sales_commission_plans;
create trigger sales_commission_plans_guard
  before update on public.sales_commission_plans
  for each row execute function public.guard_sales_commission_plan();

-- Lines exist only under a proposed plan; nothing edits one afterwards.
create or replace function public.guard_sales_commission_plan_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan public.sales_commission_plans%rowtype;
begin
  if tg_op = 'UPDATE' then
    raise exception 'Commission plan lines cannot be edited; revise the plan instead' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    if exists (select 1 from public.sales_commission_plans p where p.id = old.plan_id and p.status <> 'proposed') then
      raise exception 'Commission plan lines cannot be removed; revise the plan instead' using errcode = '42501';
    end if;
    return old;
  end if;
  select * into v_plan from public.sales_commission_plans where id = new.plan_id;
  if v_plan.id is null or v_plan.org_id <> new.org_id then
    raise exception 'Commission plan not found' using errcode = '23503';
  end if;
  if v_plan.status <> 'proposed' then
    raise exception 'Lines are added only while the commission plan is proposed' using errcode = '42501';
  end if;
  if new.line_no > v_plan.line_count then
    raise exception 'The commission plan declares % lines', v_plan.line_count using errcode = '23514';
  end if;
  if new.kind = 'coop_broker' and v_plan.coop_broker <> 'broker' then
    raise exception 'The plan declares no co-op broker' using errcode = '23514';
  end if;
  if new.payee_company_id is not null and not exists (
    select 1 from public.companies c where c.id = new.payee_company_id and c.org_id = new.org_id and c.archived_at is null
  ) then
    raise exception 'Commission payee company not found' using errcode = '23503';
  end if;
  if new.payee_user_id is not null and not exists (
    select 1 from public.memberships m where m.org_id = new.org_id and m.user_id = new.payee_user_id and m.status = 'active'
  ) then
    raise exception 'A sales consultant payee must be an active member' using errcode = '23503';
  end if;
  new.project_id := v_plan.project_id;
  return new;
end;
$$;

revoke all on function public.guard_sales_commission_plan_line() from public, anon, authenticated;

drop trigger if exists sales_commission_plan_lines_guard on public.sales_commission_plan_lines;
create trigger sales_commission_plan_lines_guard
  before insert or update or delete on public.sales_commission_plan_lines
  for each row execute function public.guard_sales_commission_plan_line();

-- What a closing owes never changes; it is cleared or reversed, once, with a reason.
create or replace function public.guard_sales_commission_obligation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Commission obligations are a record; clear or reverse them instead' using errcode = '42501';
  end if;
  if row(new.org_id, new.project_id, new.closing_id, new.contract_id, new.plan_id, new.plan_line_id, new.line_no, new.kind,
         new.payout_channel, new.payee_company_id, new.payee_user_id, new.basis_price_cents, new.rate_bps, new.flat_cents,
         new.amount_cents, new.evidence_digest, new.vendor_bill_id, new.adjusts_obligation_id, new.created_by, new.created_at)
     is distinct from
     row(old.org_id, old.project_id, old.closing_id, old.contract_id, old.plan_id, old.plan_line_id, old.line_no, old.kind,
         old.payout_channel, old.payee_company_id, old.payee_user_id, old.basis_price_cents, old.rate_bps, old.flat_cents,
         old.amount_cents, old.evidence_digest, old.vendor_bill_id, old.adjusts_obligation_id, old.created_by, old.created_at) then
    raise exception 'A recorded commission cannot be edited' using errcode = '42501';
  end if;
  if old.status <> 'open' and row(new.status, new.ended_at, new.end_reason, new.reversal_credit_bill_id)
     is distinct from row(old.status, old.ended_at, old.end_reason, old.reversal_credit_bill_id) then
    raise exception 'This commission is already %', old.status using errcode = '42501';
  end if;
  if old.paid_on is not null and row(new.paid_on, new.payroll_reference) is distinct from row(old.paid_on, old.payroll_reference) then
    raise exception 'This commission is already marked paid' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_sales_commission_obligation() from public, anon, authenticated;

drop trigger if exists sales_commission_obligations_guard on public.sales_commission_obligations;
create trigger sales_commission_obligations_guard
  before update or delete on public.sales_commission_obligations
  for each row execute function public.guard_sales_commission_obligation();

-- A commission bill is derived evidence. AP approves, rejects with a reason or pays
-- it; its amount, payee, home and lines move only through the functions below.
create or replace function public.guard_sales_commission_bill()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('arc.commission_write', true), '') = 'on' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if old.metadata ? 'sales_commission_obligation_id' then
      raise exception 'A commission payable cannot be deleted; reverse the closing instead' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.metadata ? 'sales_commission_obligation_id'
     and (row(new.total_cents, new.company_id, new.project_id, new.bill_number, new.currency, new.retainage_cents, new.bill_date)
          is distinct from row(old.total_cents, old.company_id, old.project_id, old.bill_number, old.currency, old.retainage_cents, old.bill_date)
          or new.metadata->>'sales_commission_obligation_id' is distinct from old.metadata->>'sales_commission_obligation_id'
          or new.metadata->>'source' is distinct from old.metadata->>'source') then
    raise exception 'A commission payable''s amount, payee and home come from the approved terms' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_sales_commission_bill() from public, anon, authenticated;

drop trigger if exists vendor_bills_sales_commission_guard on public.vendor_bills;
create trigger vendor_bills_sales_commission_guard
  before update or delete on public.vendor_bills
  for each row execute function public.guard_sales_commission_bill();

create or replace function public.guard_sales_commission_bill_line()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('arc.commission_write', true), '') = 'on' then
    return coalesce(new, old);
  end if;
  if exists (
    select 1 from public.vendor_bills b
    where b.id = coalesce(new.bill_id, old.bill_id) and b.metadata ? 'sales_commission_obligation_id'
  ) then
    raise exception 'A commission payable''s lines come from the approved terms' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.guard_sales_commission_bill_line() from public, anon, authenticated;

drop trigger if exists bill_lines_sales_commission_guard on public.bill_lines;
create trigger bill_lines_sales_commission_guard
  before insert or update or delete on public.bill_lines
  for each row execute function public.guard_sales_commission_bill_line();

-- Voiding an agreement voids its terms. On a closed home the plan refuses to end,
-- so the agreement cannot be voided around the closing reversal.
create or replace function public.void_sales_commission_plan_with_agreement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('arc.commission_plan_void', new.id::text, true);
  update public.sales_commission_plans
  set status = 'void', ended_at = now(), end_reason = 'The purchase agreement was voided'
  where org_id = new.org_id and contract_id = new.id and status in ('proposed', 'approved');
  perform set_config('arc.commission_plan_void', '', true);
  return new;
end;
$$;

revoke all on function public.void_sales_commission_plan_with_agreement() from public, anon, authenticated;

drop trigger if exists contracts_void_sales_commission_plan on public.contracts;
create trigger contracts_void_sales_commission_plan
  after update of status on public.contracts
  for each row
  when (new.status = 'void' and old.status is distinct from 'void' and new.contract_type = 'purchase_agreement')
  execute function public.void_sales_commission_plan_with_agreement();

-- ---------------------------------------------------------------------------
-- 5. Functions.
-- ---------------------------------------------------------------------------

-- Runs as the member, under row security: proposing needs sales.commission_manage.
-- Supersedes the live plan (refused once the home closed or commissions exist) and
-- writes the next revision with its lines in one transaction. A plan with no lines
-- is the explicit "no commissions" declaration and stands at once.
create or replace function public.propose_sales_commission_plan(
  p_org_id uuid,
  p_contract_id uuid,
  p_coop_broker text,
  p_lines jsonb,
  p_reason text default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_contract record;
  v_live public.sales_commission_plans%rowtype;
  v_plan_id uuid;
  v_revision integer;
  v_count integer := coalesce(jsonb_array_length(p_lines), 0);
  v_line jsonb;
  v_index integer := 0;
begin
  if (select auth.uid()) is null then
    raise exception 'Sign in to propose commission terms' using errcode = '42501';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'Commission lines must be a list' using errcode = '22023';
  end if;
  if p_coop_broker = 'broker' and not exists (
    select 1 from jsonb_array_elements(p_lines) l where l->>'kind' = 'coop_broker'
  ) then
    raise exception 'Name the co-op broker''s terms, or declare no co-op broker' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sales_commission_plan:' || p_contract_id::text, 0));

  select id, project_id, status into v_contract
  from public.contracts
  where org_id = p_org_id and id = p_contract_id and contract_type = 'purchase_agreement';
  if v_contract.id is null then
    raise exception 'Purchase agreement not found' using errcode = '23503';
  end if;
  if v_contract.status not in ('draft', 'active') then
    raise exception 'Commission terms are set only on an open purchase agreement' using errcode = '42501';
  end if;

  select * into v_live from public.sales_commission_plans
  where org_id = p_org_id and contract_id = p_contract_id and status in ('proposed', 'approved');
  if v_live.id is not null then
    update public.sales_commission_plans
    set status = 'superseded', end_reason = coalesce(nullif(btrim(p_reason), ''), 'Commission terms revised')
    where id = v_live.id;
  end if;

  select coalesce(max(revision), 0) + 1 into v_revision
  from public.sales_commission_plans where org_id = p_org_id and contract_id = p_contract_id;

  insert into public.sales_commission_plans (org_id, project_id, contract_id, revision, status, coop_broker, line_count, proposed_by)
  values (p_org_id, v_contract.project_id, p_contract_id, v_revision, 'proposed', p_coop_broker, v_count, (select auth.uid()))
  returning id into v_plan_id;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_index := v_index + 1;
    insert into public.sales_commission_plan_lines (
      org_id, plan_id, project_id, line_no, kind, payout_channel, payee_company_id, payee_user_id,
      agent_name, basis, rate_bps, flat_cents
    ) values (
      p_org_id, v_plan_id, v_contract.project_id, v_index, v_line->>'kind', v_line->>'payout_channel',
      nullif(v_line->>'payee_company_id', '')::uuid, nullif(v_line->>'payee_user_id', '')::uuid,
      nullif(btrim(v_line->>'agent_name'), ''), v_line->>'basis',
      nullif(v_line->>'rate_bps', '')::integer, nullif(v_line->>'flat_cents', '')::bigint
    );
  end loop;

  if v_count = 0 then
    update public.sales_commission_plans
    set status = 'approved', approved_by = (select auth.uid()), approved_at = now(), approval_note = 'No commissions on this sale'
    where id = v_plan_id;
  end if;
  return v_plan_id;
end;
$$;

revoke all on function public.propose_sales_commission_plan(uuid, uuid, text, jsonb, text) from public, anon;
grant execute on function public.propose_sales_commission_plan(uuid, uuid, text, jsonb, text) to authenticated, service_role;

-- The basis is the closing's frozen settlement: the authorized price (agreement
-- plus buyer-signed change orders), never the closing-table adjustments.
create or replace function public.sales_commission_basis_cents(p_settlement jsonb)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select (p_settlement #>> '{components,agreementTotalCents}')::bigint
       + (p_settlement #>> '{components,approvedChangeOrdersCents}')::bigint
$$;

revoke all on function public.sales_commission_basis_cents(jsonb) from public, anon, authenticated;
grant execute on function public.sales_commission_basis_cents(jsonb) to service_role;

-- Settlement's commission write. The caller derives each row in
-- lib/financials/sales-commissions.ts; this re-derives the amount from the stored
-- settlement and the approved terms and refuses any disagreement. Each row and its
-- pending AP bill are written together, once; a replay returns what exists and
-- refuses an amount or evidence that changed.
create or replace function public.record_sales_commission_payables(
  p_org_id uuid,
  p_closing_id uuid,
  p_actor_id uuid,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_closing public.closings%rowtype;
  v_contract_id uuid;
  v_plan public.sales_commission_plans%rowtype;
  v_basis bigint;
  v_line public.sales_commission_plan_lines%rowtype;
  v_row jsonb;
  v_amount bigint;
  v_existing public.sales_commission_obligations%rowtype;
  v_obligation_id uuid;
  v_bill_id uuid;
  v_closing_tag text;
begin
  select * into v_closing from public.closings where org_id = p_org_id and id = p_closing_id for update;
  if v_closing.id is null then raise exception 'Closing not found' using errcode = '23503'; end if;
  if v_closing.status <> 'closed' or v_closing.actual_date is null then
    raise exception 'Commissions are recorded only for a recorded closing' using errcode = '42501';
  end if;
  v_contract_id := (v_closing.settlement->>'contractId')::uuid;
  v_basis := public.sales_commission_basis_cents(v_closing.settlement);
  if v_contract_id is null or v_basis is null or v_basis < 0 then
    raise exception 'The recorded settlement has no authorized price' using errcode = '23514';
  end if;

  select * into v_plan from public.sales_commission_plans
  where org_id = p_org_id and contract_id = v_contract_id and status = 'approved';
  if v_plan.id is null then
    raise exception 'The agreement''s commission terms are not approved' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) <> v_plan.line_count
     or (select count(distinct value->>'plan_line_id') from jsonb_array_elements(p_rows)) <> v_plan.line_count then
    raise exception 'Commission rows do not match the approved terms' using errcode = '23514';
  end if;

  v_closing_tag := upper(substr(replace(p_closing_id::text, '-', ''), 1, 8));
  perform set_config('arc.commission_write', 'on', true);
  for v_row in select value from jsonb_array_elements(p_rows) loop
    select * into v_line from public.sales_commission_plan_lines
    where plan_id = v_plan.id and id = (v_row->>'plan_line_id')::uuid;
    if v_line.id is null then
      raise exception 'Commission rows do not match the approved terms' using errcode = '23514';
    end if;
    v_amount := case when v_line.basis = 'flat' then v_line.flat_cents
                     else (v_basis * v_line.rate_bps + 5000) / 10000 end;
    if (v_row->>'basis_price_cents')::bigint is distinct from v_basis
       or (v_row->>'amount_cents')::bigint is distinct from v_amount then
      raise exception 'Commission line % does not reconcile with the settlement', v_line.line_no using errcode = '23514';
    end if;
    if v_amount <= 0 then
      raise exception 'Commission line % has no amount', v_line.line_no using errcode = '23514';
    end if;

    select * into v_existing from public.sales_commission_obligations
    where closing_id = p_closing_id and plan_line_id = v_line.id and adjusts_obligation_id is null;
    if v_existing.id is not null then
      if v_existing.amount_cents <> v_amount or v_existing.evidence_digest <> v_row->>'evidence_digest' then
        raise exception 'Commission line % was recorded differently; reconcile it before retrying', v_line.line_no using errcode = '23514';
      end if;
      continue;
    end if;

    v_obligation_id := gen_random_uuid();
    v_bill_id := null;
    if v_line.payout_channel = 'accounts_payable' then
      insert into public.vendor_bills (
        org_id, project_id, company_id, bill_number, status, bill_date, due_date, total_cents, currency, metadata
      ) values (
        p_org_id, v_closing.project_id, v_line.payee_company_id, 'COMM-' || v_closing_tag || '-' || v_line.line_no,
        'pending', v_closing.actual_date, v_closing.actual_date, v_amount, 'usd',
        jsonb_build_object(
          'source', 'sales_commission',
          'sales_commission_obligation_id', v_obligation_id,
          'closing_id', p_closing_id,
          'contract_id', v_contract_id,
          'creation_state', 'ready',
          'description', case when v_line.kind = 'coop_broker' then 'Co-op broker commission' else 'Sales commission' end
        )
      ) returning id into v_bill_id;
      insert into public.bill_lines (org_id, bill_id, project_id, description, quantity, unit, unit_cost_cents, sort_order, metadata)
      values (
        p_org_id, v_bill_id, v_closing.project_id,
        case when v_line.kind = 'coop_broker'
             then 'Co-op broker commission' || coalesce(' — ' || v_line.agent_name, '')
             else 'Sales commission' end,
        1, 'LS', v_amount, 0,
        jsonb_build_object('source', 'sales_commission', 'sales_commission_obligation_id', v_obligation_id)
      );
    end if;

    insert into public.sales_commission_obligations (
      id, org_id, project_id, closing_id, contract_id, plan_id, plan_line_id, line_no, kind, payout_channel,
      payee_company_id, payee_user_id, basis_price_cents, rate_bps, flat_cents, amount_cents, evidence_digest,
      vendor_bill_id, created_by
    ) values (
      v_obligation_id, p_org_id, v_closing.project_id, p_closing_id, v_contract_id, v_plan.id, v_line.id, v_line.line_no,
      v_line.kind, v_line.payout_channel, v_line.payee_company_id, v_line.payee_user_id, v_basis, v_line.rate_bps,
      v_line.flat_cents, v_amount, v_row->>'evidence_digest', v_bill_id, p_actor_id
    );
  end loop;
  perform set_config('arc.commission_write', '', true);

  return coalesce((
    select jsonb_agg(to_jsonb(o) order by o.line_no)
    from public.sales_commission_obligations o
    where o.org_id = p_org_id and o.closing_id = p_closing_id and o.adjusts_obligation_id is null
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.record_sales_commission_payables(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_sales_commission_payables(uuid, uuid, uuid, jsonb) to service_role;

-- A reversed closing takes its commissions back, once each:
--   AP, nothing paid   -> the bill is rejected with the reason; the obligation is cleared.
--   AP, paid in part   -> one vendor credit for the whole bill closes the unpaid rest
--   or in full            and stays open for what was paid, netting the payee's next
--                         payment; the obligation is reversed.
--   payroll, not paid  -> cleared (the caller reverses the accrual journal).
--   payroll, paid      -> a negative adjustment row for the next payroll; reversed.
-- Refused while the bill sits in a payment run: the run would pay it anyway.
create or replace function public.unwind_sales_commission(
  p_org_id uuid,
  p_obligation_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_date date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_obligation public.sales_commission_obligations%rowtype;
  v_bill public.vendor_bills%rowtype;
  v_run text;
  v_credit_id uuid;
  v_adjustment_id uuid;
  v_open bigint;
  v_reason text := 'Closing reversed: ' || btrim(coalesce(p_reason, ''));
begin
  if length(btrim(coalesce(p_reason, ''))) < 8 or p_date is null then
    raise exception 'Say why the commission is unwound, and when' using errcode = '22023';
  end if;
  select * into v_obligation from public.sales_commission_obligations
  where org_id = p_org_id and id = p_obligation_id for update;
  if v_obligation.id is null then raise exception 'Commission not found' using errcode = '23503'; end if;
  if v_obligation.adjusts_obligation_id is not null then
    raise exception 'A clawback adjustment is settled through payroll' using errcode = '42501';
  end if;
  if v_obligation.status <> 'open' then
    return jsonb_build_object('action', 'none', 'status', v_obligation.status);
  end if;

  if v_obligation.payout_channel = 'payroll' then
    if v_obligation.paid_on is null then
      update public.sales_commission_obligations
      set status = 'cleared', ended_at = now(), end_reason = v_reason where id = v_obligation.id;
      return jsonb_build_object('action', 'cleared', 'payout_channel', 'payroll');
    end if;
    insert into public.sales_commission_obligations (
      org_id, project_id, closing_id, contract_id, plan_id, plan_line_id, line_no, kind, payout_channel,
      payee_company_id, payee_user_id, basis_price_cents, rate_bps, flat_cents, amount_cents, evidence_digest,
      adjusts_obligation_id, created_by
    ) values (
      v_obligation.org_id, v_obligation.project_id, v_obligation.closing_id, v_obligation.contract_id, v_obligation.plan_id,
      v_obligation.plan_line_id, v_obligation.line_no, v_obligation.kind, 'payroll', null, v_obligation.payee_user_id,
      v_obligation.basis_price_cents, v_obligation.rate_bps, v_obligation.flat_cents, -v_obligation.amount_cents,
      v_obligation.evidence_digest, v_obligation.id, p_actor_id
    ) returning id into v_adjustment_id;
    update public.sales_commission_obligations
    set status = 'reversed', ended_at = now(), end_reason = v_reason where id = v_obligation.id;
    return jsonb_build_object('action', 'reversed', 'payout_channel', 'payroll', 'adjustment_id', v_adjustment_id);
  end if;

  select * into v_bill from public.vendor_bills
  where org_id = p_org_id and id = v_obligation.vendor_bill_id for update;
  select r.id::text into v_run
  from public.payment_run_items item
  join public.payment_runs r on r.id = item.run_id and r.org_id = item.org_id
  where item.org_id = p_org_id and item.bill_id = v_bill.id
    and item.status in ('draft', 'pending_approval', 'approved', 'processing', 'partially_paid')
  limit 1;
  if v_run is not null then
    raise exception 'Commission payable % is in payment run %; remove it from the run first', v_bill.bill_number, v_run using errcode = '42501';
  end if;

  perform set_config('arc.commission_write', 'on', true);
  if coalesce(v_bill.paid_cents, 0) = 0 and v_bill.status in ('pending', 'approved') then
    update public.vendor_bills
    set status = 'rejected', rejected_at = now(), rejected_by = p_actor_id, rejection_reason = left(v_reason, 2000)
    where id = v_bill.id;
    update public.sales_commission_obligations
    set status = 'cleared', ended_at = now(), end_reason = v_reason where id = v_obligation.id;
    perform set_config('arc.commission_write', '', true);
    return jsonb_build_object('action', 'cleared', 'payout_channel', 'accounts_payable', 'bill_id', v_bill.id);
  end if;
  if v_bill.status not in ('partial', 'paid') then
    raise exception 'Commission payable % is %; reconcile it before reversing', v_bill.bill_number, v_bill.status using errcode = '42501';
  end if;

  insert into public.vendor_bills (
    org_id, project_id, company_id, bill_number, status, bill_date, due_date, total_cents, currency,
    approved_at, approved_by, metadata
  ) values (
    p_org_id, v_bill.project_id, v_bill.company_id, v_bill.bill_number || '-R', 'approved', p_date, p_date,
    -v_bill.total_cents, v_bill.currency, now(), p_actor_id,
    jsonb_build_object(
      'source', 'vendor_credit',
      'sales_commission_obligation_id', v_obligation.id,
      'closing_id', v_obligation.closing_id,
      'description', 'Commission clawback: ' || left(v_reason, 400)
    )
  ) returning id into v_credit_id;
  insert into public.bill_lines (org_id, bill_id, project_id, description, quantity, unit, unit_cost_cents, sort_order, metadata)
  values (
    p_org_id, v_credit_id, v_bill.project_id, 'Commission clawback', 1, 'LS', -v_bill.total_cents, 0,
    jsonb_build_object('source', 'vendor_credit', 'sales_commission_obligation_id', v_obligation.id)
  );
  v_open := greatest(coalesce(v_bill.total_cents, 0) - coalesce(v_bill.retainage_cents, 0) - coalesce(v_bill.paid_cents, 0), 0);
  if v_open > 0 then
    perform public.apply_vendor_credit_atomic(
      p_org_id, v_credit_id, v_bill.id, p_actor_id, v_open, 'commission-reversal:' || v_obligation.id::text,
      jsonb_build_object('source', 'sales_commission_reversal', 'obligation_id', v_obligation.id, 'recorded_by', p_actor_id)
    );
  end if;
  update public.sales_commission_obligations
  set status = 'reversed', ended_at = now(), end_reason = v_reason, reversal_credit_bill_id = v_credit_id
  where id = v_obligation.id;
  perform set_config('arc.commission_write', '', true);
  return jsonb_build_object('action', 'reversed', 'payout_channel', 'accounts_payable', 'bill_id', v_bill.id,
    'credit_bill_id', v_credit_id, 'applied_cents', v_open, 'open_credit_cents', v_bill.total_cents - v_open);
end;
$$;

revoke all on function public.unwind_sales_commission(uuid, uuid, uuid, text, date) from public, anon, authenticated;
grant execute on function public.unwind_sales_commission(uuid, uuid, uuid, text, date) to service_role;

-- A payroll-channel commission (or its clawback) is marked paid once, with the
-- payroll run that carried it.
create or replace function public.mark_sales_commission_payroll_paid(
  p_org_id uuid,
  p_obligation_id uuid,
  p_reference text,
  p_paid_on date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_obligation public.sales_commission_obligations%rowtype;
begin
  select * into v_obligation from public.sales_commission_obligations
  where org_id = p_org_id and id = p_obligation_id for update;
  if v_obligation.id is null then raise exception 'Commission not found' using errcode = '23503'; end if;
  if v_obligation.payout_channel <> 'payroll' then
    raise exception 'Only a payroll commission is marked paid here; AP commissions are paid as bills' using errcode = '42501';
  end if;
  if v_obligation.paid_on is not null then
    if v_obligation.payroll_reference = btrim(p_reference) and v_obligation.paid_on = p_paid_on then
      return to_jsonb(v_obligation);
    end if;
    raise exception 'This commission is already marked paid' using errcode = '42501';
  end if;
  if v_obligation.status <> 'open' then
    raise exception 'This commission is %', v_obligation.status using errcode = '42501';
  end if;
  update public.sales_commission_obligations
  set payroll_reference = btrim(p_reference), paid_on = p_paid_on
  where id = v_obligation.id
  returning * into v_obligation;
  return to_jsonb(v_obligation);
end;
$$;

revoke all on function public.mark_sales_commission_payroll_paid(uuid, uuid, text, date) from public, anon, authenticated;
grant execute on function public.mark_sales_commission_payroll_paid(uuid, uuid, text, date) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Row security. Comp is private: a member reads a consultant's terms only with
-- sales.commission_approve or payment.release, or when they are the payee. Co-op
-- broker terms are visible to whoever proposes terms and to AP.
-- ---------------------------------------------------------------------------

alter table public.sales_commission_plans enable row level security;

drop policy if exists sales_commission_plans_read on public.sales_commission_plans;
create policy sales_commission_plans_read on public.sales_commission_plans
  for select
  to authenticated
  using (
    public.has_org_permission(org_id, 'sales.read')
    or public.has_org_permission(org_id, 'sales.commission_manage')
    or public.has_org_permission(org_id, 'sales.commission_approve')
  );

drop policy if exists sales_commission_plans_insert on public.sales_commission_plans;
create policy sales_commission_plans_insert on public.sales_commission_plans
  for insert
  to authenticated
  with check (
    public.has_org_permission(org_id, 'sales.commission_manage')
    and proposed_by = (select auth.uid())
    and status = 'proposed'
    and approved_by is null
  );

drop policy if exists sales_commission_plans_update on public.sales_commission_plans;
create policy sales_commission_plans_update on public.sales_commission_plans
  for update
  to authenticated
  using (public.has_org_permission(org_id, 'sales.commission_manage') or public.has_org_permission(org_id, 'sales.commission_approve'))
  with check (public.has_org_permission(org_id, 'sales.commission_manage') or public.has_org_permission(org_id, 'sales.commission_approve'));

drop policy if exists sales_commission_plans_division_scope on public.sales_commission_plans;
create policy sales_commission_plans_division_scope on public.sales_commission_plans
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or project_id in (select public.member_reachable_project_ids())
  )
  with check (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or project_id in (select public.member_reachable_project_ids())
  );

revoke all on table public.sales_commission_plans from anon, authenticated;
grant select, insert, update on table public.sales_commission_plans to authenticated;
grant all on table public.sales_commission_plans to service_role;

alter table public.sales_commission_plan_lines enable row level security;

drop policy if exists sales_commission_plan_lines_read on public.sales_commission_plan_lines;
create policy sales_commission_plan_lines_read on public.sales_commission_plan_lines
  for select
  to authenticated
  using (
    public.has_org_permission(org_id, 'sales.commission_approve')
    or public.has_org_permission(org_id, 'payment.release')
    or payee_user_id = (select auth.uid())
    or (kind = 'coop_broker' and (
      public.has_org_permission(org_id, 'sales.commission_manage') or public.has_org_permission(org_id, 'bill.read')
    ))
  );

drop policy if exists sales_commission_plan_lines_insert on public.sales_commission_plan_lines;
create policy sales_commission_plan_lines_insert on public.sales_commission_plan_lines
  for insert
  to authenticated
  with check (public.has_org_permission(org_id, 'sales.commission_manage'));

drop policy if exists sales_commission_plan_lines_division_scope on public.sales_commission_plan_lines;
create policy sales_commission_plan_lines_division_scope on public.sales_commission_plan_lines
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or project_id in (select public.member_reachable_project_ids())
  )
  with check (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or project_id in (select public.member_reachable_project_ids())
  );

revoke all on table public.sales_commission_plan_lines from anon, authenticated;
grant select, insert on table public.sales_commission_plan_lines to authenticated;
grant all on table public.sales_commission_plan_lines to service_role;

alter table public.sales_commission_obligations enable row level security;

drop policy if exists sales_commission_obligations_read on public.sales_commission_obligations;
create policy sales_commission_obligations_read on public.sales_commission_obligations
  for select
  to authenticated
  using (
    public.has_org_permission(org_id, 'sales.commission_approve')
    or public.has_org_permission(org_id, 'payment.release')
    or payee_user_id = (select auth.uid())
    or (kind = 'coop_broker' and (
      public.has_org_permission(org_id, 'sales.commission_manage') or public.has_org_permission(org_id, 'bill.read')
    ))
  );

drop policy if exists sales_commission_obligations_division_scope on public.sales_commission_obligations;
create policy sales_commission_obligations_division_scope on public.sales_commission_obligations
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or project_id in (select public.member_reachable_project_ids())
  );

-- Written only by record_sales_commission_payables / unwind_sales_commission.
revoke all on table public.sales_commission_obligations from anon, authenticated;
grant select on table public.sales_commission_obligations to authenticated;
grant all on table public.sales_commission_obligations to service_role;

-- ---------------------------------------------------------------------------
-- 7. RBAC. A sales consultant proposes terms; an owner or admin approves them (a
-- sales manager gets sales.commission_approve as a member override, as with
-- sales.price_approve).
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('sales.commission_manage', 'Propose the commission terms on a purchase agreement'),
  ('sales.commission_approve', 'Approve the commission terms on a purchase agreement')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'sales.commission_manage'
from public.roles r
where r.key in ('org_owner', 'org_admin', 'org_sales_agent')
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'sales.commission_approve'
from public.roles r
where r.key in ('org_owner', 'org_admin')
on conflict (role_id, permission_key) do nothing;
