-- EP05-01 Lead ingestion and routing.
--
-- Arc's own pipeline (`prospects`) is the CRM, so intake adds no second lead
-- store. It adds three things around it:
--   * configuration: `lead_intake_sources` (one signed feed per website or form
--     vendor) and `lead_routing_rules` (the exceptions; most orgs need none),
--     plus a division's fallback owner;
--   * a delivery log: `lead_intake_receipts`, one row per delivery, which is what
--     operators read to see routing, retries and failures;
--   * touch history: `prospect_attributions`, every touch a buyer made, so a
--     merge keeps the attribution of both submissions.
--
-- One filing core, `file_lead()`, serves the website endpoint and the manual
-- inquiry alike: under an advisory lock on the normalized email and phone it
-- merges into the open prospect that already holds them, or files a new one,
-- appends the touch and counts the traffic in the same transaction. Judgment
-- (validation, routing) is made in TypeScript and passed in.
--
-- The same change closes the prospect permission hole: a deal with no home
-- linked was writable by any org member. It now takes sales.manage or
-- pipeline.write, the keys that already gate the two desks. Community staffing
-- (which now feeds routing) takes community.write, and traffic counts take a
-- desk write key.

set lock_timeout = '5s';
set statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. Normalized contact keys. Twins of lib/sales/lead-identity.ts.
-- ---------------------------------------------------------------------------

create or replace function public.arc_normalize_email(value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(lower(btrim(value)), '')
$$;

-- Digits only; a North American number keeps ten digits (a leading 1 on an
-- eleven-digit number is the country code); fewer than ten digits is no key.
create or replace function public.arc_normalize_phone(value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when length(digits) = 11 and left(digits, 1) = '1' then substr(digits, 2)
    when length(digits) >= 10 then digits
    else null
  end
  from (select regexp_replace(coalesce(value, ''), '[^0-9]', '', 'g') as digits) normalized
$$;

alter table public.prospect_contacts
  add column email_normalized text generated always as (public.arc_normalize_email(email)) stored,
  add column phone_normalized text generated always as (public.arc_normalize_phone(phone)) stored;

create index prospect_contacts_org_email_key_idx
  on public.prospect_contacts (org_id, email_normalized)
  where email_normalized is not null and is_primary;
create index prospect_contacts_org_phone_key_idx
  on public.prospect_contacts (org_id, phone_normalized)
  where phone_normalized is not null and is_primary;

alter table public.contacts
  add column phone_normalized text generated always as (public.arc_normalize_phone(phone)) stored;

create index contacts_org_phone_key_idx
  on public.contacts (org_id, phone_normalized)
  where phone_normalized is not null and archived_at is null;

-- ---------------------------------------------------------------------------
-- 2. Intake sources.
-- ---------------------------------------------------------------------------

create table public.lead_intake_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  -- The public half of the endpoint URL. Never the row id, so a source can be
  -- named in a URL without exposing internal identifiers.
  public_id text not null unique check (public_id ~ '^lis_[a-z0-9]{24}$'),
  signing_secret_encrypted text not null,
  previous_secret_encrypted text,
  previous_secret_expires_at timestamptz,
  secret_hint text not null check (length(secret_hint) = 4),
  default_source_label text not null default 'Website' check (length(btrim(default_source_label)) between 1 and 80),
  default_community_id uuid,
  default_owner_user_id uuid references public.app_users(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'disabled')),
  last_received_at timestamptz,
  last_rejected_at timestamptz,
  last_rejection_reason text check (last_rejection_reason in ('missing_signature', 'stale_timestamp', 'bad_signature')),
  rejected_count integer not null default 0 check (rejected_count >= 0),
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (default_community_id) references public.communities(id) on delete set null,
  check ((previous_secret_encrypted is null) = (previous_secret_expires_at is null))
);

create index lead_intake_sources_org_idx on public.lead_intake_sources (org_id, status);
create index lead_intake_sources_community_idx on public.lead_intake_sources (default_community_id) where default_community_id is not null;
create index lead_intake_sources_owner_idx on public.lead_intake_sources (default_owner_user_id) where default_owner_user_id is not null;

create trigger lead_intake_sources_set_updated_at
  before update on public.lead_intake_sources
  for each row execute function public.tg_set_updated_at();

alter table public.lead_intake_sources enable row level security;

create policy lead_intake_sources_read on public.lead_intake_sources
  for select to authenticated
  using (public.has_org_permission(org_id, 'lead_intake.manage'));

create policy lead_intake_sources_division_scope on public.lead_intake_sources
  as restrictive to authenticated
  using (
    default_community_id is null
    or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or default_community_id in (select public.member_reachable_community_ids())
  );

-- Secrets never leave the server: members read every column but the two
-- ciphertexts, and every write goes through the service after its permission check.
revoke all on table public.lead_intake_sources from anon, authenticated;
grant select (
  id, org_id, name, public_id, secret_hint, default_source_label, default_community_id, default_owner_user_id,
  status, last_received_at, last_rejected_at, last_rejection_reason, rejected_count, previous_secret_expires_at,
  created_by, created_at, updated_at
) on table public.lead_intake_sources to authenticated;
grant all on table public.lead_intake_sources to service_role;

-- ---------------------------------------------------------------------------
-- 3. The delivery log.
-- ---------------------------------------------------------------------------

