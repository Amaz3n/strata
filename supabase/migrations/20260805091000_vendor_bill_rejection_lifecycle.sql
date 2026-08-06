-- A payable can now be rejected, and its status column is finally constrained.
--
-- `vendor_bills.status` was free text carrying four values by convention alone,
-- with no state for "we are not paying this". A bad invoice could only be
-- deleted — impossible once QuickBooks had seen it — or left pending forever,
-- which is how a sub ends up chasing a bill nobody ever intended to pay and how
-- the approval queue fills with rows no one will action.
--
-- Two places already queried statuses that no code path could write:
-- `compute_directory_intelligence` counted 'rejected'/'disputed' as vendor issue
-- signals, and the payables desk filtered out 'void'/'cancelled'. The first
-- becomes true here. The second is corrected in `lib/services/org-payables.ts`
-- to filter on the state that actually exists.

alter table public.vendor_bills
  add column if not exists rejected_at timestamptz,
  add column if not exists rejected_by uuid references public.app_users(id),
  add column if not exists rejection_reason text;

comment on column public.vendor_bills.rejection_reason is
  'Why the payable was refused. Shown to the submitting vendor, so it is written to be read by them.';

-- Production carries only the four legacy values, so the constraint goes on
-- validated rather than NOT VALID.
alter table public.vendor_bills drop constraint if exists vendor_bills_status_check;
alter table public.vendor_bills
  add constraint vendor_bills_status_check
  check (status in ('pending', 'approved', 'partial', 'paid', 'rejected'));

-- A rejection is only meaningful with a reason attached; the UI requires one and
-- so does the row.
alter table public.vendor_bills drop constraint if exists vendor_bills_rejection_evidence_check;
alter table public.vendor_bills
  add constraint vendor_bills_rejection_evidence_check
  check (
    status <> 'rejected'
    or (rejected_at is not null and length(coalesce(btrim(rejection_reason), '')) >= 8)
  );

-- The desk's open-payables queries filter rejected rows out by status, and the
-- vendor portal reads them back by company. Both want the same shape.
create index if not exists vendor_bills_org_status_rejected_idx
  on public.vendor_bills (org_id, rejected_at desc)
  where status = 'rejected';
