-- Accounting abstraction hardening.
-- 1. Providers are validated in application code (lib/integrations/accounting/registry.ts).
--    A CHECK constraint per table would force a migration for every new provider, so the
--    'qbo'-only CHECKs are dropped now that the registry is the source of truth.
-- 2. Deploy-window compat columns, constraints, and shims remain in place until
--    the new application has deployed. Removing them in this migration would
--    create an old-code/new-schema incompatibility window.
-- 3. Deploy-window compat shims remain in place until the new application has
--    deployed and soaked. Their destructive removal stays in the B3 pending migration.
--
-- Note: no uniqueness is added on (connection_id, entity_type, external_id). One external
-- transaction legitimately maps to MULTIPLE Arc rows: per-line project allocation fans a
-- QBO bill/JE out into several project_expenses, and client-deposit JEs import as several
-- HIST-* invoices. Duplicate-import protection therefore belongs in the import claim path
-- (code), not in a table constraint.

alter table public.accounting_connections drop constraint if exists accounting_connections_provider_check;
alter table public.accounting_sync_records drop constraint if exists accounting_sync_records_provider_check;
alter table public.accounting_counterparty_links drop constraint if exists accounting_counterparty_links_provider_check;

-- Provider-neutral lifecycle fields. QBO continues to use the legacy encrypted
-- token columns inside its adapter, but another adapter is no longer forced to
-- manufacture OAuth tokens or a token expiry in order to create a connection.
alter table public.accounting_connections
  alter column access_token drop not null,
  alter column refresh_token drop not null,
  alter column token_expires_at drop not null,
  add column if not exists auth_scheme text not null default 'oauth2',
  add column if not exists auth_config jsonb not null default '{}'::jsonb,
  add column if not exists last_inbound_poll_at timestamptz;

create index if not exists accounting_connections_inbound_poll_idx
  on public.accounting_connections (status, last_inbound_poll_at nulls first)
  where status = 'active';

-- A provider account/realm may have only one active Arc owner. Inbound webhooks
-- carry the realm but no Arc org id, so permitting the same realm in two orgs
-- would make ownership ambiguous and could reconcile into the wrong tenant.
create unique index if not exists accounting_connections_provider_account_global_active_idx
  on public.accounting_connections (provider, external_account_id)
  where status = 'active';

-- An Arc entity identity belongs to a book, not merely an organization. This
-- permits the same Arc-side entity type/id to have historical linkage in two
-- books without one connection overwriting the other, while preserving the
-- one-row-per-entity-per-book create claim.
create unique index if not exists accounting_sync_records_connection_entity_idx
  on public.accounting_sync_records (org_id, connection_id, entity_type, entity_id);

create or replace function public.accounting_claim_sync_create(
  p_org_id uuid,
  p_connection_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_stale_after interval default interval '15 minutes'
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
  connection_provider text;
begin
  select provider into connection_provider
  from public.accounting_connections
  where id = p_connection_id and org_id = p_org_id and status = 'active';
  if connection_provider is null then return false; end if;

  insert into public.accounting_sync_records (
    org_id, connection_id, provider, entity_type, entity_id, external_id,
    last_synced_at, status, error_message, metadata
  ) values (
    p_org_id, p_connection_id, connection_provider, p_entity_type, p_entity_id, '',
    now(), 'processing', null, jsonb_build_object('claim_started_at', now())
  )
  on conflict (org_id, connection_id, entity_type, entity_id)
  do update set
    provider = excluded.provider,
    status = 'processing',
    error_message = null,
    last_synced_at = now(),
    metadata = coalesce(public.accounting_sync_records.metadata, '{}'::jsonb)
      || jsonb_build_object('claim_started_at', now())
  where coalesce(public.accounting_sync_records.external_id, '') = ''
    and (
      public.accounting_sync_records.status is distinct from 'processing'
      or public.accounting_sync_records.last_synced_at < now() - p_stale_after
    )
  returning id into claimed_id;
  return claimed_id is not null;
end;
$$;
revoke all on function public.accounting_claim_sync_create(uuid, uuid, text, uuid, interval) from public, anon, authenticated;
grant execute on function public.accounting_claim_sync_create(uuid, uuid, text, uuid, interval) to service_role;

-- Remote-import claims are deliberately separate from sync records because one
-- provider transaction can fan out to many Arc rows. The claim protects the
-- remote identity while the sync ledger preserves every resulting relationship.
create table if not exists public.accounting_import_claims (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  connection_id uuid not null references public.accounting_connections(id) on delete cascade,
  provider text not null,
  external_entity_type text not null,
  external_id text not null,
  status text not null default 'processing' check (status in ('processing','completed','error')),
  claim_token uuid not null default gen_random_uuid(),
  lease_expires_at timestamptz not null,
  completed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, external_entity_type, external_id)
);
create index if not exists accounting_import_claims_org_status_idx
  on public.accounting_import_claims (org_id, status, lease_expires_at);
alter table public.accounting_import_claims enable row level security;
revoke all on table public.accounting_import_claims from anon, authenticated;
grant all on table public.accounting_import_claims to service_role;