create table public.lead_intake_receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  source_id uuid not null,
  -- Null only for a rejected delivery: an unsigned request does not get to
  -- reserve a key a genuine delivery may use later.
  idempotency_key text check (idempotency_key is null or length(idempotency_key) between 1 and 200),
  payload_hash text,
  -- The submission as received. Purged 90 days after a receipt is dismissed.
  payload jsonb,
  payload_purged_at timestamptz,
  status text not null default 'received'
    check (status in ('received', 'filed', 'merged', 'failed', 'rejected', 'dismissed')),
  failure_code text check (failure_code in (
    'invalid_payload', 'no_contact_key', 'unknown_community', 'filing_error',
    'missing_signature', 'stale_timestamp', 'bad_signature'
  )),
  last_error text,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  -- What the delivery is about, once known: the log is scoped by division like
  -- the deals it feeds.
  community_id uuid,
  contact_name text,
  contact_email text,
  contact_phone text,
  prospect_id uuid,
  matched_by text check (matched_by in ('email', 'phone')),
  prior_prospect_id uuid,
  owner_user_id uuid references public.app_users(id) on delete set null,
  routing_outcome text check (routing_outcome in (
    'rule', 'community_assignee', 'division_default', 'source_default', 'existing_owner', 'unrouted'
  )),
  routing_reason text,
  received_at timestamptz not null default now(),
  filed_at timestamptz,
  resolved_by uuid references public.app_users(id) on delete set null,
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, source_id) references public.lead_intake_sources(org_id, id) on delete cascade,
  foreign key (community_id) references public.communities(id) on delete set null,
  constraint lead_intake_receipts_prospect_fkey
    foreign key (org_id, prospect_id) references public.prospects(org_id, id) on delete set null (prospect_id),
  constraint lead_intake_receipts_prior_prospect_fkey
    foreign key (org_id, prior_prospect_id) references public.prospects(org_id, id) on delete set null (prior_prospect_id),
  check ((status = 'rejected') = (idempotency_key is null)),
  check (status <> 'dismissed' or (resolved_at is not null and resolved_by is not null))
);

create unique index lead_intake_receipts_idempotency_idx
  on public.lead_intake_receipts (source_id, idempotency_key)
  where idempotency_key is not null;
create index lead_intake_receipts_org_status_idx on public.lead_intake_receipts (org_id, status, received_at desc);
create index lead_intake_receipts_org_prospect_idx on public.lead_intake_receipts (org_id, prospect_id) where prospect_id is not null;
create index lead_intake_receipts_prior_idx on public.lead_intake_receipts (org_id, prior_prospect_id) where prior_prospect_id is not null;
create index lead_intake_receipts_source_idx on public.lead_intake_receipts (source_id, received_at desc);
create index lead_intake_receipts_community_idx on public.lead_intake_receipts (community_id) where community_id is not null;
create index lead_intake_receipts_owner_idx on public.lead_intake_receipts (owner_user_id) where owner_user_id is not null;
create index lead_intake_receipts_purge_idx on public.lead_intake_receipts (resolved_at) where payload is not null and status = 'dismissed';

create trigger lead_intake_receipts_set_updated_at
  before update on public.lead_intake_receipts
  for each row execute function public.tg_set_updated_at();

alter table public.lead_intake_receipts enable row level security;

create policy lead_intake_receipts_read on public.lead_intake_receipts
  for select to authenticated
  using (
    public.is_org_member(org_id)
    and (
      public.has_org_permission(org_id, 'sales.read')
      or public.has_org_permission(org_id, 'pipeline.read')
      or public.has_org_permission(org_id, 'lead_intake.manage')
    )
  );

create policy lead_intake_receipts_division_scope on public.lead_intake_receipts
  as restrictive to authenticated
  using (
    community_id is null
    or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or community_id in (select public.member_reachable_community_ids())
  );

revoke all on table public.lead_intake_receipts from anon, authenticated;
grant select on table public.lead_intake_receipts to authenticated;
grant all on table public.lead_intake_receipts to service_role;

-- ---------------------------------------------------------------------------
-- 4. Touch history.
-- ---------------------------------------------------------------------------

create table public.prospect_attributions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  prospect_id uuid not null,
  receipt_id uuid references public.lead_intake_receipts(id) on delete set null,
  touch integer not null check (touch >= 1),
  channel text not null check (channel in ('walk_in', 'appointment', 'web', 'phone', 'import')),
  source_label text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_term text,
  utm_content text,
  click_ids jsonb not null default '{}'::jsonb check (jsonb_typeof(click_ids) = 'object'),
  referrer_url text,
  landing_url text,
  community_id uuid references public.communities(id) on delete set null,
  occurred_at timestamptz not null default now(),
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, prospect_id) references public.prospects(org_id, id) on delete cascade,
  unique (prospect_id, touch)
);

create index prospect_attributions_org_prospect_idx on public.prospect_attributions (org_id, prospect_id);
create index prospect_attributions_org_campaign_idx on public.prospect_attributions (org_id, utm_campaign) where utm_campaign is not null;
create index prospect_attributions_receipt_idx on public.prospect_attributions (receipt_id) where receipt_id is not null;
create index prospect_attributions_community_idx on public.prospect_attributions (community_id) where community_id is not null;

create trigger prospect_attributions_set_updated_at
  before update on public.prospect_attributions
  for each row execute function public.tg_set_updated_at();

alter table public.prospect_attributions enable row level security;

create policy prospect_attributions_read on public.prospect_attributions
  for select to authenticated
  using (public.is_org_member(org_id));

create policy prospect_attributions_division_scope on public.prospect_attributions
  as restrictive to authenticated
  using (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or not (prospect_id in (select public.member_foreign_division_prospect_ids()))
  );

-- Touches are written only by file_lead(): a touch is history, not an edit.
revoke all on table public.prospect_attributions from anon, authenticated;
grant select on table public.prospect_attributions to authenticated;
grant all on table public.prospect_attributions to service_role;

-- ---------------------------------------------------------------------------
-- 5. Routing configuration.
-- ---------------------------------------------------------------------------

alter table public.divisions
  add column default_lead_owner_user_id uuid references public.app_users(id) on delete set null;

