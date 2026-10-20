-- Builder-to-trade network (Arc Trade readiness TR06). Neutral names: any org
-- that works as a sub for another org on Arc uses all of it.
--
-- 1. project_connections: one of this org's jobs linked to a project another
--    org shared with one of its people (an external_identity_grants row on a
--    sub portal token). The link has its own status. It follows the grant
--    (paused → paused, resumed → active, revoked → ended, terminal) and ending
--    it never touches the job. Writes are service-role only: the link is made
--    by lib/services/project-connections.ts after it re-resolves the grant
--    against the member's verified identity.
-- 2. vendor_bills that a sub submitted through that portal enqueue
--    `sync_connected_receivable` in the SUB's org whenever they are created or
--    their status, amount or paid amount changes. The worker
--    (lib/services/connected-receivables.ts) is the only code that reads the
--    builder's bill on the sub's behalf; neither org's RLS reaches across.
-- 3. invoices gain a unique mirror key so one builder bill is one receivable
--    on the sub's books, however often the job runs.
-- 4. own_compliance_documents: the company's own COI, W-9, license and bond,
--    stored once with their expiry and shared from there to each builder.
--    vendor_document_shares can now name a vault document as its source.

begin;

-- 1 ──────────────────────────────────────────────────────────────────────────
create table public.project_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  grant_id uuid not null references public.external_identity_grants(id) on delete restrict,
  source_org_id uuid not null references public.orgs(id) on delete cascade,
  source_project_id uuid not null references public.projects(id) on delete cascade,
  source_company_id uuid not null references public.companies(id) on delete cascade,
  portal_access_token_id uuid not null references public.portal_access_tokens(id) on delete cascade,
  -- Snapshots for display: the sub's members cannot read the builder's rows.
  source_org_name text not null,
  source_project_name text not null,
  customer_contact_id uuid references public.contacts(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'paused', 'ended')),
  ended_at timestamptz,
  ended_reason text,
  last_synced_at timestamptz,
  linked_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (org_id <> source_org_id),
  check ((status = 'ended') = (ended_at is not null))
);

-- A grant links to one job; a job links to one builder project at a time.
create unique index project_connections_grant_idx on public.project_connections (grant_id) where status <> 'ended';
create unique index project_connections_project_idx on public.project_connections (org_id, project_id) where status <> 'ended';
create index project_connections_org_project_idx on public.project_connections (org_id, project_id);
create index project_connections_source_idx on public.project_connections (source_org_id, source_project_id, source_company_id) where status = 'active';
create index project_connections_token_idx on public.project_connections (portal_access_token_id);
create index project_connections_customer_idx on public.project_connections (customer_contact_id) where customer_contact_id is not null;

create trigger project_connections_set_updated_at before update on public.project_connections
  for each row execute function public.tg_set_updated_at();

alter table public.project_connections enable row level security;
create policy project_connections_read on public.project_connections for select
  using (((select auth.role()) = 'service_role') or public.is_org_member(org_id));
create policy project_connections_service_write on public.project_connections for all
  using ((select auth.role()) = 'service_role')
  with check ((select auth.role()) = 'service_role');
create policy project_connections_division_scope on public.project_connections as restrictive for all
  using (((select auth.role()) = 'service_role') or (org_id = any ((select public.member_unscoped_org_ids())::uuid[])) or (project_id in (select public.member_reachable_project_ids())));
grant select on public.project_connections to authenticated;
grant all on public.project_connections to service_role;

create or replace function public.tg_project_connections_follow_grant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  link record;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if new.status = 'revoked' then
    update public.project_connections
       set status = 'ended', ended_at = now(), ended_reason = 'access_revoked'
     where grant_id = new.id and status <> 'ended';
  elsif new.status = 'paused' then
    update public.project_connections set status = 'paused'
     where grant_id = new.id and status = 'active';
  elsif new.status = 'active' then
    -- Resuming catches up: the bill trigger skipped paused links, so every portal
    -- bill of a resumed link is synced again (the sync is idempotent per bill).
    for link in
      update public.project_connections set status = 'active'
       where grant_id = new.id and status = 'paused'
      returning id, org_id, source_org_id, source_project_id, source_company_id
    loop
      insert into public.outbox (org_id, job_type, payload, dedupe_key)
      select link.org_id, 'sync_connected_receivable',
             jsonb_build_object('connection_id', link.id, 'source_bill_id', b.id),
             'sync_connected_receivable:' || b.id
        from public.vendor_bills b
       where b.org_id = link.source_org_id
         and b.project_id = link.source_project_id
         and b.company_id = link.source_company_id
         and coalesce(b.metadata ->> 'submitted_via_portal', 'false') = 'true'
      on conflict (org_id, dedupe_key) where ((status = 'pending') and (dedupe_key is not null)) do nothing;
    end loop;
  end if;
  return new;
