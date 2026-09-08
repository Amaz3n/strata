-- Phase E: the vendor side of the AP rail.
--
-- Two structural facts the application layer cannot enforce on its own:
--
--  1. A payout invitation is its own kind of access record. Reusing a contact's
--     project sub link as the payout link meant a PM pausing one project's
--     sharing row tore down the org-wide payment authority that link had
--     established. `purpose` is what separates the two, so the payment cascade
--     can fire for a payout link and never for a project link.
--  2. Money may only move against a live claim. `setCompanyPaymentAccessStatus`
--     now rebuilds the claim on restore, but the invariant belongs in the
--     database: an `active` relationship without a `verified` claim behind it is
--     a builder paying a destination whose provenance was withdrawn.
-- The third finding this phase carried — that a bill can reach the rail without
-- a vendor company — turned out to be already closed in the database. Section 3
-- below records why, and the Phase E pgTAP suite pins it.

-- 1. Dedicated payout invitations ------------------------------------------

alter table public.portal_access_tokens
  add column if not exists purpose text not null default 'portal';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.portal_access_tokens'::regclass
      and conname = 'portal_access_tokens_purpose_check'
  ) then
    alter table public.portal_access_tokens
      add constraint portal_access_tokens_purpose_check
      check (purpose in ('portal', 'vendor_payout'));
  end if;
end $$;

-- A payout invitation is company-scoped and person-bound; both are what the
-- invitation service matches on when it decides to reuse or replace a link.
create index if not exists portal_access_tokens_vendor_payout_idx
  on public.portal_access_tokens (org_id, company_id, contact_id)
  where purpose = 'vendor_payout';

comment on column public.portal_access_tokens.purpose is
  'What this access record is for. ''portal'' is project/company access; ''vendor_payout'' is a payout invitation whose lifecycle carries through to vendor payment authority. Existing rows are deliberately NOT backfilled: a project link that was once reused as a payout link stays a project link, so pausing it no longer withdraws payment access.';

-- 2. Money cannot move against a claim that is not live ---------------------

create or replace function public.assert_vendor_relationship_claim_live()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim public.vendor_company_claims%rowtype;
begin
  if new.status is distinct from 'active' then
    return new;
  end if;
  if new.vendor_company_claim_id is null then
    raise exception 'A vendor payment relationship cannot be active without a vendor company claim'
      using errcode = 'check_violation';
  end if;
  select * into v_claim
  from public.vendor_company_claims
  where id = new.vendor_company_claim_id and org_id = new.org_id;
  if v_claim.id is null then
    raise exception 'The vendor company claim behind this relationship was not found'
      using errcode = 'check_violation';
  end if;
  if v_claim.status <> 'verified' or v_claim.revoked_at is not null then
    raise exception 'A vendor payment relationship cannot be active while its claim is %', v_claim.status
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists vendor_payment_relationships_claim_live on public.vendor_payment_relationships;
create trigger vendor_payment_relationships_claim_live
  before insert or update of status, vendor_company_claim_id on public.vendor_payment_relationships
  for each row execute function public.assert_vendor_relationship_claim_live();

-- The other direction. Without this the invariant holds only at the instant the
-- relationship moves: revoking the claim underneath a live `active` row would
-- leave the builder paying a destination whose provenance was withdrawn, and no
-- later write would notice. Both withdrawal paths already close the
-- relationship before the claim, so this only refuses the wrong order.
create or replace function public.assert_claim_withdrawal_closes_access()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status not in ('revoked', 'rejected') or old.status = new.status then
    return new;
  end if;
  if exists (
    select 1 from public.vendor_payment_relationships
    where org_id = new.org_id and vendor_company_claim_id = new.id and status = 'active'
  ) then
    raise exception 'Withdraw the vendor payment relationship before withdrawing its claim'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists vendor_company_claims_withdrawal_closes_access on public.vendor_company_claims;
create trigger vendor_company_claims_withdrawal_closes_access
  before update of status on public.vendor_company_claims
  for each row execute function public.assert_claim_withdrawal_closes_access();

-- 3. A bill on the rail always names its vendor: ALREADY ENFORCED -----------
--
-- No trigger here on purpose. `enforce_payment_run_item_integrity` already
-- raises "Payment run item bill must identify the relationship vendor" when the
-- bill's `company_id` is null, and a disbursement cannot exist without a
-- `run_item_id` whose bill it must match, so the rail is closed to an
-- unattributed bill at its only entrance. A second trigger would be a parallel
-- implementation of a rule that already holds; `payment_phase_e.test.sql` pins
-- the existing behavior instead so it cannot be loosened by accident.
--
-- `vendor_bills.company_id` stays nullable for the same reason it always was:
-- email ingest writes a bill before anyone has attributed it, and 142 such rows
-- exist in production today. The constraint belongs on entry into the rail, not
-- on the bill.

revoke all on function public.assert_vendor_relationship_claim_live() from public, anon, authenticated;
revoke all on function public.assert_claim_withdrawal_closes_access() from public, anon, authenticated;
