-- EP08-08: a purchase order is issued as a version, and the vendor answers it.
--
-- Until now "issued" meant status = 'approved' and nothing else: the vendor saw
-- the live purchase order, any project member could rewrite an approved one
-- through the data API with no event, audit or revision, issued_at was stamped
-- on the DRAFT insert by PO generation, and nobody told the vendor a PO existed.
-- This migration makes issuance a record and the vendor's answer a fact:
--
-- 1. An approved (issued) purchase order is LOCKED against member writes, header
--    money/scope and lines alike. Changes go through a variance purchase order,
--    or the order is returned to draft (which un-issues it; approving it again is
--    a new issue the vendor must answer). The fence is the authenticated role:
--    services that change an issued order run as the service role after their
--    own permission check, and definer functions (VPO approval, completion
--    billing, starts release generation, the PO generation commit) are
--    unaffected because none of them edit the issued terms of an approved PO.
-- 2. po_issue_versions: append-only snapshot of the issued terms with a hash,
--    written by trigger whenever the terms the vendor is held to change:
--    the order is approved, a VPO on it is approved, or an approved VPO is voided.
--    The hash is a pure function of the order, its lines and its approved VPOs
--    (po_terms_hash), so a stale answer is detectable without trusting the client.
-- 3. po_acknowledgments (+ lines): the vendor's accept or dispute of ONE version,
--    per line for quantity, date and scope, with a reason. Written only by
--    record_po_acknowledgment (service role), which locks the order and refuses
--    an answer to anything but the current version. Resolved by purchasing
--    through resolve_po_acknowledgment with po_exception.resolve (already held by
--    org_owner, org_admin and org_purchasing_manager; no new RBAC key).
-- 4. portal_access_tokens.can_acknowledge_purchase_orders, backfilled true where
--    the link already views purchase orders.
-- 5. list_po_acknowledgment_queue: one row per issued order with its derived
--    state (pending, revised, disputed, accepted, closed), counted and paged in SQL.
-- 6. Each version queues one outbox job, po_issue_notice, that mails the vendor
--    exactly once through the trade notice path (kind po_issued).
--
-- Existing issued orders get a 'backfill' revision 1 so the vendor portal has a
-- version to show; those are not asked to answer (state unrequested) until a
-- new version is issued.

-- ---------------------------------------------------------------------------
-- 1. Helpers.
-- ---------------------------------------------------------------------------

-- The statuses in which a purchase order has been issued to its vendor.
create or replace function public.po_status_is_issued(p_status text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_status in ('approved', 'active', 'complete', 'completed');
$$;

-- The terms the vendor is held to, as one document: the order, its lines in
-- order, and the variance orders approved against it. Only fields that change
-- what the vendor owes or delivers are in it.
create or replace function public.po_issue_snapshot(p_org_id uuid, p_commitment_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'title', c.title,
    'contract_number', c.contract_number,
    'scope', c.scope,
    'terms', c.terms,
    'start_date', c.start_date,
    'end_date', c.end_date,
    'total_cents', c.total_cents,
    'retainage_percent', c.retainage_percent,
    'company_id', c.company_id,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'description', l.description, 'quantity', l.quantity, 'unit', l.unit,
        'unit_cost_cents', l.unit_cost_cents, 'scheduled_value_cents', l.scheduled_value_cents
      ) order by l.sort_order, l.id)
      from public.commitment_lines l
      where l.org_id = c.org_id and l.commitment_id = c.id
    ), '[]'::jsonb),
    'changes', coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'title', o.title, 'total_cents', o.total_cents) order by o.created_at, o.id)
      from public.commitment_change_orders o
      where o.org_id = c.org_id and o.commitment_id = c.id and o.status = 'approved'
    ), '[]'::jsonb)
  )
  from public.commitments c
  where c.org_id = p_org_id and c.id = p_commitment_id;
$$;

create or replace function public.po_terms_hash(p_org_id uuid, p_commitment_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(sha256(convert_to(public.po_issue_snapshot(p_org_id, p_commitment_id)::text, 'UTF8')), 'hex');
$$;

revoke all on function public.po_issue_snapshot(uuid, uuid) from public, anon, authenticated;
revoke all on function public.po_terms_hash(uuid, uuid) from public, anon, authenticated;
-- Pure, and called from the triggers below as the invoking role.
grant execute on function public.po_status_is_issued(text) to authenticated, service_role;
grant execute on function public.po_issue_snapshot(uuid, uuid) to service_role;
grant execute on function public.po_terms_hash(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Issued versions.
-- ---------------------------------------------------------------------------

create table if not exists public.po_issue_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  commitment_id uuid not null references public.commitments(id) on delete cascade,
  company_id uuid references public.companies(id) on delete set null,
  revision integer not null,
  terms_hash text not null,
  snapshot jsonb not null,
  reason text not null,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint po_issue_versions_reason_check check (reason in ('backfill', 'approved', 'reapproved', 'vpo_approved', 'vpo_voided')),
  constraint po_issue_versions_revision_check check (revision >= 1),
  constraint po_issue_versions_revision_key unique (commitment_id, revision)
);

create index if not exists po_issue_versions_org_project_idx on public.po_issue_versions (org_id, project_id);
create index if not exists po_issue_versions_commitment_idx on public.po_issue_versions (org_id, commitment_id, revision desc);
create index if not exists po_issue_versions_project_idx on public.po_issue_versions (project_id);
create index if not exists po_issue_versions_company_idx on public.po_issue_versions (company_id) where company_id is not null;
create index if not exists po_issue_versions_created_by_idx on public.po_issue_versions (created_by) where created_by is not null;

comment on table public.po_issue_versions is
  'Append-only snapshot of the terms a vendor was issued on one purchase order, with the hash an acknowledgment is bound to. Written by tg_po_issue_* triggers (lib/services/po-acknowledgments.ts).';

create or replace function public.guard_po_issue_version_record()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'An issued purchase order version is a record and cannot be changed' using errcode = '42501';
end;
$$;

revoke all on function public.guard_po_issue_version_record() from public, anon, authenticated;

drop trigger if exists po_issue_versions_record on public.po_issue_versions;
create trigger po_issue_versions_record
  before update on public.po_issue_versions
  for each row execute function public.guard_po_issue_version_record();

alter table public.po_issue_versions enable row level security;

drop policy if exists po_issue_versions_read on public.po_issue_versions;
create policy po_issue_versions_read on public.po_issue_versions
  for select
  to authenticated
  using (public.has_org_permission(org_id, 'commitment.read') or public.has_org_permission(org_id, 'price_book.read'));

drop policy if exists po_issue_versions_division_scope on public.po_issue_versions;
create policy po_issue_versions_division_scope on public.po_issue_versions
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or project_id in (select public.member_reachable_project_ids())
  )
  with check (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or project_id in (select public.member_reachable_project_ids())
  );