create or replace function public.accounting_claim_import(
  p_org_id uuid,
  p_connection_id uuid,
  p_external_entity_type text,
  p_external_id text,
  p_lease interval default interval '15 minutes'
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  token uuid := gen_random_uuid();
  claimed_token uuid;
  connection_provider text;
begin
  select provider into connection_provider
  from public.accounting_connections
  where id = p_connection_id and org_id = p_org_id and status = 'active';
  if connection_provider is null then return null; end if;

  insert into public.accounting_import_claims (
    org_id, connection_id, provider, external_entity_type, external_id,
    status, claim_token, lease_expires_at, error_message, updated_at
  ) values (
    p_org_id, p_connection_id, connection_provider, p_external_entity_type,
    p_external_id, 'processing', token, now() + p_lease, null, now()
  )
  on conflict (connection_id, external_entity_type, external_id)
  do update set
    status = 'processing', claim_token = token, lease_expires_at = now() + p_lease,
    completed_at = null, error_message = null, updated_at = now()
  where public.accounting_import_claims.status = 'error'
     or (public.accounting_import_claims.status = 'processing'
         and public.accounting_import_claims.lease_expires_at < now())
  returning claim_token into claimed_token;
  return claimed_token;
end;
$$;

create or replace function public.accounting_finish_import(
  p_connection_id uuid,
  p_external_entity_type text,
  p_external_id text,
  p_claim_token uuid,
  p_status text,
  p_error_message text default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('completed','error') then
    raise exception 'Invalid import claim completion status';
  end if;
  update public.accounting_import_claims
  set status = p_status,
      completed_at = case when p_status = 'completed' then now() else null end,
      error_message = left(p_error_message, 4000),
      lease_expires_at = now(), updated_at = now()
  where connection_id = p_connection_id
    and external_entity_type = p_external_entity_type
    and external_id = p_external_id
    and claim_token = p_claim_token
    and status = 'processing';
  return found;
end;
$$;
revoke all on function public.accounting_claim_import(uuid,uuid,text,text,interval) from public, anon, authenticated;
revoke all on function public.accounting_finish_import(uuid,text,text,uuid,text,text) from public, anon, authenticated;
grant execute on function public.accounting_claim_import(uuid,uuid,text,text,interval) to service_role;
grant execute on function public.accounting_finish_import(uuid,text,text,uuid,text,text) to service_role;

-- Cost-code memories are scoped to a book; account ids are only unique inside
-- one provider company/realm.
alter table public.qbo_import_cost_code_mappings
  add column if not exists connection_id uuid references public.accounting_connections(id) on delete cascade;
update public.qbo_import_cost_code_mappings mapping
set connection_id = (
  select id from public.accounting_connections
  where org_id = mapping.org_id and provider = 'qbo'
  order by (status = 'active') desc, connected_at, id limit 1
)
where mapping.connection_id is null;
create unique index if not exists qbo_import_cost_code_mappings_connection_ref_idx
  on public.qbo_import_cost_code_mappings (org_id, connection_id, qbo_ref_type, qbo_ref_id);
create index if not exists qbo_import_cost_code_mappings_connection_idx
  on public.qbo_import_cost_code_mappings (connection_id);

-- Protect every routing scope, not only project overrides. Changing a division,
-- community, or org-default book can re-home hundreds of already-posted rows.
create or replace function public.guard_accounting_project_reassignment()
returns trigger language plpgsql set search_path = public as $$
begin
  if old.connection_id is not distinct from new.connection_id then return new; end if;
  if new.reassignment_acknowledged_at is distinct from old.reassignment_acknowledged_at
     and new.reassignment_acknowledged_by is not null then return new; end if;

  if exists (
    select 1
    from public.accounting_sync_records r
    where r.org_id = old.org_id
      and r.connection_id = old.connection_id
      and coalesce(r.external_id, '') <> ''
      and (
        (old.project_id is null and old.community_id is null and old.division_id is null)
        or exists (
          select 1
          from public.invoices i
          left join public.projects p on p.id = i.project_id and p.org_id = i.org_id
          left join public.lots l on l.project_id = i.project_id and l.org_id = i.org_id
          where r.entity_type = 'invoice' and r.entity_id = i.id
            and (old.project_id = i.project_id or old.division_id = p.division_id or old.community_id = l.community_id)
        )
        or exists (
          select 1
          from public.project_expenses e
          left join public.projects p on p.id = e.project_id and p.org_id = e.org_id
          left join public.lots l on l.project_id = e.project_id and l.org_id = e.org_id
          where r.entity_type = 'project_expense' and r.entity_id = e.id
            and (old.project_id = e.project_id or old.division_id = p.division_id or old.community_id = l.community_id)
        )
        or exists (
          select 1
          from public.vendor_bills b
          left join public.projects p on p.id = b.project_id and p.org_id = b.org_id
          left join public.lots l on l.project_id = b.project_id and l.org_id = b.org_id
          where r.entity_type in ('bill','vendor_credit') and r.entity_id = b.id
            and (old.project_id = b.project_id or old.division_id = p.division_id or old.community_id = l.community_id)
        )
        or exists (
          select 1
          from public.payments payment
          left join public.projects p on p.id = payment.project_id and p.org_id = payment.org_id
          left join public.lots l on l.project_id = payment.project_id and l.org_id = payment.org_id
          where r.entity_type in ('payment','bill_payment') and r.entity_id = payment.id
            and (old.project_id = payment.project_id or old.division_id = p.division_id or old.community_id = l.community_id)
        )
      )
  ) then
    raise exception 'Accounting connection cannot change after transactions have synced';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_accounting_project_reassignment() from public, anon, authenticated;
