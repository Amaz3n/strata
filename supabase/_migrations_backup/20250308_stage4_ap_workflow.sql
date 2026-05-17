-- Stage 4: AP workflow + forecasting support

alter table vendor_bills add column if not exists paid_cents bigint default 0;
alter table vendor_bills add column if not exists payment_method text;
alter table vendor_bills add column if not exists retainage_percent numeric;
alter table vendor_bills add column if not exists retainage_cents bigint;
alter table vendor_bills add column if not exists lien_waiver_status text;
alter table vendor_bills add column if not exists lien_waiver_received_at timestamptz;

alter table budget_lines add column if not exists forecast_remaining_cents bigint;

create index if not exists vendor_bills_org_status_paid_idx on vendor_bills (org_id, status, paid_cents);