revoke all on table public.po_issue_versions from anon, authenticated;
grant select on table public.po_issue_versions to authenticated;
grant all on table public.po_issue_versions to service_role;

-- Writes one version of an issued purchase order. The order row is locked first,
-- so two approvals racing on one order number their versions one after the other.
create or replace function public.record_po_issue_version(p_org_id uuid, p_commitment_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_commitment public.commitments%rowtype;
  v_snapshot jsonb;
  v_revision integer;
  v_id uuid;
  v_actor uuid := (select auth.uid());
begin
  select * into v_commitment from public.commitments
  where id = p_commitment_id and org_id = p_org_id and commitment_type = 'purchase_order'
  for update;
  if not found then
    return null;
  end if;
  v_snapshot := public.po_issue_snapshot(p_org_id, p_commitment_id);
  select coalesce(max(revision), 0) + 1 into v_revision from public.po_issue_versions where commitment_id = p_commitment_id;
  insert into public.po_issue_versions(org_id, project_id, commitment_id, company_id, revision, terms_hash, snapshot, reason, created_by)
  values (p_org_id, v_commitment.project_id, p_commitment_id, v_commitment.company_id, v_revision,
    encode(sha256(convert_to(v_snapshot::text, 'UTF8')), 'hex'), v_snapshot, p_reason,
    (select u.id from public.app_users u where u.id = v_actor))
  returning id into v_id;

  insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, after_data, source)
  values (p_org_id, (select u.id from public.app_users u where u.id = v_actor), 'insert', 'po_issue_version', v_id,
    jsonb_build_object('commitment_id', p_commitment_id, 'project_id', v_commitment.project_id, 'revision', v_revision, 'reason', p_reason),
    'po.issue');
  insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
  values (p_org_id, 'po_issue_version.created', 'po_issue_version', v_id,
    jsonb_build_object('commitment_id', p_commitment_id, 'project_id', v_commitment.project_id, 'revision', v_revision, 'reason', p_reason),
    'activity');

  if v_commitment.company_id is not null then
    insert into public.outbox(org_id, job_type, dedupe_key, payload)
    values (p_org_id, 'po_issue_notice', 'po_issue_notice:' || v_id::text,
      jsonb_build_object('version_id', v_id, 'commitment_id', p_commitment_id, 'project_id', v_commitment.project_id,
        'company_id', v_commitment.company_id, 'revision', v_revision, 'reason', p_reason, 'actor_id', v_actor))
    on conflict do nothing;
  end if;
  return v_id;
end;
$$;

