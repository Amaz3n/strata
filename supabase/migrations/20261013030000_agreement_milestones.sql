-- What has to happen between a signed purchase agreement and the closing table,
-- and the handoff from the closing table to warranty.
--
-- 1. agreement_milestones: one dated obligation on THIS buyer's agreement for
--    THIS home -- a contingency the buyer signed (financing, appraisal, sale of
--    their home) or a lender/title milestone the closing coordinator tracks
--    (loan application, approval, appraisal, title commitment, clear to close).
--    Each has an owner, a due date, dependencies and evidence, and is resolved
--    satisfied (with evidence where required), waived with a reason, or failed.
--    `required_before` decides what it holds: 'start' (the financing start
--    gate), 'closing' (clear to close and settlement), or null (tracked only).
--    Every change is kept in agreement_milestone_history.
-- 2. Executing a purchase agreement seeds its milestones once: the signed
--    contingencies in snapshot.purchase_agreement.contingencies, and the
--    lender/title set for its financing (snapshot.purchase_agreement.financing,
--    'cash' or 'financed'; financed when the agreement does not say).
-- 3. A closing cannot reach cleared_to_close or closed while a milestone of the
--    home's active agreement required before closing is open or failed.
-- 4. Lenders and title companies post updates to a signed endpoint. A source
--    holds a per-org HMAC secret encrypted by the application; every signed
--    delivery is kept with its outcome. A report reconciles to the agreement by
--    number, the buyer by email and the home by lot; anything that does not
--    match is refused, stored and visible. An external "satisfied" resolves a
--    milestone only when it needs no evidence; otherwise it is "reported" until
--    a coordinator attaches the evidence.
-- 5. The final inspection / certificate of occupancy gate needs its evidence
--    file and cannot be waived. Checklist items get a stable key.
-- 6. Warranty: the program is bound to the agreement when it is executed, and a
--    reversed closing voids the home's coverage so re-closing enrolls again.
--    One live coverage per home.
-- 7. The financing start gate is automatic: it holds a start while a milestone
--    required before start is open or failed.
-- 8. The bookkeeper settles closings (closing.manage) and now reads them.

set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. Milestones, their dependencies and their history.
-- ---------------------------------------------------------------------------

create table if not exists public.agreement_milestone_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null,
  -- Sent by the caller in x-arc-source; not a credential.
  public_id text not null unique,
  signing_secret_encrypted text not null,
  previous_secret_encrypted text,
  previous_secret_expires_at timestamptz,
  secret_hint text not null,
  status text not null default 'active',
  last_received_at timestamptz,
  last_rejected_at timestamptz,
  last_rejection_reason text,
  rejected_count integer not null default 0,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agreement_milestone_sources_status_check check (status in ('active', 'disabled')),
  constraint agreement_milestone_sources_name_check check (length(btrim(name)) between 1 and 120),
  constraint agreement_milestone_sources_public_id_check check (public_id ~ '^ams_[a-z2-7]{24}$'),
  constraint agreement_milestone_sources_previous_check
    check ((previous_secret_encrypted is null) = (previous_secret_expires_at is null)),
  constraint agreement_milestone_sources_rejection_check
    check (last_rejection_reason is null or last_rejection_reason in ('missing_signature', 'stale_timestamp', 'bad_signature'))
);

create index if not exists agreement_milestone_sources_org_idx on public.agreement_milestone_sources (org_id, status);
create index if not exists agreement_milestone_sources_created_by_idx
  on public.agreement_milestone_sources (created_by) where created_by is not null;

create table if not exists public.agreement_milestone_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  source_id uuid not null references public.agreement_milestone_sources(id) on delete cascade,
  delivery_id text not null,
  received_at timestamptz not null default now(),
  payload_digest text not null,
  payload jsonb not null,
  outcome text not null,
  reason_code text,
  contract_id uuid references public.contracts(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  milestone_id uuid,
  unique (source_id, delivery_id),
  constraint agreement_milestone_deliveries_outcome_check check (outcome in ('applied', 'reported', 'refused')),
  constraint agreement_milestone_deliveries_reason_check check (
    (outcome = 'refused') = (reason_code is not null)
    and (reason_code is null or reason_code in (
      'invalid_payload', 'agreement_unknown', 'agreement_not_active', 'buyer_mismatch', 'home_mismatch',
      'milestone_unknown', 'milestone_resolved', 'stale'
    ))
  ),
  constraint agreement_milestone_deliveries_delivery_check check (length(delivery_id) between 1 and 200),
  constraint agreement_milestone_deliveries_payload_check check (jsonb_typeof(payload) = 'object')
);

create index if not exists agreement_milestone_deliveries_org_idx
  on public.agreement_milestone_deliveries (org_id, received_at desc);
create index if not exists agreement_milestone_deliveries_project_idx
  on public.agreement_milestone_deliveries (org_id, project_id, received_at desc) where project_id is not null;
create index if not exists agreement_milestone_deliveries_contract_idx
  on public.agreement_milestone_deliveries (contract_id) where contract_id is not null;
create index if not exists agreement_milestone_deliveries_project_fk_idx
  on public.agreement_milestone_deliveries (project_id) where project_id is not null;
create index if not exists agreement_milestone_deliveries_milestone_idx
  on public.agreement_milestone_deliveries (milestone_id) where milestone_id is not null;