end;
$$;

create trigger external_identity_grants_connections_follow
  after update of status on public.external_identity_grants
  for each row execute function public.tg_project_connections_follow_grant();

-- 2 ──────────────────────────────────────────────────────────────────────────
create or replace function public.tg_vendor_bills_enqueue_connected_receivable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  link record;
begin
  if coalesce(new.metadata ->> 'submitted_via_portal', 'false') <> 'true' or new.company_id is null or new.project_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.status is not distinct from old.status
     and new.total_cents is not distinct from old.total_cents
     and new.paid_cents is not distinct from old.paid_cents then
    return new;
  end if;
  for link in
    select id, org_id from public.project_connections
     where source_org_id = new.org_id
       and source_project_id = new.project_id
       and source_company_id = new.company_id
       and status = 'active'
  loop
    insert into public.outbox (org_id, job_type, payload, dedupe_key)
    values (
      link.org_id,
      'sync_connected_receivable',
      jsonb_build_object('connection_id', link.id, 'source_bill_id', new.id),
      'sync_connected_receivable:' || new.id
    )
    on conflict (org_id, dedupe_key) where ((status = 'pending') and (dedupe_key is not null)) do nothing;
  end loop;
  return new;
end;
$$;

create trigger vendor_bills_enqueue_connected_receivable
  after insert or update of status, total_cents, paid_cents on public.vendor_bills
  for each row execute function public.tg_vendor_bills_enqueue_connected_receivable();

-- 3 ──────────────────────────────────────────────────────────────────────────
create unique index invoices_connected_source_bill_unique on public.invoices
  (org_id, ((metadata -> 'connected_receivable' ->> 'source_bill_id')))
  where ((metadata -> 'connected_receivable' ->> 'source_bill_id') is not null and status <> 'void');

-- 4 ──────────────────────────────────────────────────────────────────────────
create table public.own_compliance_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  document_type_code text not null check (document_type_code in ('coi', 'w9', 'license', 'bond', 'workers_comp', 'auto_insurance', 'umbrella', 'business_license')),
  file_id uuid not null references public.files(id) on delete restrict,
  status text not null default 'current' check (status in ('current', 'superseded')),
  effective_date date,
  expiry_date date,
  carrier_name text,
  policy_number text,
  coverage_amount_cents bigint check (coverage_amount_cents is null or coverage_amount_cents >= 0),
  license_number text,
  license_jurisdiction text,
  license_classification text,
  additional_insured boolean not null default false,
  primary_noncontributory boolean not null default false,
  waiver_of_subrogation boolean not null default false,
  superseded_by_id uuid references public.own_compliance_documents(id) on delete set null,
  uploaded_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expiry_date is null or effective_date is null or expiry_date >= effective_date)
);

create unique index own_compliance_documents_one_current_idx on public.own_compliance_documents (org_id, document_type_code) where status = 'current';
create index own_compliance_documents_expiry_idx on public.own_compliance_documents (org_id, expiry_date) where status = 'current' and expiry_date is not null;
create index own_compliance_documents_file_idx on public.own_compliance_documents (file_id);

create trigger own_compliance_documents_set_updated_at before update on public.own_compliance_documents
  for each row execute function public.tg_set_updated_at();

alter table public.own_compliance_documents enable row level security;
create policy own_compliance_documents_read on public.own_compliance_documents for select
  using (((select auth.role()) = 'service_role') or public.has_org_permission(org_id, 'compliance.read'));
create policy own_compliance_documents_service_write on public.own_compliance_documents for all
  using ((select auth.role()) = 'service_role')
  with check ((select auth.role()) = 'service_role');
grant select on public.own_compliance_documents to authenticated;
grant all on public.own_compliance_documents to service_role;

alter table public.vendor_document_shares
  alter column source_document_id drop not null,
  add column source_own_document_id uuid references public.own_compliance_documents(id) on delete cascade,
  add constraint vendor_document_shares_one_source check (num_nonnulls(source_document_id, source_own_document_id) = 1);
create unique index vendor_document_shares_own_source_idx on public.vendor_document_shares (source_own_document_id, target_org_id) where source_own_document_id is not null;

commit;