revoke all on function public.record_po_issue_version(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.record_po_issue_version(uuid, uuid, text) to service_role;

-- issued_at is when the order was issued: stamped on the transition into an
-- issued status, cleared while the order is a draft (PO generation used to stamp
-- it on the draft insert).
create or replace function public.tg_po_issued_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.commitment_type <> 'purchase_order' then
    return new;
  end if;
  if public.po_status_is_issued(new.status) then
    if tg_op = 'INSERT' then
      new.issued_at := coalesce(new.issued_at, now());
    elsif not public.po_status_is_issued(old.status) then
      new.issued_at := now();
    end if;
  elsif new.status = 'draft' then
    new.issued_at := null;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_po_issued_at() from public, anon, authenticated;

drop trigger if exists commitments_po_issued_at on public.commitments;
create trigger commitments_po_issued_at
  before insert or update of status on public.commitments
  for each row execute function public.tg_po_issued_at();

-- Approving an order issues it: version 1, or a re-issue after it went back to draft.
create or replace function public.tg_po_issue_on_commitment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.commitment_type <> 'purchase_order' or not public.po_status_is_issued(new.status) then
    return null;
  end if;
  if tg_op = 'UPDATE' and public.po_status_is_issued(old.status) then
    return null;
  end if;
  perform public.record_po_issue_version(new.org_id, new.id,
    case when exists (select 1 from public.po_issue_versions v where v.commitment_id = new.id) then 'reapproved' else 'approved' end);
  return null;
end;
$$;

revoke all on function public.tg_po_issue_on_commitment() from public, anon, authenticated;

drop trigger if exists commitments_po_issue_version on public.commitments;
create trigger commitments_po_issue_version
  after insert or update of status on public.commitments
  for each row execute function public.tg_po_issue_on_commitment();

-- A variance order approved against an issued order, or an approved one voided,
-- changes what the vendor is held to: a new version.
create or replace function public.tg_po_issue_on_change_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text;
begin
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    v_reason := 'vpo_approved';
  elsif tg_op = 'UPDATE' and old.status = 'approved' and new.status is distinct from 'approved' then
    v_reason := 'vpo_voided';
  else
    return null;
  end if;
  if exists (
    select 1 from public.commitments c
    where c.id = new.commitment_id and c.org_id = new.org_id and c.commitment_type = 'purchase_order' and public.po_status_is_issued(c.status)
  ) then
    perform public.record_po_issue_version(new.org_id, new.commitment_id, v_reason);
  end if;
  return null;
end;
$$;

revoke all on function public.tg_po_issue_on_change_order() from public, anon, authenticated;

drop trigger if exists commitment_change_orders_po_issue_version on public.commitment_change_orders;
create trigger commitment_change_orders_po_issue_version
  after insert or update of status on public.commitment_change_orders
  for each row execute function public.tg_po_issue_on_change_order();

-- ---------------------------------------------------------------------------
-- 3. The lock on an issued purchase order.
--
-- Only the data-API role is fenced. A member (any project member passes the
-- table's row policy) cannot edit the terms of an issued order or its lines,
-- move it out of the issued statuses, or delete it. Everything the application
-- does to an issued order on purpose runs as the service role or in a definer
-- function, after its own permission check.
-- ---------------------------------------------------------------------------

create or replace function public.tg_po_issued_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_parent_id uuid;
  v_type text;
  v_status text;
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;

  if tg_table_name = 'commitments' then
    if old.commitment_type <> 'purchase_order' or not public.po_status_is_issued(old.status) then
      return coalesce(new, old);
    end if;
    if tg_op = 'DELETE' then
      raise exception 'An approved purchase order cannot be deleted; return it to draft first' using errcode = '42501';
    end if;
    if row(new.org_id, new.project_id, new.company_id, new.contact_id, new.commitment_type, new.title, new.scope, new.terms,
           new.total_cents, new.currency, new.contract_number, new.retainage_percent, new.start_date, new.end_date, new.issued_at)
       is distinct from
       row(old.org_id, old.project_id, old.company_id, old.contact_id, old.commitment_type, old.title, old.scope, old.terms,
           old.total_cents, old.currency, old.contract_number, old.retainage_percent, old.start_date, old.end_date, old.issued_at) then
      raise exception 'An approved purchase order is locked: raise a variance order to change it, or return it to draft' using errcode = '42501';
    end if;
    if not public.po_status_is_issued(new.status) then
      raise exception 'An approved purchase order is returned to draft or cancelled from the purchase order, not by editing its row' using errcode = '42501';
    end if;
    return new;
  end if;

  -- commitment_lines: the order the line is on, before and after the change.
  for v_parent_id in
    select distinct x from unnest(array[
      case when tg_op <> 'INSERT' then old.commitment_id end,
      case when tg_op <> 'DELETE' then new.commitment_id end
    ]) x where x is not null
  loop
    select c.commitment_type, c.status into v_type, v_status from public.commitments c where c.id = v_parent_id;
    if v_type = 'purchase_order' and public.po_status_is_issued(v_status) then
      if tg_op = 'UPDATE'
         and row(new.org_id, new.commitment_id, new.cost_code_id, new.budget_line_id, new.description, new.quantity, new.unit,
                 new.unit_cost_cents, new.scheduled_value_cents, new.retainage_percent)
             is not distinct from
             row(old.org_id, old.commitment_id, old.cost_code_id, old.budget_line_id, old.description, old.quantity, old.unit,
                 old.unit_cost_cents, old.scheduled_value_cents, old.retainage_percent) then
        continue;
      end if;
      raise exception 'The lines of an approved purchase order are locked: raise a variance order to change them, or return it to draft' using errcode = '42501';
    end if;
  end loop;
  return coalesce(new, old);
end;
$$;

revoke all on function public.tg_po_issued_lock() from public, anon, authenticated;

drop trigger if exists commitments_po_issued_lock on public.commitments;
create trigger commitments_po_issued_lock
  before update or delete on public.commitments
  for each row execute function public.tg_po_issued_lock();

drop trigger if exists commitment_lines_po_issued_lock on public.commitment_lines;
create trigger commitment_lines_po_issued_lock
  before insert or update or delete on public.commitment_lines
  for each row execute function public.tg_po_issued_lock();

-- ---------------------------------------------------------------------------
-- 4. The vendor's answer.
-- ---------------------------------------------------------------------------

create table if not exists public.po_acknowledgments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  commitment_id uuid not null references public.commitments(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  issue_version_id uuid not null references public.po_issue_versions(id) on delete cascade,
  terms_hash text not null,
  response text not null,
  reason text,
  portal_token_id uuid references public.portal_access_tokens(id) on delete set null,
  responded_at timestamptz not null default now(),
  status text not null default 'open',
  resolution text,
  resolved_by uuid references public.app_users(id),
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint po_acknowledgments_response_check check (response in ('accepted', 'disputed')),
  constraint po_acknowledgments_status_check check (status in ('open', 'resolved', 'superseded')),
  constraint po_acknowledgments_resolution_check check (resolution is null or resolution in ('upheld', 'withdrawn')),
  constraint po_acknowledgments_reason_check check (
    (reason is null or length(reason) <= 2000)
    and (response = 'accepted' or length(btrim(coalesce(reason, ''))) >= 3)
  ),
  constraint po_acknowledgments_resolved_check check (
    (status = 'resolved') = (resolution is not null and resolved_at is not null and resolved_by is not null)
  ),
  constraint po_acknowledgments_resolution_kind_check check (resolution is null or response = 'disputed'),
  constraint po_acknowledgments_note_check check (resolution_note is null or length(resolution_note) <= 2000)
);

-- One live answer per order: answering again supersedes the last.
create unique index if not exists po_acknowledgments_open_key
  on public.po_acknowledgments (commitment_id) where status = 'open';
create index if not exists po_acknowledgments_org_project_idx on public.po_acknowledgments (org_id, project_id);
create index if not exists po_acknowledgments_version_idx on public.po_acknowledgments (issue_version_id, responded_at desc);
create index if not exists po_acknowledgments_commitment_idx on public.po_acknowledgments (org_id, commitment_id, responded_at desc);
create index if not exists po_acknowledgments_project_idx on public.po_acknowledgments (project_id);
create index if not exists po_acknowledgments_company_idx on public.po_acknowledgments (company_id);
create index if not exists po_acknowledgments_token_idx
  on public.po_acknowledgments (portal_token_id) where portal_token_id is not null;
create index if not exists po_acknowledgments_resolved_by_idx
  on public.po_acknowledgments (resolved_by) where resolved_by is not null;

comment on table public.po_acknowledgments is
  'A vendor''s accept or dispute of ONE issued version of a purchase order. Written by record_po_acknowledgment, closed by resolve_po_acknowledgment (lib/services/po-acknowledgments.ts).';

create table if not exists public.po_acknowledgment_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  acknowledgment_id uuid not null references public.po_acknowledgments(id) on delete cascade,
  commitment_line_id uuid not null references public.commitment_lines(id) on delete cascade,
  kind text not null,
  proposed_quantity numeric,
  promised_date date,
  note text,
  created_at timestamptz not null default now(),
  constraint po_acknowledgment_lines_kind_check check (kind in ('quantity', 'date', 'scope')),
  constraint po_acknowledgment_lines_fact_check check (
    (kind = 'quantity' and proposed_quantity is not null and proposed_quantity >= 0)
    or (kind = 'date' and promised_date is not null)
    or (kind = 'scope' and length(btrim(coalesce(note, ''))) >= 3)
  ),
  constraint po_acknowledgment_lines_note_check check (note is null or length(note) <= 2000)
);

create index if not exists po_acknowledgment_lines_ack_idx on public.po_acknowledgment_lines (org_id, acknowledgment_id);
create index if not exists po_acknowledgment_lines_line_idx on public.po_acknowledgment_lines (commitment_line_id);

-- What the vendor said, and about which version, is a record.
create or replace function public.guard_po_acknowledgment_record()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'po_acknowledgment_lines' then
    raise exception 'A vendor''s answer cannot be changed; answer again instead' using errcode = '42501';
  end if;
  if row(new.org_id, new.project_id, new.commitment_id, new.company_id, new.issue_version_id, new.terms_hash,
         new.response, new.reason, new.responded_at)
     is distinct from
     row(old.org_id, old.project_id, old.commitment_id, old.company_id, old.issue_version_id, old.terms_hash,
         old.response, old.reason, old.responded_at) then
    raise exception 'A vendor''s answer cannot be changed; answer again instead' using errcode = '42501';
  end if;
  if old.status <> 'open' and new.status is distinct from old.status then
    raise exception 'This answer is already closed' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_po_acknowledgment_record() from public, anon, authenticated;

drop trigger if exists po_acknowledgments_record on public.po_acknowledgments;
create trigger po_acknowledgments_record
  before update on public.po_acknowledgments
  for each row execute function public.guard_po_acknowledgment_record();

drop trigger if exists po_acknowledgment_lines_record on public.po_acknowledgment_lines;
create trigger po_acknowledgment_lines_record
  before update on public.po_acknowledgment_lines
  for each row execute function public.guard_po_acknowledgment_record();

drop trigger if exists po_acknowledgments_set_updated_at on public.po_acknowledgments;
create trigger po_acknowledgments_set_updated_at
  before update on public.po_acknowledgments
  for each row execute function public.tg_set_updated_at();

alter table public.po_acknowledgments enable row level security;
alter table public.po_acknowledgment_lines enable row level security;

drop policy if exists po_acknowledgments_read on public.po_acknowledgments;
create policy po_acknowledgments_read on public.po_acknowledgments
  for select
  to authenticated
  using (public.has_org_permission(org_id, 'commitment.read') or public.has_org_permission(org_id, 'price_book.read'));

drop policy if exists po_acknowledgments_division_scope on public.po_acknowledgments;
create policy po_acknowledgments_division_scope on public.po_acknowledgments
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or project_id in (select public.member_reachable_project_ids())
  )
  with check (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or project_id in (select public.member_reachable_project_ids())
  );

