alter table if exists public.vendor_bills
  alter column commitment_id drop not null;

alter table if exists public.vendor_bills
  alter column submitted_by_contact_id drop not null;

alter table if exists public.vendor_bills
  alter column file_id drop not null;
