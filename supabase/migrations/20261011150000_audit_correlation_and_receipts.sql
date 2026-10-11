-- Correlation ids on the evidence tables.
--
-- One unit of work (a request, an outbox job) writes audit rows, events and
-- authorization decisions; `correlation_id` lets them be read together. The app
-- writes it explicitly (`lib/observability/correlation.ts`). Rows written inside
-- a database function never pass through that code, so the column defaults to
-- the `x-correlation-id` request header PostgREST exposes as `request.headers`
-- for the transaction the function runs in — the same mechanism the drawing
-- workers' claim tokens use. A caller that does not send the header leaves it
-- null; nothing is inferred.
--
-- authorization_audit_log already has `request_id` (text) for exactly this, so
-- it gets the default rather than a second column meaning the same thing.

create or replace function public.request_correlation_id()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(
    left(coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb ->> 'x-correlation-id', 200),
    ''
  )
$$;

comment on function public.request_correlation_id() is
  'The x-correlation-id header of the PostgREST request this transaction serves, or null.';

-- A column default runs as the inserting role, so every role that inserts into
-- these tables needs it. It reads only the caller's own request headers.
revoke all on function public.request_correlation_id() from public;
grant execute on function public.request_correlation_id() to anon, authenticated, service_role;

alter table public.audit_log
  add column if not exists correlation_id text default public.request_correlation_id();

alter table public.events
  add column if not exists correlation_id text default public.request_correlation_id();

alter table public.authorization_audit_log
  alter column request_id set default public.request_correlation_id();

comment on column public.audit_log.correlation_id is
  'The request or job that wrote this row; shared with events.correlation_id and authorization_audit_log.request_id.';
comment on column public.events.correlation_id is
  'The request or job that wrote this row; shared with audit_log.correlation_id and authorization_audit_log.request_id.';

-- Partial: rows written before this migration, and DB-function rows from callers
-- that send no header, have nothing to look up.
create index if not exists audit_log_org_correlation_idx
  on public.audit_log (org_id, correlation_id)
  where correlation_id is not null;

create index if not exists events_org_correlation_idx
  on public.events (org_id, correlation_id)
  where correlation_id is not null;

create index if not exists authorization_audit_log_org_request_idx
  on public.authorization_audit_log (org_id, request_id)
  where request_id is not null;