drop policy if exists po_acknowledgment_lines_read on public.po_acknowledgment_lines;
create policy po_acknowledgment_lines_read on public.po_acknowledgment_lines
  for select
  to authenticated
  using (exists (select 1 from public.po_acknowledgments a where a.id = po_acknowledgment_lines.acknowledgment_id and a.org_id = po_acknowledgment_lines.org_id));

revoke all on table public.po_acknowledgments from anon, authenticated;
revoke all on table public.po_acknowledgment_lines from anon, authenticated;
grant select on table public.po_acknowledgments to authenticated;
grant select on table public.po_acknowledgment_lines to authenticated;
grant all on table public.po_acknowledgments to service_role;
grant all on table public.po_acknowledgment_lines to service_role;

-- ---------------------------------------------------------------------------
-- 5. Portal permission.
-- ---------------------------------------------------------------------------

alter table public.portal_access_tokens
  add column if not exists can_acknowledge_purchase_orders boolean not null default false;

update public.portal_access_tokens
set can_acknowledge_purchase_orders = true
where can_view_purchase_orders is true and can_acknowledge_purchase_orders is false;

-- ---------------------------------------------------------------------------
-- 6. The widened notice kinds.
-- ---------------------------------------------------------------------------

alter table public.trade_notice_deliveries drop constraint if exists trade_notice_deliveries_kind_check;
alter table public.trade_notice_deliveries
  add constraint trade_notice_deliveries_kind_check check (kind in ('lookahead', 'release', 'schedule_change', 'po_issued'));

