alter table if exists public.vendor_bills
  add column if not exists company_id uuid;

alter table if exists public.vendor_bills
  drop constraint if exists vendor_bills_company_id_fkey;

alter table if exists public.vendor_bills
  add constraint vendor_bills_company_id_fkey
  foreign key (company_id)
  references public.companies(id)
  on delete set null;

create index if not exists vendor_bills_company_idx
  on public.vendor_bills (org_id, company_id)
  where company_id is not null;
