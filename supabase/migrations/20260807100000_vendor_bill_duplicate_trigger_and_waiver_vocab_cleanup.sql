-- Vendor-bill duplicate trigger status hygiene + lien-waiver vocabulary backfill.
--
-- 1. `vendor_bills.status` has been CHECK-constrained to
--    pending|approved|partial|paid|rejected since 20260805091000, so the
--    trigger's void/voided/cancelled/canceled exclusion list matched rows that
--    cannot exist. Drop it: every live status now blocks a duplicate invoice
--    number, including `rejected` — resubmitting a corrected invoice reopens
--    the rejected payable (the app's reopen flow) instead of minting a twin row.
--    The skip when company_id is null or bill_number is blank stays: with
--    nothing to match on the trigger has nothing to say. The null-company case
--    is covered at the application layer, which matches on normalized vendor
--    name in both the manual create path (lib/services/vendor-bills.ts) and
--    email ingest (lib/services/payables-email-ingest.ts).
--
-- 2. `vendor_bills.lien_waiver_status` legacy value 'signed' predates the
--    not_required|requested|received vocabulary. The app now normalizes
--    'signed' to 'received' at the validation boundary
--    (lib/validation/vendor-bills.ts) and no longer reads 'signed' anywhere;
--    backfill stored rows so the release gate keeps recognizing them.

create or replace function public.prevent_concurrent_vendor_bill_duplicate()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.company_id is null or nullif(btrim(new.bill_number), '') is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.org_id::text || ':' || new.company_id::text || ':' || lower(btrim(new.bill_number)), 0));
  if exists (
    select 1 from public.vendor_bills bill
    where bill.org_id = new.org_id
      and bill.company_id = new.company_id
      and lower(btrim(bill.bill_number)) = lower(btrim(new.bill_number))
      and bill.id is distinct from new.id
  ) then raise exception 'Duplicate vendor invoice number for this company'; end if;
  return new;
end;
$$;

update public.vendor_bills
set lien_waiver_status = 'received',
    lien_waiver_received_at = coalesce(lien_waiver_received_at, updated_at)
where lien_waiver_status = 'signed';

-- The other half of the same drift: 'pending' is the pre-vocabulary name for
-- 'requested' and is what the Zod preprocess already maps writes to, so stored
-- rows still carrying it describe a waiver that was asked for and has not
-- arrived. No `lien_waiver_received_at` is set — nothing was received. Reads are
-- unaffected either way (the release gate only recognizes 'received'); this is
-- so the stored vocabulary matches the one the application speaks.
update public.vendor_bills
set lien_waiver_status = 'requested'
where lien_waiver_status = 'pending';
