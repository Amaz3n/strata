-- File-based accounting targets.
--
-- The accounting abstraction had exactly one implementation, QuickBooks Online,
-- which is not what commercial GCs or production builders run. They are on Sage
-- 300 CRE, Foundation, and Viewpoint Vista, none of which offers a usable push
-- API in the field — the real integration at those shops is an AP batch file
-- import.
--
-- So "pushing" for a file target means accruing a line into an open batch that a
-- controller exports and imports on their side. The lines are the same
-- transactions the API adapter would have pushed, which keeps
-- `accounting_sync_records` meaningful for both kinds of target: a line's id is
-- its external id until the batch is exported, and the batch reference after.

create table if not exists public.accounting_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  connection_id uuid not null references public.accounting_connections(id) on delete cascade,
  -- Which ERP layout this batch renders as. Stored per batch, not read from the
  -- connection at export time, so re-downloading an exported batch always
  -- reproduces the file the controller actually imported.
  format text not null check (format in ('sage300', 'foundation', 'viewpoint', 'generic')),
  status text not null default 'open' check (status in ('open', 'exported', 'void')),
  line_count integer not null default 0 check (line_count >= 0),
  total_cents bigint not null default 0,
  exported_at timestamptz,
  exported_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One open batch per connection: lines accrue into it until someone exports.
create unique index if not exists accounting_batches_one_open_idx
  on public.accounting_batches (org_id, connection_id)
  where status = 'open';
create index if not exists accounting_batches_org_idx
  on public.accounting_batches (org_id, connection_id, created_at desc);

create table if not exists public.accounting_batch_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  connection_id uuid not null references public.accounting_connections(id) on delete cascade,
  batch_id uuid not null references public.accounting_batches(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  entity_type text not null check (entity_type in ('invoice', 'payment', 'project_expense', 'bill', 'bill_payment', 'journal')),
  entity_id uuid not null,
  -- A reversal is a new line, never an edit or a delete of the original. The
  -- controller may already have imported the batch the original went out in, so
  -- rewriting history here would silently diverge from their ledger.
  direction text not null default 'post' check (direction in ('post', 'reverse')),
  amount_cents bigint not null,
  currency text not null default 'usd',
  posted_at timestamptz not null,
  memo text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One line per entity per direction. Re-pushing is a no-op, which is what
  -- makes the outbox's at-least-once delivery safe against a file target.
  unique (org_id, connection_id, entity_type, entity_id, direction)
);

create index if not exists accounting_batch_lines_batch_idx
  on public.accounting_batch_lines (batch_id, entity_type, posted_at);
create index if not exists accounting_batch_lines_entity_idx
  on public.accounting_batch_lines (org_id, connection_id, entity_type, entity_id);

alter table public.accounting_batches enable row level security;
alter table public.accounting_batch_lines enable row level security;

drop policy if exists accounting_batches_read on public.accounting_batches;
create policy accounting_batches_read on public.accounting_batches
  for select to authenticated
  using (public.has_org_permission(org_id, 'financials.export'));

drop policy if exists accounting_batch_lines_read on public.accounting_batch_lines;
create policy accounting_batch_lines_read on public.accounting_batch_lines
  for select to authenticated
  using (public.has_org_permission(org_id, 'financials.export'));

-- Writes are service-role only: lines are accrued by the sync pipeline, never
-- typed in by a browser.
grant select on public.accounting_batches to authenticated;
grant select on public.accounting_batch_lines to authenticated;
grant all on public.accounting_batches to service_role;
grant all on public.accounting_batch_lines to service_role;

drop trigger if exists accounting_batches_set_updated_at on public.accounting_batches;
create trigger accounting_batches_set_updated_at before update on public.accounting_batches
  for each row execute function public.tg_set_updated_at();
drop trigger if exists accounting_batch_lines_set_updated_at on public.accounting_batch_lines;
create trigger accounting_batch_lines_set_updated_at before update on public.accounting_batch_lines
  for each row execute function public.tg_set_updated_at();

/**
 * Accrue one line into the connection's open batch, creating the batch if there
 * is none. Atomic so two concurrent pushes cannot both create the open batch and
 * violate the one-open-batch index.
 */
create or replace function public.append_accounting_batch_line_atomic(
  p_org_id uuid,
  p_connection_id uuid,
  p_format text,
  p_project_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_direction text,
  p_amount_cents bigint,
  p_currency text,
  p_posted_at timestamptz,
  p_memo text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.accounting_batches%rowtype;
  v_line public.accounting_batch_lines%rowtype;
  v_existing public.accounting_batch_lines%rowtype;
begin
  select * into v_existing from public.accounting_batch_lines
  where org_id = p_org_id and connection_id = p_connection_id
    and entity_type = p_entity_type and entity_id = p_entity_id and direction = p_direction;
  if v_existing.id is not null then
    return to_jsonb(v_existing) || jsonb_build_object('duplicate', true);
  end if;

  -- Serialise open-batch creation for this connection.
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || p_connection_id::text, 0));

  select * into v_batch from public.accounting_batches
  where org_id = p_org_id and connection_id = p_connection_id and status = 'open'
  for update;

  if v_batch.id is null then
    insert into public.accounting_batches (org_id, connection_id, format)
    values (p_org_id, p_connection_id, p_format)
    returning * into v_batch;
  end if;

  insert into public.accounting_batch_lines (
    org_id, connection_id, batch_id, project_id, entity_type, entity_id,
    direction, amount_cents, currency, posted_at, memo, payload
  ) values (
    p_org_id, p_connection_id, v_batch.id, p_project_id, p_entity_type, p_entity_id,
    p_direction, p_amount_cents, coalesce(p_currency, 'usd'), p_posted_at, p_memo, coalesce(p_payload, '{}'::jsonb)
  ) returning * into v_line;

  update public.accounting_batches
  set line_count = line_count + 1,
      -- A reversal subtracts, so the batch total is what the import actually
      -- moves rather than a gross of unrelated signs.
      total_cents = total_cents + case when p_direction = 'reverse' then -p_amount_cents else p_amount_cents end
  where id = v_batch.id;

  return to_jsonb(v_line) || jsonb_build_object('duplicate', false, 'batch_id', v_batch.id);
end;
$$;

revoke all on function public.append_accounting_batch_line_atomic(uuid, uuid, text, uuid, text, uuid, text, bigint, text, timestamptz, text, jsonb) from public, anon, authenticated;
grant execute on function public.append_accounting_batch_line_atomic(uuid, uuid, text, uuid, text, uuid, text, bigint, text, timestamptz, text, jsonb) to service_role;
