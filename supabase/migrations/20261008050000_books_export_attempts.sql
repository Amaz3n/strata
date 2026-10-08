-- B06.1: a Books archive is built by a durable background job. Each attempt is
-- numbered and kept: an attempt that dies mid-build is recorded as interrupted
-- when the next one starts, a failure is recorded with its reason, and only the
-- current attempt may mark the archive ready. An export whose job is gone fails
-- explicitly instead of reading "generating" forever.

alter table public.books_exports add column attempt_count integer not null default 0 check (attempt_count >= 0);
alter table public.books_exports add column attempts jsonb not null default '[]'::jsonb check (jsonb_typeof(attempts) = 'array');
alter table public.books_exports add column started_at timestamptz;

create index books_exports_unfinished_idx on public.books_exports (org_id, status) where status in ('queued', 'generating');

-- Starts the next attempt and returns its number, or null when the archive is
-- already finished (a retried job after success does nothing).
create or replace function public.start_books_export_attempt(p_org_id uuid, p_export_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_export public.books_exports%rowtype;
begin
  select * into v_export from public.books_exports where org_id = p_org_id and id = p_export_id for update;
  if not found then raise exception 'Books export not found'; end if;
  if v_export.status in ('ready', 'expired') then return null; end if;
  if v_export.status = 'generating' then
    v_export.attempts := v_export.attempts || jsonb_build_array(jsonb_build_object(
      'attempt', v_export.attempt_count, 'startedAt', v_export.started_at, 'endedAt', now(), 'outcome', 'interrupted'));
  end if;
  update public.books_exports
     set status = 'generating', attempt_count = v_export.attempt_count + 1, attempts = v_export.attempts,
         started_at = now(), error_message = null, storage_path = null, content_hash = null
   where org_id = p_org_id and id = p_export_id;
  return v_export.attempt_count + 1;
end $$;
revoke all on function public.start_books_export_attempt(uuid, uuid) from public, anon, authenticated;
grant execute on function public.start_books_export_attempt(uuid, uuid) to service_role;

-- Records a failed attempt; a later attempt (a retry) leaves the export alone.
create or replace function public.fail_books_export_attempt(p_org_id uuid, p_export_id uuid, p_attempt integer, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.books_exports
     set status = 'failed', error_message = left(p_error, 2000),
         attempts = attempts || jsonb_build_array(jsonb_build_object('attempt', p_attempt, 'startedAt', started_at, 'endedAt', now(), 'outcome', 'failed', 'error', left(p_error, 500)))
   where org_id = p_org_id and id = p_export_id and attempt_count = p_attempt and status = 'generating';
end $$;
revoke all on function public.fail_books_export_attempt(uuid, uuid, integer, text) from public, anon, authenticated;
grant execute on function public.fail_books_export_attempt(uuid, uuid, integer, text) to service_role;

-- Exports whose job no longer exists or ran out of retries fail explicitly.
create or replace function public.fail_stranded_books_exports(p_older_than interval default interval '1 hour')
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  with stranded as (
    select x.id, x.org_id from public.books_exports x
    where x.status in ('queued', 'generating') and coalesce(x.started_at, x.requested_at) < now() - p_older_than
      and not exists (select 1 from public.outbox o where o.org_id = x.org_id and o.job_type = 'generate_books_export'
        and o.payload->>'export_id' = x.id::text and o.status in ('pending', 'processing'))
    for update of x skip locked
  )
  update public.books_exports x
     set status = 'failed', error_message = 'The archive was interrupted and its job ended; create a new export.',
         attempts = x.attempts || case when x.status = 'generating' then jsonb_build_array(jsonb_build_object('attempt', x.attempt_count, 'startedAt', x.started_at, 'endedAt', now(), 'outcome', 'interrupted')) else '[]'::jsonb end
    from stranded s where x.id = s.id and x.org_id = s.org_id;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function public.fail_stranded_books_exports(interval) from public, anon, authenticated;
grant execute on function public.fail_stranded_books_exports(interval) to service_role;