-- ---------------------------------------------------------------------------
-- 7. Recording and closing answers.
-- ---------------------------------------------------------------------------

-- p_lines: [{commitment_line_id, kind, proposed_quantity?, promised_date?, note?}].
-- An acceptance may carry promised dates; a dispute must name at least one line.
create or replace function public.record_po_acknowledgment(
  p_org_id uuid,
  p_portal_token_id uuid,
  p_company_id uuid,
  p_commitment_id uuid,
  p_issue_version_id uuid,
  p_terms_hash text,
  p_response text,
  p_reason text,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_commitment public.commitments%rowtype;
  v_version public.po_issue_versions%rowtype;
  v_id uuid;
  v_line jsonb;
  v_lines jsonb := coalesce(p_lines, '[]'::jsonb);
begin
  if p_response not in ('accepted', 'disputed') then
    raise exception 'Answer accepted or disputed' using errcode = '22023';
  end if;
  if jsonb_typeof(v_lines) <> 'array' then
    raise exception 'The line details are not a list' using errcode = '22023';
  end if;
  if p_response = 'disputed' and length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Tell the builder why you dispute this order' using errcode = '22023';
  end if;
  if p_response = 'disputed' and jsonb_array_length(v_lines) = 0 then
    raise exception 'Name the line, and the quantity, date or scope you dispute' using errcode = '22023';
  end if;

  select * into v_commitment from public.commitments
  where id = p_commitment_id and org_id = p_org_id and commitment_type = 'purchase_order'
  for update;
  if not found or v_commitment.company_id is distinct from p_company_id then
    raise exception 'That purchase order is not issued to your company' using errcode = '42501';
  end if;
  if not public.po_status_is_issued(v_commitment.status) then
    raise exception 'That purchase order is no longer issued' using errcode = '40001';
  end if;

  select * into v_version from public.po_issue_versions
  where commitment_id = p_commitment_id order by revision desc limit 1;
  if not found
     or v_version.id is distinct from p_issue_version_id
     or v_version.terms_hash is distinct from p_terms_hash
     or public.po_terms_hash(p_org_id, p_commitment_id) is distinct from p_terms_hash then
    raise exception 'The purchase order changed; reload to see the current version' using errcode = '40001';
  end if;

  for v_line in select e from jsonb_array_elements(v_lines) e loop
    if not exists (
      select 1 from public.commitment_lines l
      where l.id = (v_line->>'commitment_line_id')::uuid and l.commitment_id = p_commitment_id and l.org_id = p_org_id
    ) then
      raise exception 'A line you answered is not on this purchase order' using errcode = '22023';
    end if;
  end loop;

  update public.po_acknowledgments set status = 'superseded'
  where commitment_id = p_commitment_id and status = 'open';

  insert into public.po_acknowledgments(
    org_id, project_id, commitment_id, company_id, issue_version_id, terms_hash, response, reason, portal_token_id
  ) values (
    p_org_id, v_commitment.project_id, p_commitment_id, p_company_id, v_version.id, p_terms_hash,
    p_response, nullif(btrim(p_reason), ''), p_portal_token_id
  ) returning id into v_id;

  insert into public.po_acknowledgment_lines(org_id, acknowledgment_id, commitment_line_id, kind, proposed_quantity, promised_date, note)
  select p_org_id, v_id, (e->>'commitment_line_id')::uuid, e->>'kind',
    nullif(e->>'proposed_quantity', '')::numeric, nullif(e->>'promised_date', '')::date, nullif(btrim(e->>'note'), '')
  from jsonb_array_elements(v_lines) e;

  insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, after_data, source)
  values (p_org_id, null, 'insert', 'po_acknowledgment', v_id,
    jsonb_build_object('commitment_id', p_commitment_id, 'company_id', p_company_id, 'project_id', v_commitment.project_id,
      'response', p_response, 'revision', v_version.revision, 'terms_hash', p_terms_hash,
      'lines', jsonb_array_length(v_lines), 'portal_token_id', p_portal_token_id),
    'sub_portal');
  insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
  values (p_org_id, 'po_acknowledgment.recorded', 'po_acknowledgment', v_id,
    jsonb_build_object('commitment_id', p_commitment_id, 'company_id', p_company_id, 'project_id', v_commitment.project_id,
      'response', p_response, 'revision', v_version.revision), 'activity');

  return jsonb_build_object('id', v_id, 'project_id', v_commitment.project_id, 'title', v_commitment.title,
    'contract_number', v_commitment.contract_number, 'revision', v_version.revision,
    'created_by', v_commitment.metadata->>'created_by_user_id');
