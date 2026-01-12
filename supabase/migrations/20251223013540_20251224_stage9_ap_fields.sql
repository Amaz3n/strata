alter table vendor_bills add column if not exists approved_at timestamptz;
alter table vendor_bills add column if not exists approved_by uuid references app_users(id);
alter table vendor_bills add column if not exists paid_at timestamptz;
alter table vendor_bills add column if not exists payment_reference text;

-- Add indexes for the new columns
create index if not exists vendor_bills_approved_at_idx on vendor_bills (org_id, approved_at);
create index if not exists vendor_bills_paid_at_idx on vendor_bills (org_id, paid_at);;