create table if not exists public.agreement_milestones (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  contract_id uuid not null references public.contracts(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  buyer_contact_id uuid references public.contacts(id) on delete set null,
  template_key text not null,
  kind text not null,
  title text not null,
  is_contingency boolean not null default false,
  source text not null default 'manual',
  required_before text,
  due_on date,
  owner_user_id uuid references public.app_users(id) on delete set null,
  owner_company_id uuid references public.companies(id) on delete set null,
  evidence_required boolean not null default false,
  status text not null default 'open',
  resolved_on date,
  resolved_at timestamptz,
  resolved_by uuid references public.app_users(id) on delete set null,
  resolution_note text,
  evidence_file_id uuid references public.files(id) on delete restrict,
  reported_status text,
  reported_on date,
  reported_at timestamptz,
  reported_delivery_id uuid references public.agreement_milestone_deliveries(id) on delete set null,
  reported_reference text,
  -- Why this change was made; copied into the history row it produces.
  change_reason text,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  updated_by uuid references public.app_users(id) on delete set null,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contract_id, template_key),
  constraint agreement_milestones_kind_check check (kind in (
    'financing', 'appraisal', 'home_sale', 'inspection', 'loan_application', 'loan_approval',
    'title_commitment', 'survey', 'hoa_estoppel', 'clear_to_close', 'other'
  )),
  constraint agreement_milestones_source_check check (source in ('agreement', 'manual')),
  constraint agreement_milestones_required_before_check check (required_before is null or required_before in ('start', 'closing')),
  constraint agreement_milestones_status_check check (status in ('open', 'satisfied', 'waived', 'failed')),
  constraint agreement_milestones_resolution_check check ((status = 'open') = (resolved_at is null) and (status = 'open') = (resolved_on is null)),
  constraint agreement_milestones_reason_check
    check (status not in ('waived', 'failed') or length(btrim(coalesce(resolution_note, ''))) >= 10),
  constraint agreement_milestones_evidence_check
    check (status <> 'satisfied' or not evidence_required or evidence_file_id is not null),
  constraint agreement_milestones_reported_check check (
    (reported_status is null or reported_status in ('in_progress', 'satisfied', 'failed'))
    and (reported_status is null) = (reported_at is null)
  ),
  constraint agreement_milestones_title_check check (length(btrim(title)) between 1 and 200),
  constraint agreement_milestones_text_check check (
    (resolution_note is null or length(resolution_note) <= 2000)
    and (change_reason is null or length(change_reason) <= 2000)
    and (reported_reference is null or length(reported_reference) <= 200)
  ),
  constraint agreement_milestones_metadata_check check (jsonb_typeof(metadata) = 'object')
);

alter table public.agreement_milestone_deliveries
  drop constraint if exists agreement_milestone_deliveries_milestone_fkey;
alter table public.agreement_milestone_deliveries
  add constraint agreement_milestone_deliveries_milestone_fkey
  foreign key (milestone_id) references public.agreement_milestones(id) on delete set null;

create index if not exists agreement_milestones_org_project_idx on public.agreement_milestones (org_id, project_id);
create index if not exists agreement_milestones_org_contract_idx on public.agreement_milestones (org_id, contract_id);
create index if not exists agreement_milestones_project_idx on public.agreement_milestones (project_id);
create index if not exists agreement_milestones_due_idx
  on public.agreement_milestones (org_id, due_on) where status = 'open' and due_on is not null;
create index if not exists agreement_milestones_gate_idx
  on public.agreement_milestones (org_id, project_id, required_before) where status in ('open', 'failed');
create index if not exists agreement_milestones_buyer_idx
  on public.agreement_milestones (buyer_contact_id) where buyer_contact_id is not null;
create index if not exists agreement_milestones_owner_idx
  on public.agreement_milestones (owner_user_id) where owner_user_id is not null;
create index if not exists agreement_milestones_company_idx
  on public.agreement_milestones (owner_company_id) where owner_company_id is not null;
create index if not exists agreement_milestones_evidence_idx
  on public.agreement_milestones (evidence_file_id) where evidence_file_id is not null;
create index if not exists agreement_milestones_delivery_idx
  on public.agreement_milestones (reported_delivery_id) where reported_delivery_id is not null;
create index if not exists agreement_milestones_resolved_by_idx
  on public.agreement_milestones (resolved_by) where resolved_by is not null;
create index if not exists agreement_milestones_updated_by_idx
  on public.agreement_milestones (updated_by) where updated_by is not null;
create index if not exists agreement_milestones_created_by_idx
  on public.agreement_milestones (created_by) where created_by is not null;

