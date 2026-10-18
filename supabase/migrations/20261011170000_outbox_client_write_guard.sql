-- Deferred audit rows are server-authored.
--
-- A critical audit row that could not be written is queued as an `audit_retry`
-- outbox job carrying the complete row, and the worker inserts it into
-- `audit_log` with the service role (`writeDeferredAudit`). The outbox table's
-- `outbox_access` policy lets any org member insert, update and delete their
-- org's rows through PostgREST, so without this guard a member could queue a
-- forged audit row (any actor, any entity, a backdated time) for the service
-- role to write, or fail, rewrite or delete a genuine pending row.
--
-- Mirrors `guard_starts_job_browser_writes` (20261003048000): browser roles may
-- not create, change or remove an `audit_retry` job, nor turn another job into
-- one. Other job types are untouched — several are still enqueued through the
-- member's own client.

create function public.guard_audit_retry_browser_writes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') and (
    (tg_op <> 'DELETE' and new.job_type = 'audit_retry')
    or (tg_op <> 'INSERT' and old.job_type = 'audit_retry')
  ) then
    raise exception 'Deferred audit records can only be queued by the server' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create trigger audit_retry_browser_write_guard
  before insert or update or delete on public.outbox
  for each row execute function public.guard_audit_retry_browser_writes();

revoke all on function public.guard_audit_retry_browser_writes() from public, anon, authenticated;