end;
$$;

revoke all on function public.record_po_acknowledgment(uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_po_acknowledgment(uuid, uuid, uuid, uuid, uuid, text, text, text, jsonb) to service_role;

-- upheld: the terms stand and the vendor is asked again with the note.
-- withdrawn: the dispute is closed without a decision on the terms.
create or replace function public.resolve_po_acknowledgment(
  p_org_id uuid,
  p_actor_id uuid,
  p_acknowledgment_id uuid,
  p_resolution text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.po_acknowledgments%rowtype;
  v_latest uuid;
begin
  if p_resolution not in ('upheld', 'withdrawn') then
    raise exception 'Resolve a dispute as upheld or withdrawn' using errcode = '22023';
  end if;
  if length(btrim(coalesce(p_note, ''))) < 3 then
    raise exception 'Say what was decided' using errcode = '22023';
  end if;
  perform public.assert_starts_org_actor_permission(p_org_id, p_actor_id, 'po_exception.resolve');
  select * into v_row from public.po_acknowledgments
  where id = p_acknowledgment_id and org_id = p_org_id
  for update;
  if not found then
    raise exception 'Acknowledgment not found' using errcode = '42501';
  end if;
  if not public.starts_actor_reaches_division(p_org_id, p_actor_id,
       (select p.division_id from public.projects p where p.id = v_row.project_id and p.org_id = p_org_id)) then
    raise exception 'The house is outside your division access' using errcode = '42501';
  end if;
  if v_row.status <> 'open' then
    raise exception 'This answer was already closed' using errcode = '40001';
  end if;
  if v_row.response <> 'disputed' then
    raise exception 'Only a dispute is resolved; an acceptance needs nothing' using errcode = '22023';
  end if;
  select v.id into v_latest from public.po_issue_versions v where v.commitment_id = v_row.commitment_id order by v.revision desc limit 1;
  if v_latest is distinct from v_row.issue_version_id then
    raise exception 'The purchase order was revised after this dispute; the vendor answers the new version' using errcode = '40001';
  end if;
  update public.po_acknowledgments
  set status = 'resolved', resolution = p_resolution, resolved_by = p_actor_id, resolved_at = now(),
      resolution_note = btrim(p_note)
  where id = p_acknowledgment_id;
  insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
  values (p_org_id, p_actor_id, 'update', 'po_acknowledgment', p_acknowledgment_id,
    jsonb_build_object('status', 'open'),
    jsonb_build_object('status', 'resolved', 'resolution', p_resolution, 'note', btrim(p_note)),
    'po.acknowledgment_resolved');
  insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
  values (p_org_id, 'po_acknowledgment.resolved', 'po_acknowledgment', p_acknowledgment_id,
    jsonb_build_object('resolution', p_resolution, 'project_id', v_row.project_id, 'commitment_id', v_row.commitment_id,
      'actor_id', p_actor_id), 'activity');
  return jsonb_build_object('id', p_acknowledgment_id, 'resolution', p_resolution);
end;
$$;

revoke all on function public.resolve_po_acknowledgment(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.resolve_po_acknowledgment(uuid, uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 8. The Purchasing desk queue.
--
-- One row per issued order, in the state of its CURRENT version:
--   unrequested  backfilled version nobody has been asked about
--   pending      current version unanswered (or an upheld dispute asked again)
--   revised      current version unanswered after the vendor answered an earlier one
--   disputed     current version disputed, open
--   accepted     current version accepted
--   closed       dispute closed without a decision
-- p_state: 'action' = pending + revised + disputed; 'all'; or one state.
-- The caller has already authorized the read and passes its division and
-- membership scope; counts, paging and the cap are decided here.
-- ---------------------------------------------------------------------------

create or replace function public.list_po_acknowledgment_queue(
  p_org_id uuid,
  p_division_ids uuid[],
  p_member_user_id uuid,
  p_community_id uuid,
  p_state text,
  p_limit integer,
  p_offset integer
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with latest as (
    select distinct on (v.commitment_id) v.id, v.commitment_id, v.revision, v.reason, v.created_at
    from public.po_issue_versions v
    where v.org_id = p_org_id
    order by v.commitment_id, v.revision desc
  ), base as (
    select c.id commitment_id, c.project_id, c.company_id, c.title, c.contract_number, c.total_cents,
      l.id version_id, l.revision, l.reason version_reason, l.created_at issued_at,
      a.id ack_id, a.response, a.status ack_status, a.resolution, a.reason ack_reason, a.resolution_note, a.responded_at,
      exists (select 1 from public.po_acknowledgments o
        where o.commitment_id = c.id and o.issue_version_id <> l.id and o.status <> 'superseded') had_prior,
      p.name project_name, co.name company_name
    from public.commitments c
    join latest l on l.commitment_id = c.id
    join public.projects p on p.org_id = p_org_id and p.id = c.project_id
    left join public.companies co on co.org_id = p_org_id and co.id = c.company_id
    left join lateral (
      select x.* from public.po_acknowledgments x
      where x.commitment_id = c.id and x.issue_version_id = l.id and x.status <> 'superseded'
      order by x.responded_at desc, x.id desc limit 1
    ) a on true
    where c.org_id = p_org_id and c.commitment_type = 'purchase_order' and public.po_status_is_issued(c.status)
      and (p_division_ids is null or p.division_id = any (p_division_ids))
      and (p_member_user_id is null or exists (
        select 1 from public.project_members pm where pm.org_id = p_org_id and pm.project_id = c.project_id
          and pm.user_id = p_member_user_id and pm.status = 'active'))
      and (p_community_id is null or exists (
        select 1 from public.lots lt where lt.org_id = p_org_id and lt.project_id = c.project_id and lt.community_id = p_community_id))
  ), derived as (
    select b.*, case
      when b.ack_id is null and b.had_prior then 'revised'
      when b.ack_id is null and b.version_reason = 'backfill' then 'unrequested'
      when b.ack_id is null then 'pending'
      when b.ack_status = 'open' and b.response = 'accepted' then 'accepted'
      when b.ack_status = 'open' and b.response = 'disputed' then 'disputed'
      when b.resolution = 'withdrawn' then 'closed'
      else 'pending' end state
    from base b
  ), shown as (
    select * from derived d
    where case when p_state = 'all' then true
      when p_state = 'action' then d.state in ('pending', 'revised', 'disputed')
      else d.state = p_state end
  )
  select jsonb_build_object(
    'total', (select count(*) from shown),
    'counts', jsonb_build_object(
      'pending', (select count(*) from derived where state = 'pending'),
      'revised', (select count(*) from derived where state = 'revised'),
      'disputed', (select count(*) from derived where state = 'disputed'),
      'accepted', (select count(*) from derived where state = 'accepted')),
    'rows', coalesce((select jsonb_agg(to_jsonb(r) order by r.sort_rank, r.issued_at, r.commitment_id) from (
      select s.commitment_id, s.project_id, s.project_name, s.company_id, s.company_name, s.title, s.contract_number,
        s.total_cents, s.version_id, s.revision, s.issued_at, s.state, s.ack_id, s.response, s.ack_reason, s.resolution_note,
        s.responded_at,
        case s.state when 'disputed' then 0 when 'revised' then 1 when 'pending' then 2 else 3 end sort_rank,
        coalesce((select jsonb_agg(jsonb_build_object('commitment_line_id', al.commitment_line_id, 'kind', al.kind,
            'proposed_quantity', al.proposed_quantity, 'promised_date', al.promised_date, 'note', al.note,
            'description', cl.description) order by al.created_at, al.id)
          from public.po_acknowledgment_lines al
          left join public.commitment_lines cl on cl.id = al.commitment_line_id
          where s.ack_id is not null and al.acknowledgment_id = s.ack_id), '[]'::jsonb) dispute_lines
      from shown s
      order by sort_rank, s.issued_at, s.commitment_id
      limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0)) r), '[]'::jsonb));
$$;

revoke all on function public.list_po_acknowledgment_queue(uuid, uuid[], uuid, uuid, text, integer, integer) from public, anon, authenticated;
grant execute on function public.list_po_acknowledgment_queue(uuid, uuid[], uuid, uuid, text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Existing issued orders.
-- ---------------------------------------------------------------------------

-- A draft was never issued: PO generation stamped issued_at on the draft insert.
update public.commitments set issued_at = null
where commitment_type = 'purchase_order' and status = 'draft' and issued_at is not null;

update public.commitments set issued_at = updated_at
where commitment_type = 'purchase_order' and public.po_status_is_issued(status) and issued_at is null;

insert into public.po_issue_versions(org_id, project_id, commitment_id, company_id, revision, terms_hash, snapshot, reason, created_at)
select c.org_id, c.project_id, c.id, c.company_id, 1,
  encode(sha256(convert_to(s.snapshot::text, 'UTF8')), 'hex'), s.snapshot, 'backfill', coalesce(c.issued_at, c.updated_at)
from public.commitments c
cross join lateral (select public.po_issue_snapshot(c.org_id, c.id) snapshot) s
where c.commitment_type = 'purchase_order' and public.po_status_is_issued(c.status)
  and not exists (select 1 from public.po_issue_versions v where v.commitment_id = c.id);

-- ---------------------------------------------------------------------------
-- 10. The trade look-ahead infers a vendor from issued orders only.
--
-- Unchanged from 20261014165000 except one predicate: an order that was never
-- issued to the vendor (issued_at is stamped on approval) is not an assignment.
-- ---------------------------------------------------------------------------

create or replace function public.read_trade_lookahead_workspace(p_org uuid,p_actor uuid,p_weeks integer,p_division uuid default null,p_community uuid default null,p_q text default '',p_page integer default 1,p_group text default null,p_item_page integer default 1)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare start_day date:=(statement_timestamp() at time zone 'UTC')::date;end_day date;result jsonb;
begin
 if auth.uid() is null or auth.uid() is distinct from p_actor then raise exception 'Trade workspace authenticated actor mismatch' using errcode='42501';end if;
 if p_weeks is null or p_weeks not in(2,3,4) or p_page is null or p_page not between 1 and 1000000 or p_item_page is null or p_item_page not between 1 and 1000000 or p_q is null or length(p_q)>120 or length(p_group)>500 then raise exception 'Invalid trade workspace query';end if;
 end_day:=start_day+p_weeks*7;
 if exists(select 1 from public.trade_workspace_readable_homes(p_org,p_actor,p_division,p_community) h join public.lots l on l.project_id=h.project_id and l.org_id=p_org group by h.project_id having count(*)>1) then raise exception 'Trade home has multiple lot sources; reconcile the home before review';end if;
 with homes as materialized(select project_id from public.trade_workspace_readable_homes(p_org,p_actor,p_division,p_community)),
 schedule as materialized(select s.id,s.project_id,s.name,nullif(s.trade,'') trade,s.status,s.start_date,coalesce(s.end_date,s.start_date) end_date,s.cost_code_id,
 coalesce(case when nullif(l.block,'') is not null then l.block||'-'||l.lot_number else l.lot_number end,'Lot') lot_label,coalesce(c.name,'Community') community_name
 from public.schedule_items s join homes h on h.project_id=s.project_id left join public.lots l on l.project_id=s.project_id and l.org_id=p_org left join public.communities c on c.id=l.community_id and c.org_id=p_org
 where s.org_id=p_org and s.start_date<=end_day and coalesce(s.end_date,s.start_date)>=start_day and s.status not in('cancelled','completed')),
 assigned as materialized(select s.id,a.company_id,max(c.name) company_name,bool_or(a.confirmed_at is not null) confirmed from schedule s join public.schedule_assignments a on a.schedule_item_id=s.id and a.org_id=p_org and a.project_id=s.project_id join public.companies c on c.id=a.company_id and c.org_id=p_org group by s.id,a.company_id),
 fallback as (select s.id,case when count(distinct c.id)=1 then min(c.id::text)::uuid end company_id,case when count(distinct c.id)=1 then max(c.name) end company_name from schedule s
 join public.commitments po on po.org_id=p_org and po.project_id=s.project_id and po.commitment_type='purchase_order' and po.status in('approved','complete') and po.issued_at is not null
 join public.commitment_lines pl on pl.commitment_id=po.id and pl.org_id=p_org and pl.cost_code_id=s.cost_code_id
 join public.companies c on c.id=po.company_id and c.org_id=p_org where not exists(select 1 from assigned a where a.id=s.id) group by s.id),
 expanded as materialized(select s.*,coalesce(a.company_id,f.company_id) company_id,coalesce(a.company_name,f.company_name,'Unassigned') company_name,coalesce(a.confirmed,false) confirmed,
 case when coalesce(a.company_id,f.company_id) is null then 'unassigned' when a.company_id is null then 'inferred' else 'assigned' end assignment,
 '['||coalesce(to_json(coalesce(a.company_id,f.company_id)::text)::text,'null')||','||coalesce(to_json(s.trade)::text,'null')||']' group_key
 from schedule s left join assigned a on a.id=s.id left join fallback f on f.id=s.id),
 groups as materialized(select group_key,company_id,company_name,trade,count(*) item_count,count(*) filter(where confirmed) confirmed_count,count(*) filter(where assignment='inferred') inferred_count,min(start_date) first_date from expanded group by group_key,company_id,company_name,trade),
 matching as materialized(select * from groups where strpos(lower(company_name||' '||coalesce(trade,'')),lower(btrim(p_q)))>0),
 group_page as (select * from matching order by company_name collate "C",company_id nulls first,trade collate "C" nulls first offset (p_page-1)*50 limit 50),
 selected as (select * from groups where group_key=p_group),
 item_page as (select * from expanded where group_key=p_group order by start_date,id offset (p_item_page-1)*50 limit 50)
 select jsonb_build_object('orgId',p_org,'actorId',p_actor,'divisionId',p_division,'communityId',p_community,'weeks',p_weeks,'q',btrim(p_q),'group',p_group,
 'page',p_page,'pageSize',50,'itemPage',p_item_page,'itemPageSize',50,'total',(select count(*) from matching),'selectedUnavailable',p_group is not null and not exists(select 1 from selected),
 'rows',coalesce((select jsonb_agg(jsonb_build_object('key',group_key,'companyId',company_id,'companyName',company_name,'trade',trade,'itemCount',item_count,'confirmedCount',confirmed_count,'inferredCount',inferred_count,'firstDate',first_date) order by company_name collate "C",company_id nulls first,trade collate "C" nulls first) from group_page),'[]'::jsonb),
 'selected',(select jsonb_build_object('key',g.group_key,'companyId',g.company_id,'companyName',g.company_name,'trade',g.trade,'itemCount',g.item_count,'confirmedCount',g.confirmed_count,'inferredCount',g.inferred_count,'firstDate',g.first_date,
 'items',coalesce((select jsonb_agg(jsonb_build_object('scheduleItemId',id,'projectId',project_id,'lotLabel',lot_label,'communityName',community_name,'name',name,'startDate',start_date,'endDate',end_date,'status',status,'assignment',assignment,'confirmation',case when confirmed then 'confirmed' else 'unsent' end) order by start_date,id) from item_page),'[]'::jsonb)) from selected g)) into result;
 return result;
end $$;