create index divisions_default_lead_owner_idx on public.divisions (default_lead_owner_user_id)
  where default_lead_owner_user_id is not null;

create table public.lead_routing_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  priority integer not null default 100 check (priority >= 0),
  source_id uuid,
  community_id uuid references public.communities(id) on delete cascade,
  division_id uuid references public.divisions(id) on delete cascade,
  utm_source text check (utm_source is null or length(btrim(utm_source)) between 1 and 200),
  utm_campaign text check (utm_campaign is null or length(btrim(utm_campaign)) between 1 and 200),
  assigned_user_id uuid not null references public.app_users(id) on delete cascade,
  is_active boolean not null default true,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, source_id) references public.lead_intake_sources(org_id, id) on delete cascade
);

create index lead_routing_rules_org_active_idx on public.lead_routing_rules (org_id, is_active, priority);
create index lead_routing_rules_source_idx on public.lead_routing_rules (source_id) where source_id is not null;
create index lead_routing_rules_community_idx on public.lead_routing_rules (community_id) where community_id is not null;
create index lead_routing_rules_division_idx on public.lead_routing_rules (division_id) where division_id is not null;
create index lead_routing_rules_user_idx on public.lead_routing_rules (assigned_user_id);

create trigger lead_routing_rules_set_updated_at
  before update on public.lead_routing_rules
  for each row execute function public.tg_set_updated_at();

alter table public.lead_routing_rules enable row level security;

create policy lead_routing_rules_read on public.lead_routing_rules
  for select to authenticated
  using (public.is_org_member(org_id));
create policy lead_routing_rules_insert on public.lead_routing_rules
  for insert to authenticated
  with check (public.has_org_permission(org_id, 'lead_intake.manage'));
create policy lead_routing_rules_update on public.lead_routing_rules
  for update to authenticated
  using (public.has_org_permission(org_id, 'lead_intake.manage'))
  with check (public.has_org_permission(org_id, 'lead_intake.manage'));
create policy lead_routing_rules_delete on public.lead_routing_rules
  for delete to authenticated
  using (public.has_org_permission(org_id, 'lead_intake.manage'));
create policy lead_routing_rules_division_scope on public.lead_routing_rules
  as restrictive to authenticated
  using (
    community_id is null
    or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or community_id in (select public.member_reachable_community_ids())
  )
  with check (
    community_id is null
    or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or community_id in (select public.member_reachable_community_ids())
  );

revoke all on table public.lead_routing_rules from anon;
grant select, insert, update, delete on table public.lead_routing_rules to authenticated;
grant all on table public.lead_routing_rules to service_role;

-- ---------------------------------------------------------------------------
-- 6. Who may work a lead.
-- ---------------------------------------------------------------------------

-- An active member holding a desk write key (sales.manage or pipeline.write),
-- through their role or a grant, and not denied it. Routing never hands a lead
-- to someone who could not open it.
create or replace function arc_private.member_can_work_leads(p_org_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.org_id = p_org_id and m.user_id = p_user_id and m.status = 'active'
      and exists (
        select 1 from (
          select rp.permission_key from public.role_permissions rp where rp.role_id = m.role_id
          union
          select o.permission_key from public.membership_permission_overrides o
          where o.membership_id = m.id and o.effect = 'grant'
        ) granted
        where granted.permission_key in ('sales.manage', 'pipeline.write', '*')
          and not exists (
            select 1 from public.membership_permission_overrides d
            where d.membership_id = m.id and d.effect = 'deny' and d.permission_key = granted.permission_key
          )
      )
  )
$$;

revoke all on function arc_private.member_can_work_leads(uuid, uuid) from public, anon, authenticated;

-- A deal with no home linked is the desks' record: it takes sales.manage or
-- pipeline.write. A linked deal keeps its project.manage rule.
create or replace function arc_private.can_write_deal(p_org_id uuid, p_prospect_id uuid)
returns boolean
language plpgsql
stable security definer
set search_path = ''
as $function$
declare
  actor uuid := auth.uid();
  linked_project_id uuid;
  org_permissions text[];
  denied text[];
  project_permissions text[];
  assigned_only boolean;
  project_member boolean;
begin
  if actor is null then return false; end if;
  if not public.session_meets_org_mfa(p_org_id) then return false; end if;
  if not exists (select 1 from public.memberships where org_id=p_org_id and user_id=actor and status='active') then
    return false;
  end if;
  select coalesce(array_agg(distinct permission_key), '{}') into org_permissions from (
    select rp.permission_key from public.memberships m join public.role_permissions rp on rp.role_id=m.role_id
      where m.org_id=p_org_id and m.user_id=actor and m.status='active'
    union
    select o.permission_key from public.memberships m join public.membership_permission_overrides o on o.membership_id=m.id
      where m.org_id=p_org_id and m.user_id=actor and m.status='active' and o.effect='grant'
  ) grants;
  select coalesce(array_agg(distinct o.permission_key), '{}') into denied
    from public.memberships m join public.membership_permission_overrides o on o.membership_id=m.id
    where m.org_id=p_org_id and m.user_id=actor and m.status='active' and o.effect='deny';
  if 'org.member'=any(denied) or not ('org.member'=any(org_permissions) or ('*'=any(org_permissions) and not '*'=any(denied))) then return false; end if;
  select id into linked_project_id from public.projects where org_id=p_org_id and prospect_id=p_prospect_id;
  if linked_project_id is null then
    return ('*'=any(org_permissions) and not '*'=any(denied))
      or ('sales.manage'=any(org_permissions) and not 'sales.manage'=any(denied))
      or ('pipeline.write'=any(org_permissions) and not 'pipeline.write'=any(denied));
  end if;
  if 'project.manage'=any(denied) then return false; end if;
  select coalesce(bool_or(project_scope='assigned'),false) into assigned_only
    from public.memberships where org_id=p_org_id and user_id=actor and status='active';
  select exists(select 1 from public.project_members pm where pm.org_id=p_org_id and pm.project_id=linked_project_id and pm.user_id=actor and pm.status='active') into project_member;
  if not project_member and not (
    '*'=any(org_permissions) or 'org.admin'=any(org_permissions)
    or (not assigned_only and ('project.read'=any(org_permissions) or 'project.manage'=any(org_permissions)))
  ) then return false; end if;
  select coalesce(array_agg(distinct rp.permission_key), '{}') into project_permissions
    from public.project_members pm join public.role_permissions rp on rp.role_id=pm.role_id
    where pm.org_id=p_org_id and pm.project_id=linked_project_id and pm.user_id=actor and pm.status='active';
  return 'project.manage'=any(org_permissions || project_permissions)
    or ('*'=any(org_permissions || project_permissions) and not '*'=any(denied));