create table if not exists public.agreement_milestone_dependencies (
  org_id uuid not null references public.orgs(id) on delete cascade,
  milestone_id uuid not null references public.agreement_milestones(id) on delete cascade,
  depends_on_id uuid not null references public.agreement_milestones(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (milestone_id, depends_on_id),
  constraint agreement_milestone_dependencies_self_check check (milestone_id <> depends_on_id)
);

create index if not exists agreement_milestone_dependencies_depends_idx
  on public.agreement_milestone_dependencies (depends_on_id);
create index if not exists agreement_milestone_dependencies_org_idx
  on public.agreement_milestone_dependencies (org_id, milestone_id);

create table if not exists public.agreement_milestone_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  milestone_id uuid not null references public.agreement_milestones(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  source text not null,
  from_status text,
  to_status text not null,
  from_due_on date,
  to_due_on date,
  reported_status text,
  delivery_id uuid references public.agreement_milestone_deliveries(id) on delete set null,
  actor_id uuid references public.app_users(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  constraint agreement_milestone_history_source_check check (source in ('materialized', 'manual', 'external'))
);

create index if not exists agreement_milestone_history_milestone_idx
  on public.agreement_milestone_history (org_id, milestone_id, created_at);
create index if not exists agreement_milestone_history_milestone_fk_idx
  on public.agreement_milestone_history (milestone_id);
create index if not exists agreement_milestone_history_project_idx
  on public.agreement_milestone_history (project_id);
create index if not exists agreement_milestone_history_delivery_idx
  on public.agreement_milestone_history (delivery_id) where delivery_id is not null;
create index if not exists agreement_milestone_history_actor_idx
  on public.agreement_milestone_history (actor_id) where actor_id is not null;

-- A milestone belongs to one purchase agreement and that agreement's home and
-- buyer; what the buyer signed (an agreement-sourced row's kind, gate and
-- evidence rule) is fixed; a satisfied milestone has every prerequisite resolved
-- and its evidence on the home; nothing on a void agreement or a closed home moves.
create or replace function public.guard_agreement_milestone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contract public.contracts%rowtype;
  v_open_prerequisite text;
begin
  if tg_op = 'DELETE' then
    -- The agreement went away (a draft deleted) and took its rows with it.
    if pg_trigger_depth() > 1 and not exists (select 1 from public.contracts c where c.id = old.contract_id) then
      return old;
    end if;
    raise exception 'An agreement milestone is a record; waive it with a reason instead of deleting it' using errcode = '42501';
  end if;

  select * into v_contract from public.contracts c where c.id = new.contract_id;
  if not found or v_contract.org_id is distinct from new.org_id or v_contract.contract_type is distinct from 'purchase_agreement' then
    raise exception 'A milestone belongs to a purchase agreement in this organization' using errcode = '23503';
  end if;

  -- A reminder marker is bookkeeping, not a change to the obligation.
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'metadata' - 'updated_at') = (to_jsonb(old) - 'metadata' - 'updated_at') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.project_id := v_contract.project_id;
    new.buyer_contact_id := v_contract.buyer_contact_id;
    new.version := 1;
    if v_contract.status <> 'active' then
      raise exception 'Milestones are tracked on an executed purchase agreement' using errcode = '23514';
    end if;
  else
    if (new.id, new.org_id, new.contract_id, new.project_id, new.template_key, new.source, new.kind, new.created_by, new.created_at)
       is distinct from (old.id, old.org_id, old.contract_id, old.project_id, old.template_key, old.source, old.kind, old.created_by, old.created_at)
       or new.buyer_contact_id is distinct from old.buyer_contact_id then
      raise exception 'A milestone stays with its agreement, home and buyer' using errcode = '42501';
    end if;
    if old.source = 'agreement'
       and (new.is_contingency, new.required_before, new.evidence_required)
           is distinct from (old.is_contingency, old.required_before, old.evidence_required) then
      raise exception 'A signed contingency''s terms change only by amending the agreement' using errcode = '42501';
    end if;
    if old.source = 'agreement' and new.due_on is distinct from old.due_on
       and length(btrim(coalesce(new.change_reason, ''))) < 10 then
      raise exception 'Extending a signed contingency needs a reason of at least 10 characters' using errcode = '23514';
    end if;
    if v_contract.status = 'void' then
      raise exception 'The agreement is void; its milestones are closed' using errcode = '42501';
    end if;
    if exists (select 1 from public.closings cl where cl.org_id = new.org_id and cl.project_id = new.project_id and cl.status = 'closed') then
      raise exception 'The home has closed; its milestones are a record' using errcode = '42501';
    end if;
    new.version := old.version + 1;
  end if;

  if new.project_id is null or new.project_id is distinct from v_contract.project_id then
    raise exception 'A milestone belongs to its agreement''s home' using errcode = '23514';
  end if;
  if new.owner_user_id is not null
     and not exists (select 1 from public.memberships m where m.user_id = new.owner_user_id and m.org_id = new.org_id) then
    raise exception 'The owner is not a member of this organization' using errcode = '23503';
  end if;
  if new.owner_company_id is not null
     and not exists (select 1 from public.companies c where c.id = new.owner_company_id and c.org_id = new.org_id) then
    raise exception 'The company does not belong to this organization' using errcode = '23503';
  end if;
  if new.evidence_file_id is not null
     and (tg_op = 'INSERT' or new.evidence_file_id is distinct from old.evidence_file_id)
     and not exists (
       select 1 from public.files f
       where f.id = new.evidence_file_id and f.org_id = new.org_id and f.project_id = new.project_id and f.archived_at is null
     ) then
    raise exception 'Milestone evidence must be a file on this home' using errcode = '23514';
  end if;

  if new.status = 'satisfied' and (tg_op = 'INSERT' or old.status is distinct from 'satisfied') then
    select m.title into v_open_prerequisite
    from public.agreement_milestone_dependencies d
    join public.agreement_milestones m on m.id = d.depends_on_id
    where d.milestone_id = new.id and m.status not in ('satisfied', 'waived')
    order by m.sort_order, m.title
    limit 1;
    if v_open_prerequisite is not null then
      raise exception 'Resolve % first; this milestone depends on it', v_open_prerequisite using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_agreement_milestone() from public, anon, authenticated;

drop trigger if exists agreement_milestones_guard on public.agreement_milestones;
create trigger agreement_milestones_guard
  before insert or update or delete on public.agreement_milestones
  for each row execute function public.guard_agreement_milestone();

drop trigger if exists agreement_milestones_set_updated_at on public.agreement_milestones;
create trigger agreement_milestones_set_updated_at
  before update on public.agreement_milestones
  for each row execute function public.tg_set_updated_at();

drop trigger if exists agreement_milestone_sources_set_updated_at on public.agreement_milestone_sources;
create trigger agreement_milestone_sources_set_updated_at
  before update on public.agreement_milestone_sources
  for each row execute function public.tg_set_updated_at();

-- Every status, due-date and external report change leaves a row.
create or replace function public.tg_agreement_milestone_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source text;
begin
  if tg_op = 'UPDATE'
     and new.status is not distinct from old.status
     and new.due_on is not distinct from old.due_on
     and new.reported_delivery_id is not distinct from old.reported_delivery_id
     and new.owner_user_id is not distinct from old.owner_user_id
     and new.owner_company_id is not distinct from old.owner_company_id
     and new.evidence_file_id is not distinct from old.evidence_file_id then
    return null;
  end if;
  v_source := case
    when tg_op = 'INSERT' and new.source = 'agreement' then 'materialized'
    when tg_op = 'UPDATE' and new.reported_delivery_id is distinct from old.reported_delivery_id then 'external'
    else 'manual'
  end;
  insert into public.agreement_milestone_history (
    org_id, milestone_id, project_id, source, from_status, to_status, from_due_on, to_due_on,
    reported_status, delivery_id, actor_id, note
  ) values (
    new.org_id, new.id, new.project_id, v_source,
    case when tg_op = 'UPDATE' then old.status end, new.status,
    case when tg_op = 'UPDATE' then old.due_on end, new.due_on,
    case when v_source = 'external' then new.reported_status end,
    case when v_source = 'external' then new.reported_delivery_id end,
    case when v_source = 'external' then null when tg_op = 'INSERT' then new.created_by else new.updated_by end,
    case
      when tg_op = 'UPDATE' and new.status is distinct from old.status and new.status <> 'open' then new.resolution_note
      else new.change_reason
    end
  );
  return null;
end;
$$;

revoke all on function public.tg_agreement_milestone_history() from public, anon, authenticated;

drop trigger if exists agreement_milestones_history on public.agreement_milestones;
create trigger agreement_milestones_history
  after insert or update on public.agreement_milestones
  for each row execute function public.tg_agreement_milestone_history();

-- History and deliveries are append-only.
create or replace function public.guard_agreement_milestone_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end;
$$;

revoke all on function public.guard_agreement_milestone_append_only() from public, anon, authenticated;

drop trigger if exists agreement_milestone_history_append_only on public.agreement_milestone_history;
create trigger agreement_milestone_history_append_only
  before update or delete on public.agreement_milestone_history
  for each row execute function public.guard_agreement_milestone_append_only();

drop trigger if exists agreement_milestone_deliveries_append_only on public.agreement_milestone_deliveries;
create trigger agreement_milestone_deliveries_append_only
  before update or delete on public.agreement_milestone_deliveries
  for each row execute function public.guard_agreement_milestone_append_only();

-- A prerequisite is on the same agreement and never loops back.
create or replace function public.guard_agreement_milestone_dependency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_milestone public.agreement_milestones%rowtype;
  v_prerequisite public.agreement_milestones%rowtype;
begin
  if tg_op = 'DELETE' then
    if pg_trigger_depth() > 1 then return old; end if;
    raise exception 'A milestone''s prerequisites are fixed once recorded' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'A milestone''s prerequisites are fixed once recorded' using errcode = '42501';
  end if;
  select * into v_milestone from public.agreement_milestones m where m.id = new.milestone_id;
  select * into v_prerequisite from public.agreement_milestones m where m.id = new.depends_on_id;
  if v_milestone.id is null or v_prerequisite.id is null
     or v_milestone.org_id is distinct from new.org_id or v_prerequisite.org_id is distinct from new.org_id
     or v_milestone.contract_id is distinct from v_prerequisite.contract_id then
    raise exception 'A prerequisite is a milestone on the same agreement' using errcode = '23514';
  end if;
  if exists (
    with recursive chain(id) as (
      select d.depends_on_id from public.agreement_milestone_dependencies d where d.milestone_id = new.depends_on_id
      union
      select d.depends_on_id from public.agreement_milestone_dependencies d join chain on d.milestone_id = chain.id
    )
    select 1 from chain where chain.id = new.milestone_id
  ) then
    raise exception 'Milestone prerequisites cannot form a loop' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_agreement_milestone_dependency() from public, anon, authenticated;

drop trigger if exists agreement_milestone_dependencies_guard on public.agreement_milestone_dependencies;
create trigger agreement_milestone_dependencies_guard
  before insert or update or delete on public.agreement_milestone_dependencies
  for each row execute function public.guard_agreement_milestone_dependency();

-- Row security. Milestones are closing work: read with sales.read, recorded
-- with closing.manage, walled by the home's division. Only coordinators add
-- rows by hand; the agreement's own rows come from execution. History and
-- dependencies are written by triggers and the seeding function.
alter table public.agreement_milestones enable row level security;
alter table public.agreement_milestone_dependencies enable row level security;
alter table public.agreement_milestone_history enable row level security;
alter table public.agreement_milestone_sources enable row level security;
alter table public.agreement_milestone_deliveries enable row level security;

drop policy if exists agreement_milestones_read on public.agreement_milestones;
create policy agreement_milestones_read on public.agreement_milestones
  for select to authenticated
  using (public.has_org_permission(org_id, 'sales.read'));

drop policy if exists agreement_milestones_insert on public.agreement_milestones;
create policy agreement_milestones_insert on public.agreement_milestones
  for insert to authenticated
  with check (
    public.has_org_permission(org_id, 'closing.manage')
    and source = 'manual'
    and status = 'open'
    and reported_status is null
    and (created_by is null or created_by = (select auth.uid()))
  );

drop policy if exists agreement_milestones_update on public.agreement_milestones;
create policy agreement_milestones_update on public.agreement_milestones
  for update to authenticated
  using (public.has_org_permission(org_id, 'closing.manage'))
  with check (
    public.has_org_permission(org_id, 'closing.manage')
    and (updated_by is null or updated_by = (select auth.uid()))
    and (resolved_by is null or resolved_by = (select auth.uid()) or status = 'open')
  );

drop policy if exists agreement_milestone_dependencies_read on public.agreement_milestone_dependencies;
create policy agreement_milestone_dependencies_read on public.agreement_milestone_dependencies
  for select to authenticated
  using (public.has_org_permission(org_id, 'sales.read'));

drop policy if exists agreement_milestone_dependencies_insert on public.agreement_milestone_dependencies;
create policy agreement_milestone_dependencies_insert on public.agreement_milestone_dependencies
  for insert to authenticated
  with check (public.has_org_permission(org_id, 'closing.manage'));

drop policy if exists agreement_milestone_history_read on public.agreement_milestone_history;
create policy agreement_milestone_history_read on public.agreement_milestone_history
  for select to authenticated
  using (public.has_org_permission(org_id, 'sales.read'));

drop policy if exists agreement_milestone_sources_read on public.agreement_milestone_sources;
create policy agreement_milestone_sources_read on public.agreement_milestone_sources
  for select to authenticated
  using (public.has_org_permission(org_id, 'org.settings.update'));

-- A delivery that reached a home is that home's closing record; one that never
-- matched a home is an integration fault for whoever runs the integration.
drop policy if exists agreement_milestone_deliveries_read on public.agreement_milestone_deliveries;
create policy agreement_milestone_deliveries_read on public.agreement_milestone_deliveries
  for select to authenticated
  using (
    public.has_org_permission(org_id, 'org.settings.update')
    or (project_id is not null and public.has_org_permission(org_id, 'closing.manage'))
  );

do $$
declare
  v_table text;
begin
  foreach v_table in array array['agreement_milestones', 'agreement_milestone_history'] loop
    execute format('drop policy if exists %I on public.%I', v_table || '_division_scope', v_table);
    execute format(
      'create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)',
      v_table || '_division_scope', v_table,
      $clause$(org_id = any ((select public.member_unscoped_org_ids())::uuid[])
        or project_id in (select public.member_reachable_project_ids()))$clause$,
      $clause$(org_id = any ((select public.member_unscoped_org_ids())::uuid[])
        or project_id in (select public.member_reachable_project_ids()))$clause$
    );
  end loop;
end
$$;

drop policy if exists agreement_milestone_deliveries_division_scope on public.agreement_milestone_deliveries;
create policy agreement_milestone_deliveries_division_scope on public.agreement_milestone_deliveries
  as restrictive for all to authenticated
  using (
    project_id is null
    or org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or project_id in (select public.member_reachable_project_ids())
  );

drop policy if exists agreement_milestone_dependencies_division_scope on public.agreement_milestone_dependencies;
create policy agreement_milestone_dependencies_division_scope on public.agreement_milestone_dependencies
  as restrictive for all to authenticated
  using (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or milestone_id in (
      select m.id from public.agreement_milestones m where m.project_id in (select public.member_reachable_project_ids())
    )
  )
  with check (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or milestone_id in (
      select m.id from public.agreement_milestones m where m.project_id in (select public.member_reachable_project_ids())
    )
  );

revoke all on table public.agreement_milestones from anon, authenticated;
grant select, insert, update on table public.agreement_milestones to authenticated;
grant all on table public.agreement_milestones to service_role;

revoke all on table public.agreement_milestone_dependencies from anon, authenticated;
grant select, insert on table public.agreement_milestone_dependencies to authenticated;
grant all on table public.agreement_milestone_dependencies to service_role;

revoke all on table public.agreement_milestone_history from anon, authenticated;
grant select on table public.agreement_milestone_history to authenticated;
grant all on table public.agreement_milestone_history to service_role;

-- The encrypted secrets are never readable by a member; the service writes them.
revoke all on table public.agreement_milestone_sources from anon, authenticated;
grant select (
  id, org_id, name, public_id, secret_hint, status, previous_secret_expires_at, last_received_at,
  last_rejected_at, last_rejection_reason, rejected_count, created_by, created_at, updated_at
) on table public.agreement_milestone_sources to authenticated;
grant all on table public.agreement_milestone_sources to service_role;

revoke all on table public.agreement_milestone_deliveries from anon, authenticated;
grant select on table public.agreement_milestone_deliveries to authenticated;
grant all on table public.agreement_milestone_deliveries to service_role;

-- ---------------------------------------------------------------------------
-- 2. Executing an agreement seeds its milestones, and binds its warranty program.
-- ---------------------------------------------------------------------------

alter table public.contracts
  add column if not exists warranty_program_id uuid references public.warranty_programs(id) on delete restrict;

create index if not exists contracts_warranty_program_idx
  on public.contracts (warranty_program_id) where warranty_program_id is not null;

comment on column public.contracts.warranty_program_id is
  'The warranty program a purchase agreement sold, bound when it is executed. Closing enrolls the home in it.';

create or replace function public.tg_contract_bind_warranty_program()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.warranty_program_id is not null
     and new.warranty_program_id is distinct from old.warranty_program_id then
    raise exception 'The warranty program an agreement sold cannot change' using errcode = '42501';
  end if;
  if new.contract_type = 'purchase_agreement' and new.status = 'active' and new.warranty_program_id is null then
    select p.id into new.warranty_program_id
    from public.warranty_programs p
    where p.org_id = new.org_id and p.is_default and p.is_active
    order by p.id
    limit 1;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_contract_bind_warranty_program() from public, anon, authenticated;

drop trigger if exists contracts_bind_warranty_program on public.contracts;
create trigger contracts_bind_warranty_program
  before insert or update of status, warranty_program_id on public.contracts
  for each row execute function public.tg_contract_bind_warranty_program();

-- Seeds one agreement's milestones. Idempotent on (agreement, template key), so
-- a retried execution or a re-run adds nothing.
create or replace function public.seed_agreement_milestones(p_contract_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contract public.contracts%rowtype;
  v_terms jsonb;
  v_financed boolean;
  v_base date;
  v_term jsonb;
  v_ordinal integer;
  v_kind text;
  v_count integer := 0;
  v_inserted integer;
  v_key text;
begin
  select * into v_contract from public.contracts c where c.id = p_contract_id;
  if not found or v_contract.contract_type <> 'purchase_agreement' or v_contract.status <> 'active' then
    return 0;
  end if;
  v_terms := coalesce(v_contract.snapshot -> 'purchase_agreement', '{}'::jsonb);
  v_financed := coalesce(v_terms ->> 'financing', 'financed') <> 'cash';
  v_base := coalesce((v_contract.signed_at at time zone 'UTC')::date, current_date);

  -- The lender and title milestones a closing coordinator chases.
  with defaults(template_key, kind, title, required_before, due_days, evidence_required, sort_order) as (
    values
      ('lender:loan_application', 'loan_application', 'Loan application submitted', null, 5, false, 10),
      ('lender:appraisal', 'appraisal', 'Appraisal received', 'closing', 21, true, 20),
      ('lender:loan_approval', 'loan_approval', 'Loan approval issued', 'closing', 30, true, 30),
      ('title:title_commitment', 'title_commitment', 'Title commitment issued', 'closing', 30, true, 40),
      ('lender:clear_to_close', 'clear_to_close', 'Lender clear to close', 'closing', null, true, 50)
  )
  insert into public.agreement_milestones (
    org_id, contract_id, project_id, template_key, kind, title, is_contingency, source, required_before,
    due_on, evidence_required, sort_order
  )
  select v_contract.org_id, v_contract.id, v_contract.project_id, d.template_key, d.kind, d.title, false, 'agreement',
    d.required_before, case when d.due_days is null then null else v_base + d.due_days end, d.evidence_required, d.sort_order
  from defaults d
  where v_financed or d.kind = 'title_commitment'
  on conflict (contract_id, template_key) do nothing;
  get diagnostics v_inserted = row_count;
  v_count := v_count + v_inserted;

  -- The contingencies the buyer signed.
  for v_term, v_ordinal in
    select value, ordinality::integer from jsonb_array_elements(
      case when jsonb_typeof(v_terms -> 'contingencies') = 'array' then v_terms -> 'contingencies' else '[]'::jsonb end
    ) with ordinality
  loop
    v_kind := coalesce(v_term ->> 'kind', 'other');
    if v_kind not in ('financing', 'appraisal', 'home_sale', 'inspection', 'survey', 'hoa_estoppel', 'other') then
      v_kind := 'other';
    end if;
    v_key := 'contingency:' || coalesce(nullif(btrim(v_term ->> 'key'), ''), v_kind || ':' || v_ordinal::text);
    insert into public.agreement_milestones (
      org_id, contract_id, project_id, template_key, kind, title, is_contingency, source, required_before,
      due_on, evidence_required, sort_order
    ) values (
      v_contract.org_id, v_contract.id, v_contract.project_id, v_key, v_kind,
      left(coalesce(nullif(btrim(v_term ->> 'title'), ''), initcap(replace(v_kind, '_', ' ')) || ' contingency'), 200),
      true, 'agreement',
      case when v_term ->> 'required_before' = 'start' then 'start' else 'closing' end,
      case
        when v_term ->> 'due_on' ~ '^\d{4}-\d{2}-\d{2}$' then (v_term ->> 'due_on')::date
        when v_term ->> 'due_in_days' ~ '^\d{1,3}$' then v_base + (v_term ->> 'due_in_days')::integer
      end,
      coalesce((v_term ->> 'evidence_required')::boolean, true),
      100 + v_ordinal
    )
    on conflict (contract_id, template_key) do nothing;
    get diagnostics v_inserted = row_count;
    v_count := v_count + v_inserted;
  end loop;

  -- Loan approval follows the application; clear to close follows the
  -- approval, the appraisal and the title commitment.
  insert into public.agreement_milestone_dependencies (org_id, milestone_id, depends_on_id)
  select v_contract.org_id, m.id, p.id
  from (values
    ('lender:loan_approval', 'lender:loan_application'),
    ('lender:clear_to_close', 'lender:loan_approval'),
    ('lender:clear_to_close', 'lender:appraisal'),
    ('lender:clear_to_close', 'title:title_commitment')
  ) as edge(milestone_key, prerequisite_key)
  join public.agreement_milestones m on m.contract_id = v_contract.id and m.template_key = edge.milestone_key
  join public.agreement_milestones p on p.contract_id = v_contract.id and p.template_key = edge.prerequisite_key
  on conflict (milestone_id, depends_on_id) do nothing;

  return v_count;
end;
$$;

revoke all on function public.seed_agreement_milestones(uuid) from public, anon, authenticated;
grant execute on function public.seed_agreement_milestones(uuid) to service_role;

create or replace function public.tg_contract_seed_agreement_milestones()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.contract_type = 'purchase_agreement' and new.status = 'active'
     and (tg_op = 'INSERT' or old.status is distinct from 'active') then
    perform public.seed_agreement_milestones(new.id);
  end if;
  return null;
end;
$$;

revoke all on function public.tg_contract_seed_agreement_milestones() from public, anon, authenticated;

drop trigger if exists contracts_seed_agreement_milestones on public.contracts;
create trigger contracts_seed_agreement_milestones
  after insert or update of status on public.contracts
  for each row execute function public.tg_contract_seed_agreement_milestones();

-- ---------------------------------------------------------------------------
-- 3. The closing backstop.
-- ---------------------------------------------------------------------------

create or replace function public.guard_closing_agreement_milestones()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_blocker record;
begin
  if new.status in ('cleared_to_close', 'closed') and (tg_op = 'INSERT' or new.status is distinct from old.status) then
    select m.title, m.status into v_blocker
    from public.agreement_milestones m
    join public.contracts c on c.id = m.contract_id
    where m.org_id = new.org_id and m.project_id = new.project_id
      and c.contract_type = 'purchase_agreement' and c.status = 'active'
      and m.required_before = 'closing' and m.status in ('open', 'failed')
    order by m.sort_order, m.title
    limit 1;
    if found then
      raise exception 'Resolve the % milestone before closing (it is %)', v_blocker.title, v_blocker.status
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_closing_agreement_milestones() from public, anon, authenticated;

drop trigger if exists closing_agreement_milestones on public.closings;
create trigger closing_agreement_milestones
  before insert or update of status on public.closings
  for each row execute function public.guard_closing_agreement_milestones();

-- ---------------------------------------------------------------------------
-- 4. Signed external updates.
-- ---------------------------------------------------------------------------

-- Called by the inbound route as service_role after it verified the signature.
-- Records the delivery once per (source, delivery id) and reconciles it to the
-- agreement, the buyer and the home; a mismatch is refused and kept.
create or replace function public.apply_agreement_milestone_report(
  p_source_id uuid,
  p_delivery_id text,
  p_digest text,
  p_payload jsonb,
  p_invalid_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source public.agreement_milestone_sources%rowtype;
  v_existing public.agreement_milestone_deliveries%rowtype;
  v_contract public.contracts%rowtype;
  v_milestone public.agreement_milestones%rowtype;
  v_lot_number text;
  v_community text;
  v_reason text := p_invalid_reason;
  v_outcome text;
  v_delivery uuid := gen_random_uuid();
  v_email text := lower(btrim(coalesce(p_payload ->> 'buyer_email', '')));
  v_status text := p_payload ->> 'status';
  v_reported_on date;
  v_resolves boolean := false;
begin
  if p_invalid_reason is not null and p_invalid_reason <> 'invalid_payload' then
    raise exception 'Unknown refusal reason' using errcode = '22023';
  end if;
  if p_digest is null or p_digest !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'Invalid milestone delivery' using errcode = '22023';
  end if;
  select * into v_source from public.agreement_milestone_sources s where s.id = p_source_id for update;
  if not found or v_source.status <> 'active' then
    raise exception 'Milestone source is unavailable' using errcode = '42501';
  end if;

  select * into v_existing from public.agreement_milestone_deliveries d
  where d.source_id = p_source_id and d.delivery_id = p_delivery_id;
  if found then
    if v_existing.payload_digest <> p_digest then
      return jsonb_build_object('outcome', 'conflict', 'reason_code', 'delivery_conflict');
    end if;
    return jsonb_build_object('outcome', 'duplicate', 'original_outcome', v_existing.outcome,
      'reason_code', v_existing.reason_code, 'milestone_id', v_existing.milestone_id, 'delivery_id', v_existing.id);
  end if;
  update public.agreement_milestone_sources set last_received_at = now() where id = v_source.id;

  if v_reason is null then
    select * into v_contract from public.contracts c
    where c.org_id = v_source.org_id and c.contract_type = 'purchase_agreement'
      and c.number = btrim(coalesce(p_payload ->> 'agreement_number', ''))
    order by (c.status = 'active') desc, c.created_at desc
    limit 1;
    if not found then
      v_reason := 'agreement_unknown';
    elsif v_contract.status <> 'active' then
      v_reason := 'agreement_not_active';
    elsif v_email = '' or not exists (
      select 1 from public.contacts ct
      where ct.org_id = v_source.org_id
        and ct.id in (v_contract.buyer_contact_id, v_contract.co_buyer_contact_id)
        and lower(btrim(ct.email)) = v_email
    ) then
      v_reason := 'buyer_mismatch';
    else
      select l.lot_number, cm.name into v_lot_number, v_community
      from public.lots l
      left join public.communities cm on cm.id = l.community_id
      where l.org_id = v_source.org_id and l.project_id = v_contract.project_id
      order by l.id
      limit 1;
      if v_lot_number is null
         or lower(btrim(v_lot_number)) <> lower(btrim(coalesce(p_payload ->> 'lot_number', '')))
         or (nullif(btrim(coalesce(p_payload ->> 'community', '')), '') is not null
             and lower(btrim(coalesce(v_community, ''))) <> lower(btrim(p_payload ->> 'community'))) then
        v_reason := 'home_mismatch';
      else
        select * into v_milestone from public.agreement_milestones m
        where m.contract_id = v_contract.id and m.kind = p_payload ->> 'milestone'
        order by (m.status = 'open') desc, m.sort_order, m.created_at
        limit 1
        for update;
        v_reported_on := (p_payload ->> 'reported_on')::date;
        if not found then
          v_reason := 'milestone_unknown';
        elsif v_milestone.status <> 'open' then
          v_reason := 'milestone_resolved';
        elsif v_milestone.reported_on is not null and v_reported_on < v_milestone.reported_on then
          v_reason := 'stale';
        end if;
      end if;
    end if;
  end if;

  if v_reason is null then
    -- A person outranks the feed: an external "satisfied" closes a milestone
    -- only when it needs no evidence and nothing it depends on is open.
    v_resolves := v_status = 'satisfied' and not v_milestone.evidence_required
      and not exists (
        select 1 from public.agreement_milestone_dependencies d
        join public.agreement_milestones p on p.id = d.depends_on_id
        where d.milestone_id = v_milestone.id and p.status not in ('satisfied', 'waived')
      );
    v_outcome := case when v_resolves then 'applied' else 'reported' end;
  else
    v_outcome := 'refused';
  end if;

  insert into public.agreement_milestone_deliveries (
    id, org_id, source_id, delivery_id, payload_digest, payload, outcome, reason_code, contract_id, project_id, milestone_id
  ) values (
    v_delivery, v_source.org_id, v_source.id, p_delivery_id, p_digest, p_payload, v_outcome, v_reason,
    v_contract.id, v_contract.project_id, v_milestone.id
  );

  if v_reason is null then
    update public.agreement_milestones m set
      reported_status = v_status,
      reported_on = v_reported_on,
      reported_at = now(),
      reported_delivery_id = v_delivery,
      reported_reference = left(nullif(btrim(coalesce(p_payload ->> 'reference', '')), ''), 200),
      change_reason = left(nullif(btrim(coalesce(p_payload ->> 'note', '')), ''), 2000),
      updated_by = null,
      status = case when v_resolves then 'satisfied' else m.status end,
      resolved_on = case when v_resolves then v_reported_on else m.resolved_on end,
      resolved_at = case when v_resolves then now() else m.resolved_at end,
      resolved_by = case when v_resolves then null else m.resolved_by end
    where m.id = v_milestone.id;
    insert into public.audit_log (org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
    values (v_source.org_id, null, 'update', 'agreement_milestone', v_milestone.id,
      jsonb_build_object('status', v_milestone.status, 'reported_status', v_milestone.reported_status),
      jsonb_build_object('status', case when v_resolves then 'satisfied' else v_milestone.status end,
        'reported_status', v_status, 'delivery_id', v_delivery),
      'inbound.agreement_milestones');
  end if;

  insert into public.events (org_id, event_type, entity_type, entity_id, payload, channel)
  values (
    v_source.org_id,
    case when v_reason is null then 'agreement_milestone.reported' else 'agreement_milestone.report_refused' end,
    case when v_milestone.id is null then 'agreement_milestone_delivery' else 'agreement_milestone' end,
    coalesce(v_milestone.id, v_delivery),
    jsonb_build_object('delivery_id', v_delivery, 'source_id', v_source.id, 'outcome', v_outcome, 'reason_code', v_reason,
      'project_id', v_contract.project_id, 'contract_id', v_contract.id, 'reported_status', v_status),
    'activity'
  );

  return jsonb_build_object('outcome', v_outcome, 'reason_code', v_reason, 'milestone_id', v_milestone.id, 'delivery_id', v_delivery);
end;
$$;

revoke all on function public.apply_agreement_milestone_report(uuid, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.apply_agreement_milestone_report(uuid, text, text, jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. The certificate of occupancy gate needs its evidence.
-- ---------------------------------------------------------------------------

alter table public.closing_checklist_items add column if not exists key text;
alter table public.closing_checklist_items add column if not exists evidence_required boolean not null default false;

create unique index if not exists closing_checklist_items_closing_key_idx
  on public.closing_checklist_items (closing_id, key) where key is not null;

-- Open closings learn their gates' keys. Recorded closings are immutable and
-- keep their rows as they were.
update public.closing_checklist_items i
   set key = case i.title
     when 'Purchase agreement executed' then 'agreement_executed'
     when 'Earnest money received' then 'earnest_money'
     when 'Final inspection / certificate of occupancy' then 'final_inspection_co'
     when 'Blue-tape walk complete' then 'blue_tape_walk'
     when 'Open punch items cleared' then 'punch_cleared'
     when 'Homeowner orientation complete' then 'homeowner_orientation'
     when 'Final settlement statement reconciled' then 'settlement_reconciled'
     when 'Warranty package delivered' then 'warranty_package'
     when 'HOA and closing documents delivered' then 'closing_documents'
   end,
   evidence_required = (i.title = 'Final inspection / certificate of occupancy' and i.status = 'open')
 from public.closings c
 where c.id = i.closing_id and c.status not in ('closed', 'cancelled') and i.key is null
   -- Rows the evidence guard would refuse to touch (a deleted completer, an
   -- archived file) keep no key rather than failing the migration.
   and (i.status = 'open' or (i.completed_by is not null and i.completed_at is not null))
   and (i.status <> 'waived' or length(btrim(coalesce(i.notes, ''))) >= 10)
   and (i.file_id is null or exists (
     select 1 from public.files f
     where f.id = i.file_id and f.org_id = i.org_id and f.project_id = c.project_id and f.archived_at is null
   ));

create or replace function public.guard_closing_checklist_required_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and new.key = 'final_inspection_co' then
    new.evidence_required := true;
  end if;
  if tg_op = 'UPDATE' and (new.key is distinct from old.key or (old.evidence_required and not new.evidence_required)) then
    raise exception 'A closing gate''s identity and evidence rule are fixed' using errcode = '42501';
  end if;
  if new.evidence_required
     and (tg_op = 'INSERT' or (new.status, new.file_id) is distinct from (old.status, old.file_id)) then
    if new.status = 'waived' then
      raise exception '% cannot be waived; attach its evidence', new.title using errcode = '23514';
    end if;
    if new.status = 'complete' and new.file_id is null then
      raise exception '% needs its evidence file', new.title using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_closing_checklist_required_evidence() from public, anon, authenticated;

drop trigger if exists closing_checklist_required_evidence on public.closing_checklist_items;
create trigger closing_checklist_required_evidence
  before insert or update on public.closing_checklist_items
  for each row execute function public.guard_closing_checklist_required_evidence();

-- ---------------------------------------------------------------------------
-- 6. A reversed closing voids the home's coverage; one live coverage per home.
-- ---------------------------------------------------------------------------

alter table public.project_warranty_coverage add column if not exists voided_at timestamptz;
alter table public.project_warranty_coverage add column if not exists void_reason text;
alter table public.project_warranty_coverage add column if not exists voided_closing_id uuid references public.closings(id) on delete set null;

alter table public.project_warranty_coverage drop constraint if exists project_warranty_coverage_project_id_key;
create unique index if not exists project_warranty_coverage_live_project_idx
  on public.project_warranty_coverage (project_id) where voided_at is null;
create index if not exists project_warranty_coverage_project_idx on public.project_warranty_coverage (project_id);
create index if not exists project_warranty_coverage_voided_closing_idx
  on public.project_warranty_coverage (voided_closing_id) where voided_closing_id is not null;

alter table public.project_warranty_coverage drop constraint if exists project_warranty_coverage_void_check;
alter table public.project_warranty_coverage add constraint project_warranty_coverage_void_check
  check ((voided_at is null) = (void_reason is null) and (void_reason is null or length(btrim(void_reason)) > 0));

create or replace function public.tg_project_warranty_coverage_snapshot_immutable()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if (new.org_id, new.project_id, new.program_id, new.effective_date, new.effective_source, new.terms_snapshot)
     is distinct from
     (old.org_id, old.project_id, old.program_id, old.effective_date, old.effective_source, old.terms_snapshot) then
    raise exception 'Warranty coverage terms are fixed at enrollment and cannot be changed'
      using errcode = 'check_violation';
  end if;
  if old.voided_at is not null
     and (new.voided_at, new.void_reason, new.voided_closing_id) is distinct from (old.voided_at, old.void_reason, old.voided_closing_id) then
    raise exception 'Voided warranty coverage stays voided; a new closing enrolls the home again'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace function public.tg_closing_reversal_voids_warranty()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'closed' and new.status = 'cancelled' then
    update public.project_warranty_coverage w
       set voided_at = now(),
           void_reason = left('Closing reversed: ' || coalesce(nullif(btrim(new.cancel_reason), ''), 'no reason recorded'), 2000),
           voided_closing_id = new.id
     where w.org_id = new.org_id and w.project_id = new.project_id and w.voided_at is null
       and w.effective_source = 'closing';
  end if;
  return null;
end;
$$;

revoke all on function public.tg_closing_reversal_voids_warranty() from public, anon, authenticated;

drop trigger if exists closings_reversal_voids_warranty on public.closings;
create trigger closings_reversal_voids_warranty
  after update of status on public.closings
  for each row execute function public.tg_closing_reversal_voids_warranty();

-- ---------------------------------------------------------------------------
-- 7. The financing start gate reads the milestones.
-- ---------------------------------------------------------------------------

alter table public.start_gate_definitions drop constraint if exists start_gate_definitions_auto_source_check;
alter table public.start_gate_definitions add constraint start_gate_definitions_auto_source_check
  check (auto_source is null or auto_source in (
    'selections_locked', 'budget_generated', 'pos_generated', 'plan_pinned',
    'plot_plan_file', 'po_exceptions_clear', 'entitlements_clear', 'agreement_milestones_clear'
  ));

update public.start_gate_definitions
   set check_kind = 'auto', auto_source = 'agreement_milestones_clear', applies_when = 'always',
       label = 'Financing milestones clear'
 where key = 'financing' and check_kind = 'manual' and auto_source is null;

-- ---------------------------------------------------------------------------
-- 8. RBAC: the bookkeeper settles closings, so it reads them.
-- ---------------------------------------------------------------------------

insert into public.role_permissions (role_id, permission_key)
select r.id, 'sales.read'
from public.roles r
where r.key = 'org_bookkeeper'
on conflict (role_id, permission_key) do nothing;
