-- Backfill the vendor on payables that never recorded one.
--
-- `createVendorBillFromPortal` inserted org, project and commitment but never
-- `company_id`, so the one intake path where the vendor is definitionally known
-- — they were signed in as that vendor when they submitted — produced the only
-- bills that could not say who to pay.
--
-- The consequences all failed quietly. `createPaymentRun` rejects the bill
-- ("Every electronic payable must identify a vendor company"), the payables desk
-- hides the readiness badge and the invite link, `getVendor1099Totals` drops the
-- payment from the vendor's year, and the duplicate-invoice-number trigger
-- short-circuits on a null company — leaving the least-trusted intake path as
-- the only one without duplicate protection.
--
-- The service-side fix is in `lib/services/vendor-bills.ts`. This repairs the
-- rows already written. Only bills whose commitment names a company are touched:
-- that is a recorded fact about the contract, not a guess. Bills with no
-- commitment are left alone rather than matched by name or email, which is the
-- same rule the payment rail applies to vendor identity.

update public.vendor_bills b
set company_id = c.company_id
from public.commitments c
where b.commitment_id = c.id
  and b.org_id = c.org_id
  and b.company_id is null
  and c.company_id is not null;