end $function$;

-- Community staffing feeds routing, so assigning yourself as a community's
-- consultant takes community.write. Traffic counts take a desk write key.
drop policy if exists community_assignments_org_access on public.community_assignments;
create policy community_assignments_read on public.community_assignments
  for select to authenticated
  using (public.is_org_member(org_id));
create policy community_assignments_insert on public.community_assignments
  for insert to authenticated
  with check (public.has_org_permission(org_id, 'community.write'));
create policy community_assignments_update on public.community_assignments
  for update to authenticated
  using (public.has_org_permission(org_id, 'community.write'))
  with check (public.has_org_permission(org_id, 'community.write'));
create policy community_assignments_delete on public.community_assignments
  for delete to authenticated
  using (public.has_org_permission(org_id, 'community.write'));

drop policy if exists community_traffic_org_access on public.community_traffic;
create policy community_traffic_read on public.community_traffic
  for select to authenticated
  using (public.is_org_member(org_id));
create policy community_traffic_insert on public.community_traffic
  for insert to authenticated
  with check (public.has_org_permission(org_id, 'sales.manage') or public.has_org_permission(org_id, 'pipeline.write'));
create policy community_traffic_update on public.community_traffic
  for update to authenticated
  using (public.has_org_permission(org_id, 'sales.manage') or public.has_org_permission(org_id, 'pipeline.write'))
  with check (public.has_org_permission(org_id, 'sales.manage') or public.has_org_permission(org_id, 'pipeline.write'));

-- ---------------------------------------------------------------------------
-- 7. Traffic counts add atomically.
-- ---------------------------------------------------------------------------

-- One statement, so two leads registered in the same minute both count. Runs
-- as the caller: RLS decides who may count.
create or replace function public.increment_community_traffic(
  p_org_id uuid,
  p_community_id uuid,
  p_day date,
  p_bucket text
)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.community_traffic (org_id, community_id, logged_date, walk_ins, appointments, web_inquiries, recorded_by)
  select p_org_id, c.id, p_day,
    (p_bucket = 'walk_ins')::int, (p_bucket = 'appointments')::int, (p_bucket = 'web_inquiries')::int,
    (select auth.uid())
  from public.communities c
  where c.org_id = p_org_id and c.id = p_community_id and p_bucket in ('walk_ins', 'appointments', 'web_inquiries')
  on conflict (community_id, logged_date) do update set
    walk_ins = public.community_traffic.walk_ins + excluded.walk_ins,
    appointments = public.community_traffic.appointments + excluded.appointments,
    web_inquiries = public.community_traffic.web_inquiries + excluded.web_inquiries,
    updated_at = now()
$$;

revoke all on function public.increment_community_traffic(uuid, uuid, date, text) from public, anon;
grant execute on function public.increment_community_traffic(uuid, uuid, date, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. What routing needs, in one read.
-- ---------------------------------------------------------------------------

-- The community's division, its sales consultants in round-robin order (least
-- recently handed a new lead in this community first), the division's fallback
-- owner, and which of those people and `p_candidate_ids` may take the lead:
-- able to work leads and able to reach the community's division.
create or replace function public.lead_routing_context(
  p_org_id uuid,
  p_community_id uuid,
  p_candidate_ids uuid[] default '{}'
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with community as (
    select c.id, c.division_id
    from public.communities c
    where c.org_id = p_org_id and c.id = p_community_id
  ), assignees as (
    select ca.user_id,
      (select max(p.created_at) from public.prospects p
        where p.org_id = p_org_id and p.community_id = ca.community_id and p.owner_user_id = ca.user_id) as last_assigned_at
    from public.community_assignments ca
    where ca.org_id = p_org_id and ca.community_id = p_community_id and ca.role = 'sales'
  ), division_default as (
    select d.default_lead_owner_user_id as user_id
    from public.divisions d join community c on c.division_id = d.id
    where d.org_id = p_org_id and d.archived_at is null
  ), candidates as (
    select user_id from assignees
    union select user_id from division_default where user_id is not null
    union select unnest(coalesce(p_candidate_ids, '{}'::uuid[]))
  )
  select jsonb_build_object(
    'division_id', (select division_id from community),
    'community_assignees', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', a.user_id, 'last_assigned_at', a.last_assigned_at)
        order by a.last_assigned_at asc nulls first, a.user_id)
      from assignees a), '[]'::jsonb),
    'division_default_user_id', (select user_id from division_default),
    'eligible_user_ids', coalesce((
      select jsonb_agg(distinct candidate.user_id)
      from candidates candidate
      join public.memberships m on m.org_id = p_org_id and m.user_id = candidate.user_id and m.status = 'active'
      where arc_private.member_can_work_leads(p_org_id, candidate.user_id)
        and (
          m.division_scope = 'all'
          or public.membership_is_org_admin(m.id, m.role_id)
          or not exists (select 1 from community c where c.division_id is not null)
          or exists (
            select 1 from public.membership_divisions md join community c on c.division_id = md.division_id
            where md.membership_id = m.id
          )
        )), '[]'::jsonb)
  )
