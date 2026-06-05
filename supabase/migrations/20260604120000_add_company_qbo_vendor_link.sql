alter table if exists public.companies
  add column if not exists qbo_vendor_id text,
  add column if not exists qbo_vendor_name text,
  add column if not exists qbo_vendor_synced_at timestamptz,
  add column if not exists qbo_vendor_sync_status text;

alter table if exists public.companies
  drop constraint if exists companies_qbo_vendor_sync_status_check;

alter table if exists public.companies
  add constraint companies_qbo_vendor_sync_status_check
  check (
    qbo_vendor_sync_status is null
    or qbo_vendor_sync_status in ('linked', 'created', 'needs_review', 'error')
  );

create index if not exists companies_qbo_vendor_idx
  on public.companies (org_id, qbo_vendor_id)
  where qbo_vendor_id is not null;
