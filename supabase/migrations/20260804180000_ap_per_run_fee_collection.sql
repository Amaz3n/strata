-- Per-run fee collection, and pricing that reflects the rail.
--
-- Fees are collected once per payment run rather than folded into each vendor
-- debit (which broke bank reconciliation) or accrued for a monthly invoice that
-- was never built. Each vendor payment debits exactly the vendor amount; one
-- additional debit per run collects that run's fees.
--
-- Per RUN, not per payment: each vendor payment is necessarily its own ACH
-- transaction to its own recipient, so a separate fee debit per payment would
-- pay a processor fee to collect a processor fee — on a small bill the
-- collection can cost more than the fee. The run is already the batch boundary
-- and already the unit an approver signs for.

-- A cap is what makes a percentage fee sane on an ACH rail, where cost does not
-- scale with amount. The processor side already had one; the platform side had
-- no way to express a ceiling at all, so a markup expressed in basis points grew
-- without limit on large progress payments.
alter table public.payment_fee_policies
  add column if not exists ap_platform_fee_cap_cents bigint
    check (ap_platform_fee_cap_cents is null or ap_platform_fee_cap_cents >= 0);

comment on column public.payment_fee_policies.ap_platform_fee_cap_cents is
  'Ceiling on the AP platform fee per payment. Null means uncapped, which on an ACH rail is almost always a mistake.';

-- Re-price the platform default. The previous row charged 2% + $1.50 uncapped as
-- a "pass-through" against a real provider cost of 0.8% capped at $5, plus a 1%
-- uncapped markup — roughly 60x cost on a $10,000 payment, and hundreds of times
-- the market rate for domestic ACH bill pay. Versioned rather than overwritten so
-- the pricing history stays auditable.
update public.payment_fee_policies
set effective_to = now()
where org_id is null and effective_to is null;

insert into public.payment_fee_policies (
  org_id, pricing_model, pass_through_processor_fees,
  processor_fee_bps, processor_fee_fixed_cents, processor_fee_cap_cents,
  ap_platform_fee_flat_cents, ap_platform_fee_bps, ap_platform_fee_cap_cents,
  effective_from
)
select
  null,
  pricing_model,
  true,
  -- Mirrors the provider's published ACH debit pricing exactly, so
  -- "passed through at cost" in the UI is a true statement.
  80, 0, 500,
  -- Arc's own fee, set to the same shape for now: 0.8% capped at $5.
  0, 80, 500,
  now()
from public.payment_fee_policies
where org_id is null
order by effective_from desc
limit 1;

/**
 * One fee collection per payment run.
 *
 * Not a `disbursement`: those require a run item, a bill and a vendor recipient,
 * and this has none of them — it moves money from the builder to Arc, not to a
 * vendor. Modelling it as a disbursement would have meant nullable columns on
 * the vendor payment path, which is the last place to loosen a constraint.
 */
create table if not exists public.payment_run_fee_charges (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  run_id uuid not null references public.payment_runs(id) on delete cascade,
  funding_source_id uuid not null references public.org_funding_sources(id),
  provider text not null,
  provider_payment_id text,
  provider_charge_id text,
  status text not null default 'created'
    check (status in ('created', 'submitted', 'debit_pending', 'succeeded', 'failed', 'canceled')),
  -- The two components stay separable after collection: one is a cost recovered
  -- at cost, the other is margin, and they are reported apart.
  processor_fee_cents bigint not null default 0 check (processor_fee_cents >= 0),
  platform_fee_cents bigint not null default 0 check (platform_fee_cents >= 0),
  amount_cents bigint not null check (amount_cents > 0),
  currency text not null default 'usd',
  idempotency_key text not null,
  submission_attempted_at timestamptz,
  submitted_at timestamptz,
  settled_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One charge per run is the whole point; a second one would double-bill.
  unique (run_id),
  unique (org_id, idempotency_key)
);

create index if not exists payment_run_fee_charges_org_status_idx
  on public.payment_run_fee_charges (org_id, status, created_at desc);

alter table public.payment_run_fee_charges enable row level security;

drop policy if exists payment_run_fee_charges_read on public.payment_run_fee_charges;
create policy payment_run_fee_charges_read on public.payment_run_fee_charges
  for select to authenticated
  using (
    public.has_org_permission(org_id, 'payment.release')
    or public.has_org_permission(org_id, 'payment.reconcile')
  );

-- Writes are service-role only. Money movement is never a browser-writable surface.
grant select on public.payment_run_fee_charges to authenticated;
grant all on public.payment_run_fee_charges to service_role;

drop trigger if exists payment_run_fee_charges_set_updated_at on public.payment_run_fee_charges;
create trigger payment_run_fee_charges_set_updated_at before update on public.payment_run_fee_charges
  for each row execute function public.tg_set_updated_at();