$$;

revoke all on function public.lead_routing_context(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.lead_routing_context(uuid, uuid, uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 9. The filing core.
-- ---------------------------------------------------------------------------

-- p_lead: name, email, phone, contact_id, community_id, owner_user_id, source,
-- project_type, budget_range, timeline_preference, notes, created_by,
-- channel, traffic_bucket, occurred_on, routing_outcome, routing_reason and the
-- touch's attribution (source_label, utm_*, click_ids, referrer_url,
-- landing_url, occurred_at). Callers have authorized the actor and validated
-- the input; this function decides only "same person or new deal", atomically.
create or replace function public.file_lead(p_org_id uuid, p_receipt_id uuid, p_lead jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := public.arc_normalize_email(p_lead->>'email');
  v_phone text := public.arc_normalize_phone(p_lead->>'phone');
  v_community uuid := nullif(p_lead->>'community_id', '')::uuid;
  v_routed_owner uuid := nullif(p_lead->>'owner_user_id', '')::uuid;
  v_actor uuid := nullif(p_lead->>'created_by', '')::uuid;
  v_contact uuid := nullif(p_lead->>'contact_id', '')::uuid;
  v_receipt public.lead_intake_receipts%rowtype;
  v_prospect uuid;
  v_matched_by text;
  v_prior uuid;
  v_existing_owner uuid;
  v_owner uuid;
  v_outcome text;
  v_routing_outcome text := p_lead->>'routing_outcome';
  v_rotation uuid[] := array(
    select value::uuid from jsonb_array_elements_text(
      case when jsonb_typeof(p_lead->'round_robin_user_ids') = 'array' then p_lead->'round_robin_user_ids' else '[]'::jsonb end
    )
  );
  v_touch integer;
begin
  if p_receipt_id is not null then
    select * into v_receipt from public.lead_intake_receipts
      where id = p_receipt_id and org_id = p_org_id for update;
    if not found then raise exception 'Lead receipt not found' using errcode = 'P0002'; end if;
    if v_receipt.status in ('filed', 'merged') then
      return jsonb_build_object('prospect_id', v_receipt.prospect_id, 'outcome', v_receipt.status,
        'matched_by', v_receipt.matched_by, 'prior_prospect_id', v_receipt.prior_prospect_id,
        'owner_user_id', v_receipt.owner_user_id, 'replayed', true);
    end if;
    if v_receipt.status in ('rejected', 'dismissed') then
      raise exception 'This delivery was % and cannot be filed', v_receipt.status using errcode = '22023';
    end if;
    if v_email is null and v_phone is null then
      raise exception 'A website lead needs an email or a phone number' using errcode = '22023';
    end if;
  end if;

  if length(btrim(coalesce(p_lead->>'name', ''))) = 0 then
    raise exception 'A lead needs a name' using errcode = '22023';
  end if;
  if v_community is not null and not exists (
    select 1 from public.communities where id = v_community and org_id = p_org_id and archived_at is null
  ) then
    raise exception 'Community not found' using errcode = '22023';
  end if;
  if v_routed_owner is not null and not exists (
    select 1 from public.memberships where org_id = p_org_id and user_id = v_routed_owner and status = 'active'
  ) then
    raise exception 'Choose an active team member' using errcode = '22023';
  end if;
  if v_contact is not null and not exists (
    select 1 from public.contacts where id = v_contact and org_id = p_org_id and archived_at is null
  ) then
    raise exception 'Contact not found' using errcode = '22023';
  end if;

  -- Two deliveries for the same person file one after the other. Email before
  -- phone, one lock each, so the order is the same in every transaction.
  if v_email is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':lead-email:' || v_email, 0));
  end if;
  if v_phone is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':lead-phone:' || v_phone, 0));
  end if;

  -- The community rotation takes its turn under the community's lock (always
  -- the last lock taken, so the order never inverts): two leads routed at the
  -- same moment read the same "least recently handed a lead", and the second
  -- must see the first's new deal before it picks.
  if v_routing_outcome = 'community_assignee' and v_community is not null and cardinality(v_rotation) > 0 then
    if v_routed_owner is null or not v_routed_owner = any (v_rotation) then
      raise exception 'The routed owner is not in the community rotation' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':lead-rotation:' || v_community::text, 0));
    select pool.user_id into v_routed_owner
      from unnest(v_rotation) as pool(user_id)
      order by (
        select max(p.created_at) from public.prospects p
        where p.org_id = p_org_id and p.community_id = v_community and p.owner_user_id = pool.user_id
      ) asc nulls first, pool.user_id::text
      limit 1;
  end if;

  -- The buyer is the primary contact; a co-op agent's address on another deal is
  -- not this buyer. Only an open deal takes the merge: a won or lost buyer who
  -- comes back is a new deal, flagged as returning.
  if v_email is not null then
    select p.id into v_prospect from public.prospect_contacts pc
      join public.prospects p on p.id = pc.prospect_id and p.org_id = pc.org_id
      where pc.org_id = p_org_id and pc.is_primary and pc.email_normalized = v_email
        and p.status not in ('won', 'lost')
      order by p.created_at, p.id limit 1;
    if v_prospect is not null then v_matched_by := 'email'; end if;
  end if;
  if v_prospect is null and v_phone is not null then
    select p.id into v_prospect from public.prospect_contacts pc
      join public.prospects p on p.id = pc.prospect_id and p.org_id = pc.org_id
      where pc.org_id = p_org_id and pc.is_primary and pc.phone_normalized = v_phone
        and p.status not in ('won', 'lost')
      order by p.created_at, p.id limit 1;
    if v_prospect is not null then v_matched_by := 'phone'; end if;
  end if;

  if v_prospect is not null then
    select owner_user_id into v_existing_owner from public.prospects where id = v_prospect for update;
    v_owner := coalesce(v_existing_owner, v_routed_owner);
    if v_existing_owner is not null then
      v_routing_outcome := 'existing_owner';
    elsif v_owner is not null then
      update public.prospects set owner_user_id = v_owner, updated_at = now() where id = v_prospect;
    end if;
    -- The second submission may carry what the first did not.
    update public.prospect_contacts set
      email = coalesce(email, nullif(btrim(p_lead->>'email'), '')),
      phone = coalesce(phone, nullif(btrim(p_lead->>'phone'), '')),
      updated_at = now()
    where prospect_id = v_prospect and is_primary
      and ((email is null and v_email is not null) or (phone is null and v_phone is not null));
    v_outcome := 'merged';
  else
    if v_email is not null then
      select p.id into v_prior from public.prospect_contacts pc
        join public.prospects p on p.id = pc.prospect_id and p.org_id = pc.org_id
        where pc.org_id = p_org_id and pc.is_primary and pc.email_normalized = v_email and p.status in ('won', 'lost')
        order by coalesce(p.won_at, p.lost_at) desc nulls last, p.id limit 1;
    end if;
    if v_prior is null and v_phone is not null then
      select p.id into v_prior from public.prospect_contacts pc
        join public.prospects p on p.id = pc.prospect_id and p.org_id = pc.org_id
        where pc.org_id = p_org_id and pc.is_primary and pc.phone_normalized = v_phone and p.status in ('won', 'lost')
        order by coalesce(p.won_at, p.lost_at) desc nulls last, p.id limit 1;
    end if;

    v_owner := v_routed_owner;
    insert into public.prospects (
      org_id, name, status, owner_user_id, community_id, source, project_type, budget_range,
      timeline_preference, notes, created_by
    ) values (
      p_org_id, btrim(p_lead->>'name'), 'new', v_owner, v_community, nullif(btrim(p_lead->>'source'), ''),
      nullif(btrim(p_lead->>'project_type'), ''), nullif(btrim(p_lead->>'budget_range'), ''),
      nullif(btrim(p_lead->>'timeline_preference'), ''), nullif(btrim(p_lead->>'notes'), ''), v_actor
    ) returning id into v_prospect;

    insert into public.prospect_contacts (org_id, prospect_id, contact_id, full_name, email, phone, is_primary)
    values (
      p_org_id, v_prospect, v_contact, btrim(p_lead->>'name'),
      nullif(btrim(p_lead->>'email'), ''), nullif(btrim(p_lead->>'phone'), ''), true
    );

    if v_community is not null and p_lead->>'traffic_bucket' in ('walk_ins', 'appointments', 'web_inquiries') then
      insert into public.community_traffic (org_id, community_id, logged_date, walk_ins, appointments, web_inquiries, recorded_by)
      values (
        p_org_id, v_community, coalesce(nullif(p_lead->>'occurred_on', '')::date, current_date),
        (p_lead->>'traffic_bucket' = 'walk_ins')::int, (p_lead->>'traffic_bucket' = 'appointments')::int,
        (p_lead->>'traffic_bucket' = 'web_inquiries')::int, v_actor
      )
      on conflict (community_id, logged_date) do update set
        walk_ins = public.community_traffic.walk_ins + excluded.walk_ins,
        appointments = public.community_traffic.appointments + excluded.appointments,
        web_inquiries = public.community_traffic.web_inquiries + excluded.web_inquiries,
        updated_at = now();
    end if;
    v_outcome := 'filed';
  end if;

  select coalesce(max(touch), 0) + 1 into v_touch from public.prospect_attributions where prospect_id = v_prospect;
  insert into public.prospect_attributions (
    org_id, prospect_id, receipt_id, touch, channel, source_label, utm_source, utm_medium, utm_campaign,
    utm_term, utm_content, click_ids, referrer_url, landing_url, community_id, occurred_at, created_by
  ) values (
    p_org_id, v_prospect, p_receipt_id, v_touch, coalesce(p_lead->>'channel', 'web'),
    nullif(btrim(p_lead->>'source_label'), ''), nullif(btrim(p_lead->>'utm_source'), ''),
    nullif(btrim(p_lead->>'utm_medium'), ''), nullif(btrim(p_lead->>'utm_campaign'), ''),
    nullif(btrim(p_lead->>'utm_term'), ''), nullif(btrim(p_lead->>'utm_content'), ''),
    coalesce(p_lead->'click_ids', '{}'::jsonb), nullif(btrim(p_lead->>'referrer_url'), ''),
    nullif(btrim(p_lead->>'landing_url'), ''), v_community,
    coalesce(nullif(p_lead->>'occurred_at', '')::timestamptz, now()), v_actor
  );

  if p_receipt_id is not null then
    update public.lead_intake_receipts set
      status = v_outcome, prospect_id = v_prospect, matched_by = v_matched_by, prior_prospect_id = v_prior,
      owner_user_id = v_owner, routing_outcome = v_routing_outcome, routing_reason = p_lead->>'routing_reason',
      community_id = coalesce(v_community, community_id), failure_code = null, last_error = null,
      next_attempt_at = null, attempts = attempts + 1, filed_at = now()
    where id = p_receipt_id;
  end if;

  return jsonb_build_object('prospect_id', v_prospect, 'outcome', v_outcome, 'matched_by', v_matched_by,
    'prior_prospect_id', v_prior, 'owner_user_id', v_owner, 'routing_outcome', v_routing_outcome,
    'touch', v_touch, 'replayed', false);
