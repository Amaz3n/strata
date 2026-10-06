-- Office and other overhead payables belong to the organization, not to a
-- construction project. The existing RLS policy already explicitly permits
-- project_id IS NULL for organization members.
alter table public.vendor_bills
  alter column project_id drop not null;

comment on column public.vendor_bills.project_id is
  'Optional project allocation. NULL identifies an organization-level overhead payable.';
