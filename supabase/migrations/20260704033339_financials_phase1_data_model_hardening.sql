-- Financials Trust & Billing Modes Refactor - Phase 1
-- Data model hardening for contract terms and contract amendments.

alter table public.contracts
  add column if not exists fixed_fee_cents integer,
  add column if not exists parent_contract_id uuid references public.contracts(id) on delete set null;

alter table public.contracts
  drop constraint if exists contracts_fixed_fee_cents_check,
  add constraint contracts_fixed_fee_cents_check
    check (fixed_fee_cents is null or fixed_fee_cents >= 0);

create index if not exists contracts_parent_contract_id_idx
  on public.contracts (parent_contract_id)
  where parent_contract_id is not null;

create index if not exists contracts_active_project_idx
  on public.contracts (org_id, project_id, created_at desc)
  where status = 'active';

update public.contracts c
set fixed_fee_cents = coalesce(
  c.fixed_fee_cents,
  case
    when nullif(c.snapshot->>'fixed_fee_cents', '') ~ '^[0-9]+$'
      then (c.snapshot->>'fixed_fee_cents')::integer
    else null
  end,
  case
    when nullif(pfs.metadata->>'fixed_fee_cents', '') ~ '^[0-9]+$'
      then (pfs.metadata->>'fixed_fee_cents')::integer
    else null
  end
)
from public.project_financial_settings pfs
where pfs.org_id = c.org_id
  and pfs.project_id = c.project_id
  and coalesce(pfs.billing_model, c.snapshot->>'billing_model') = 'cost_plus_fixed_fee'
  and c.fixed_fee_cents is null
  and (
    (c.snapshot ? 'fixed_fee_cents' and nullif(c.snapshot->>'fixed_fee_cents', '') is not null)
    or (pfs.metadata ? 'fixed_fee_cents' and nullif(pfs.metadata->>'fixed_fee_cents', '') is not null)
  );

comment on column public.contracts.fixed_fee_cents is
  'Fixed-fee contract amount in cents. Project financial settings remain authoritative for billing model selection.';

comment on column public.contracts.parent_contract_id is
  'Previous active contract superseded by this amendment, preserving billing terms used by existing invoices and ledger rows.';