end
$$;

revoke all on function public.file_lead(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.file_lead(uuid, uuid, jsonb) to service_role;

-- An unsigned or badly signed delivery: logged without its body, and counted
-- on the source in the same statement, so a burst never under-counts.
create or replace function public.record_lead_delivery_rejection(p_source_id uuid, p_reason text, p_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  update public.lead_intake_sources set
    rejected_count = rejected_count + 1,
    last_rejected_at = greatest(coalesce(last_rejected_at, p_at), p_at),
    last_rejection_reason = p_reason
  where id = p_source_id
  returning org_id into v_org;
  if not found then raise exception 'Lead source not found' using errcode = 'P0002'; end if;
  insert into public.lead_intake_receipts (org_id, source_id, idempotency_key, status, failure_code, received_at)
  values (v_org, p_source_id, null, 'rejected', p_reason, p_at);
end
$$;

revoke all on function public.record_lead_delivery_rejection(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_lead_delivery_rejection(uuid, text, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 10. Retention: a dismissed delivery's submission is personal data nobody
-- will act on. Its payload goes after 90 days; a rejected delivery (no payload,
-- only the fact of an unsigned request) goes entirely.
-- ---------------------------------------------------------------------------

create or replace function public.purge_lead_intake_payloads(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  purged integer;
  deleted integer;
begin
  update public.lead_intake_receipts
    set payload = null, contact_name = null, contact_email = null, contact_phone = null, payload_purged_at = p_now
  where status = 'dismissed' and payload is not null and resolved_at < p_now - interval '90 days';
  get diagnostics purged = row_count;
  delete from public.lead_intake_receipts where status = 'rejected' and received_at < p_now - interval '90 days';
  get diagnostics deleted = row_count;
  return purged + deleted;
end
$$;

revoke all on function public.purge_lead_intake_payloads(timestamptz) from public, anon, authenticated;
grant execute on function public.purge_lead_intake_payloads(timestamptz) to service_role;

select cron.schedule('purge-lead-intake-payloads', '41 3 * * *', $$ select public.purge_lead_intake_payloads() $$);

-- ---------------------------------------------------------------------------
-- 11. RBAC.
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('lead_intake.manage', 'Manage lead sources, signing secrets and lead routing')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'lead_intake.manage'
from public.roles r
where r.key in ('org_owner', 'org_admin', 'org_office_admin')
on conflict (role_id, permission_key) do nothing;

-- A sales consultant on an org that also sells custom homes works the Pipeline
-- desk as well; without these the nav hides it and the write fix above would
-- lock them out of the deals they own.
insert into public.role_permissions (role_id, permission_key)
select r.id, k.key
from public.roles r
cross join (values ('pipeline.read'), ('pipeline.write')) as k(key)
where r.key = 'org_sales_agent'
on conflict (role_id, permission_key) do nothing;

-- ---------------------------------------------------------------------------
-- 12. One desk per lead. On an org that also builds custom homes, a prospect
-- with no community is a Pipeline deal; the Sales board stops listing it a
-- second time (`leadDesk`, fed by shouldShowCustomBuildNavigation). Otherwise
-- unchanged, including the settlement price read in either key spelling.
-- ---------------------------------------------------------------------------

drop function if exists public.get_sales_deals(uuid, uuid, uuid, boolean, integer, text);

create or replace function public.get_sales_deals(
  p_org_id uuid,
  p_division_id uuid default null,
  p_community_id uuid default null,
  p_include_closed boolean default true,
  p_limit integer default 500,
  p_deal_id text default null,
  p_include_communityless boolean default true
) returns table (
  deal_id text,
  prospect_id uuid,
  reservation_id uuid,
  contract_id uuid,
  closing_id uuid,
  project_id uuid,
  lot_id uuid,
  community_id uuid,
  community_name text,
  division_id uuid,
  lot_label text,
  plan_name text,
  plan_beds numeric,
  plan_baths numeric,
  plan_sqft integer,
  buyer_name text,
  buyer_phone text,
  buyer_email text,
  owner_user_id uuid,
  source text,
  stage text,
  stage_rank integer,
  price_cents bigint,
  hold_expires_at timestamptz,
  next_follow_up_at timestamptz,
  contract_status text,
  contract_signed_at timestamptz,
  closing_status text,
  closing_scheduled_date date,
  closing_actual_date date,
  open_gate_count bigint,
  is_open boolean,
  created_at timestamptz,
  updated_at timestamptz
) language sql stable security invoker set search_path = public, pg_catalog as $$
  with live_res as (
    select r.id as res_id, r.prospect_id, r.lot_id, r.community_id, l.project_id
    from public.lot_reservations r
    join public.lots l on l.org_id = r.org_id and l.id = r.lot_id
    where r.org_id = p_org_id
      and r.status in ('hold', 'reserved', 'converted')
  ), agreements as (
    select ct.project_id
    from public.contracts ct
    where ct.org_id = p_org_id
      and ct.contract_type = 'purchase_agreement'
      and ct.status = 'active'
  ), anchors as (
    select
      'r:' || lr.res_id::text as deal_id,
      lr.prospect_id,
      lr.res_id as reservation_id,
      lr.lot_id,
      lr.community_id,
      lr.project_id
    from live_res lr

    union all

    select
      'p:' || p.id::text,
      p.id,
      null::uuid,
      null::uuid,
      p.community_id,
      null::uuid
    from public.prospects p
    where p.org_id = p_org_id
      and not exists (select 1 from live_res lr where lr.prospect_id = p.id)
      and (p_include_communityless or p.community_id is not null)

    union all

    select distinct
      'j:' || a.project_id::text,
      null::uuid,
      null::uuid,
      l.id,
      l.community_id,
      a.project_id
    from agreements a
    join public.lots l on l.org_id = p_org_id and l.project_id = a.project_id
    where not exists (select 1 from live_res lr where lr.project_id = a.project_id)
  )
  select
    a.deal_id,
    a.prospect_id,
    a.reservation_id,
    ct.id as contract_id,
    cl.id as closing_id,
    a.project_id,
    a.lot_id,
    a.community_id,
    c.name as community_name,
    c.division_id,
    case
      when l.id is null then null
      when nullif(btrim(coalesce(l.block, '')), '') is not null then l.block || '-' || l.lot_number
      else l.lot_number
    end as lot_label,
    hp.name as plan_name,
    hp.beds as plan_beds,
    hp.baths as plan_baths,
    coalesce(hp.heated_sqft, hp.total_sqft) as plan_sqft,
    coalesce(bc.full_name, pc.full_name, p.name, 'Buyer') as buyer_name,
    coalesce(bc.phone, pc.phone) as buyer_phone,
    coalesce(bc.email::text, pc.email) as buyer_email,
    p.owner_user_id,
    p.source,
    stage.value as stage,
    stage.rank as stage_rank,
    coalesce(
      nullif(coalesce(cl.settlement ->> 'finalPriceCents', cl.settlement ->> 'final_price_cents'), '')::bigint,
      ct.total_cents::bigint,
      r.asking_price_cents,
      l.asking_price_override_cents
    ) as price_cents,
    case when r.status = 'hold' then r.expires_at end as hold_expires_at,
    p.next_follow_up_at,
    ct.status as contract_status,
    ct.signed_at as contract_signed_at,
    cl.status as closing_status,
    cl.scheduled_date as closing_scheduled_date,
    cl.actual_date as closing_actual_date,
    coalesce(gates.open_count, 0) as open_gate_count,
    stage.rank between 1 and 6 as is_open,
    coalesce(r.created_at, p.created_at, ct.created_at) as created_at,
    greatest(
      coalesce(r.updated_at, '-infinity'::timestamptz),
      coalesce(p.updated_at, '-infinity'::timestamptz),
      coalesce(cl.updated_at, '-infinity'::timestamptz)
    ) as updated_at
  from anchors a
  left join public.prospects p on p.org_id = p_org_id and p.id = a.prospect_id
  left join public.lot_reservations r on r.org_id = p_org_id and r.id = a.reservation_id
  left join public.lots l on l.org_id = p_org_id and l.id = a.lot_id
  left join public.communities c on c.org_id = p_org_id and c.id = a.community_id
  left join public.house_plans hp on hp.org_id = p_org_id and hp.id = l.house_plan_id
  left join public.contacts bc on bc.org_id = p_org_id and bc.id = r.buyer_contact_id
  left join lateral (
    select ct2.*
    from public.contracts ct2
    where ct2.org_id = p_org_id
      and ct2.project_id = a.project_id
      and ct2.contract_type = 'purchase_agreement'
    order by (ct2.status = 'active') desc, ct2.signed_at desc nulls last
    limit 1
  ) ct on a.project_id is not null
  left join lateral (
    select cl2.*
    from public.closings cl2
    where cl2.org_id = p_org_id
      and cl2.project_id = a.project_id
      and cl2.status <> 'cancelled'
    limit 1
  ) cl on a.project_id is not null
  left join lateral (
    select pc2.*
    from public.prospect_contacts pc2
    where pc2.org_id = p_org_id
      and pc2.prospect_id = a.prospect_id
    order by pc2.is_primary desc, pc2.created_at
    limit 1
  ) pc on a.prospect_id is not null
  left join lateral (
    select count(*) as open_count
    from public.closing_checklist_items i
    where i.org_id = p_org_id
      and i.closing_id = cl.id
      and i.is_gate
      and i.status = 'open'
  ) gates on cl.id is not null
  cross join lateral (
    select
      case
        when cl.status = 'closed' then 'closed'
        when cl.status in ('scheduled', 'cleared_to_close') then 'closing'
        when ct.status = 'active' and l.status = 'started' then 'building'
        when ct.status = 'active' then 'contract'
        when r.status in ('reserved', 'converted') then 'contract'
        when r.status = 'hold' then 'hold'
        when p.status::text = 'lost' then 'lost'
        -- A won prospect with no reservation was converted through the
        -- residential estimate flow; it is sold, not still being worked.
        when p.status::text = 'won' then 'contract'
        when p.status::text = 'new' then 'inquiry'
        else 'working'
      end as value,
      case
        when cl.status = 'closed' then 7
        when cl.status in ('scheduled', 'cleared_to_close') then 6
        when ct.status = 'active' and l.status = 'started' then 5
        when ct.status = 'active' then 4
        when r.status in ('reserved', 'converted') then 4
        when r.status = 'hold' then 3
        when p.status::text = 'lost' then 0
        when p.status::text = 'won' then 4
        when p.status::text = 'new' then 1
        else 2
      end as rank
  ) stage
  where (p_deal_id is null or a.deal_id = p_deal_id)
    and (p_community_id is null or a.community_id = p_community_id)
    and (p_division_id is null or c.division_id = p_division_id or a.community_id is null)
    and (p_include_closed or stage.rank between 1 and 6)
  order by stage.rank between 1 and 6 desc, stage.rank, coalesce(r.created_at, p.created_at, ct.created_at) desc
  limit greatest(p_limit, 1);
$$;

revoke all on function public.get_sales_deals(uuid, uuid, uuid, boolean, integer, text, boolean) from public, anon;
grant execute on function public.get_sales_deals(uuid, uuid, uuid, boolean, integer, text, boolean) to authenticated, service_role;

comment on function public.get_sales_deals(uuid, uuid, uuid, boolean, integer, text, boolean) is
  'One row per production sales deal, joining prospects, lot reservations, purchase agreements and closings into a single observed-stage lifecycle. Powers the Sales board. p_include_communityless = false leaves community-less prospects to the Pipeline.';
