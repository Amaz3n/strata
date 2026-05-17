-- Stage 9 (Unified MVP Gameplan): Job Costing Lite + AP Workflow - Add AP Fields to Vendor Bills
-- Promote critical AP fields from metadata to columns for reporting

alter table vendor_bills add column if not exists approved_at timestamptz;
alter table vendor_bills add column if not exists approved_by uuid references app_users(id);
alter table vendor_bills add column if not exists paid_at timestamptz;
alter table vendor_bills add column if not exists payment_reference text;

-- Add indexes for the new columns
create index if not exists vendor_bills_approved_at_idx on vendor_bills (org_id, approved_at);
create index if not exists vendor_bills_paid_at_idx on vendor_bills (org_id, paid_at);

-- Update RLS to allow access to approved_by user
drop policy if exists vendor_bills_access on vendor_bills;
create policy vendor_bills_access on vendor_bills for all using ((auth.role() = 'service_role'::text) or is_org_member(org_id)) with check ((auth.role() = 'service_role'::text) or is_org_member(org_id));



