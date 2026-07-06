-- Portal hardening follow-up:
-- - explicit non-messaging permissions for warranty, sub time, and sub expenses
-- - direct client sharing for canonical daily reports
-- - atomic access recording that respects max_access_count

alter table public.portal_access_tokens
  add column if not exists can_view_warranty boolean not null default true,
  add column if not exists can_submit_time boolean not null default true,
  add column if not exists can_submit_expenses boolean not null default true;

alter table public.daily_reports
  add column if not exists share_with_client boolean not null default false;

alter table public.external_portal_accounts
  add column if not exists password_attempts integer not null default 0,
  add column if not exists password_locked_until timestamptz;

create index if not exists daily_reports_portal_shared_idx
  on public.daily_reports (org_id, project_id, report_date desc)
  where share_with_client = true and status = 'submitted';

create or replace function public.record_portal_access(token_id_input uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  updated_count integer;
begin
  update public.portal_access_tokens
  set access_count = coalesce(access_count, 0) + 1,
      last_accessed_at = now()
  where id = token_id_input
    and revoked_at is null
    and paused_at is null
    and (expires_at is null or expires_at > now())
    and (max_access_count is null or coalesce(access_count, 0) < max_access_count);

  get diagnostics updated_count = row_count;
  return updated_count > 0;
end;
$$;

grant execute on function public.record_portal_access(uuid) to anon, authenticated, service_role;
