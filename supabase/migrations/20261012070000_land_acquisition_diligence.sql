-- Land deals: diligence before a purchase, and an acquisition decision that
-- keeps the version it decided.
--
-- Land used to enter Arc only once it was bought: a community with lots and
-- takedowns, or a Books acquisition journal. Nothing recorded the deal while it
-- was being evaluated -- who owned the title work, when the feasibility period
-- ran out, what the survey found -- or who approved buying it on which terms.
--
-- 1. land_opportunities: the deal. Facts only (price, lots, acreage, deposit,
--    contract and diligence dates, the resulting community); its stage is
--    derived in lib/land/diligence.ts, never stored. Walled by division like a
--    community. Never deleted: a dead deal is dropped with a reason.
-- 2. land_diligence_items: the checklist. Each item has an internal owner
--    and/or a consultant, a due date, a status and a finding. Evidence is files
--    linked through file_links (entity_type 'land_diligence_item').
-- 3. land_acquisition_reviews: one row per submitted version of the decision
--    (acquire or terminate). The terms, the items, the evidence (by file and
--    checksum) and the linked takedowns are frozen into `snapshot`, and
--    `content_hash` is the sha256 of that snapshot. One open review per deal.
--    Changing the deal, an item or its evidence while a review is open
--    supersedes it: approvers approve a version, and a changed deal needs a new
--    one.
-- 4. land_acquisition_approvals: the approvers named on a review (1-5 holders
--    of land.approve), parallel and unanimous. Each decision records the hash
--    of the version the approver was shown and must match the review's. The
--    submitter can never approve their own review. Any rejection returns the
--    version; the last approval approves it.
-- 5. lot_takedowns.land_opportunity_id: the takedowns a deal produced.
-- 6. files.land_opportunity_id / file_links.land_opportunity_id: diligence
--    documents (title, environmental, LOIs) are walled like the deal they
--    belong to, and readable only with land.read.
--    (Search documents for deals are stamped with the deal's division in
--    20261012080000, alongside entitlements.)
-- 7. RBAC: land.read, land.write (owner, admin, land manager) and land.approve
--    (owner, admin). The land manager runs the pipeline and does not approve it.
--
-- Reviews and approvals are written only through the three functions below;
-- authenticated callers can read them and nothing else.

set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. The deal.
-- ---------------------------------------------------------------------------

create table if not exists public.land_opportunities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  division_id uuid references public.divisions(id) on delete set null,
  name text not null,
  code text,
  seller_company_id uuid references public.companies(id) on delete set null,
  address text,
  city text,
  state text,
  county text,
  acreage numeric(10, 2),
  planned_lot_count integer,
  purchase_price_cents bigint,
  deposit_cents bigint not null default 0,
  contract_executed_on date,
  diligence_ends_on date,
  closing_target_on date,
  lead_user_id uuid references public.app_users(id) on delete set null,
  community_id uuid references public.communities(id) on delete set null,
  dropped_at timestamptz,
  dropped_reason text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint land_opportunities_name_check check (length(btrim(name)) > 0 and length(name) <= 200),
  constraint land_opportunities_lots_check check (planned_lot_count is null or planned_lot_count >= 0),
  constraint land_opportunities_money_check
    check (deposit_cents >= 0 and (purchase_price_cents is null or purchase_price_cents >= 0)),
  constraint land_opportunities_acreage_check check (acreage is null or acreage >= 0),
  constraint land_opportunities_dropped_check
    check ((dropped_at is null) = (dropped_reason is null)
           and (dropped_reason is null or length(btrim(dropped_reason)) >= 10)),
  constraint land_opportunities_notes_check check (notes is null or length(notes) <= 4000),
  constraint land_opportunities_metadata_check check (jsonb_typeof(metadata) = 'object'),
  constraint land_opportunities_org_name_key unique (org_id, name)
);

create index if not exists land_opportunities_org_idx
  on public.land_opportunities (org_id, dropped_at, diligence_ends_on);
create index if not exists land_opportunities_division_idx
  on public.land_opportunities (org_id, division_id) where division_id is not null;
create index if not exists land_opportunities_community_idx
  on public.land_opportunities (community_id) where community_id is not null;
create index if not exists land_opportunities_seller_idx
  on public.land_opportunities (seller_company_id) where seller_company_id is not null;
create index if not exists land_opportunities_lead_idx
  on public.land_opportunities (lead_user_id) where lead_user_id is not null;
create index if not exists land_opportunities_created_by_idx on public.land_opportunities (created_by);

comment on table public.land_opportunities is
  'A land deal being evaluated or bought. Stage is derived (lib/land/diligence.ts landDealStage); a dead deal is dropped with a reason, never deleted.';

-- ---------------------------------------------------------------------------
-- 2. Diligence items.
-- ---------------------------------------------------------------------------

create table if not exists public.land_diligence_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  land_opportunity_id uuid not null references public.land_opportunities(id) on delete cascade,
  title text not null,
  category text not null default 'other',
  owner_user_id uuid references public.app_users(id) on delete set null,
  owner_company_id uuid references public.companies(id) on delete set null,
  due_on date,
  status text not null default 'open',
  finding text,
  resolved_at timestamptz,
  resolved_by uuid references public.app_users(id) on delete set null,
  waived_reason text,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint land_diligence_items_title_check check (length(btrim(title)) > 0 and length(title) <= 200),
  constraint land_diligence_items_category_check check (category in (
    'title', 'survey', 'environmental', 'geotechnical', 'zoning', 'utilities', 'access', 'legal', 'financial', 'other'
  )),
  constraint land_diligence_items_status_check check (status in ('open', 'satisfied', 'issue', 'waived')),
  constraint land_diligence_items_resolved_check check ((status = 'open') = (resolved_at is null)),
  constraint land_diligence_items_waiver_check
    check (status <> 'waived' or length(btrim(coalesce(waived_reason, ''))) >= 10),
  constraint land_diligence_items_issue_check
    check (status <> 'issue' or length(btrim(coalesce(finding, ''))) > 0),
  constraint land_diligence_items_finding_check check (finding is null or length(finding) <= 4000),
  constraint land_diligence_items_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create index if not exists land_diligence_items_org_deal_idx
  on public.land_diligence_items (org_id, land_opportunity_id, sort_order);
create index if not exists land_diligence_items_deal_idx on public.land_diligence_items (land_opportunity_id);
create index if not exists land_diligence_items_due_idx
  on public.land_diligence_items (org_id, due_on) where status = 'open' and due_on is not null;
create index if not exists land_diligence_items_owner_idx
  on public.land_diligence_items (owner_user_id) where owner_user_id is not null;
create index if not exists land_diligence_items_company_idx
  on public.land_diligence_items (owner_company_id) where owner_company_id is not null;
create index if not exists land_diligence_items_resolved_by_idx
  on public.land_diligence_items (resolved_by) where resolved_by is not null;

-- ---------------------------------------------------------------------------
-- 3. Acquisition reviews: the versioned decision.
-- ---------------------------------------------------------------------------

create table if not exists public.land_acquisition_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  land_opportunity_id uuid not null references public.land_opportunities(id) on delete cascade,
  revision integer not null,
  decision text not null,
  summary text,
  snapshot jsonb not null,
  content_hash text not null,
  status text not null default 'in_review',
  submitted_by uuid not null references public.app_users(id),
  submitted_at timestamptz not null default now(),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint land_acquisition_reviews_revision_check check (revision > 0),
  constraint land_acquisition_reviews_decision_check check (decision in ('acquire', 'terminate')),
  constraint land_acquisition_reviews_status_check
    check (status in ('in_review', 'approved', 'rejected', 'superseded', 'withdrawn')),
  constraint land_acquisition_reviews_decided_check check ((status = 'in_review') = (decided_at is null)),
  constraint land_acquisition_reviews_hash_check check (content_hash ~ '^[a-f0-9]{64}$'),
  constraint land_acquisition_reviews_snapshot_check check (jsonb_typeof(snapshot) = 'object'),
  constraint land_acquisition_reviews_summary_check check (summary is null or length(summary) <= 4000),
  constraint land_acquisition_reviews_revision_key unique (land_opportunity_id, revision)
);

-- One open review per deal: two versions in flight would split the approvers.
create unique index if not exists land_acquisition_reviews_open_key
  on public.land_acquisition_reviews (land_opportunity_id) where status = 'in_review';
create index if not exists land_acquisition_reviews_org_deal_idx
  on public.land_acquisition_reviews (org_id, land_opportunity_id, revision desc);
create index if not exists land_acquisition_reviews_submitted_by_idx
  on public.land_acquisition_reviews (submitted_by);

comment on table public.land_acquisition_reviews is
  'One submitted version of a land acquisition decision: the deal, its diligence and evidence frozen into snapshot, content_hash = sha256(snapshot). Written only by submit/decide/withdraw_land_acquisition_review.';

-- ---------------------------------------------------------------------------
-- 4. Approvals, each bound to the version it decides.
-- ---------------------------------------------------------------------------

create table if not exists public.land_acquisition_approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  review_id uuid not null references public.land_acquisition_reviews(id) on delete cascade,
  step integer not null,
  label text not null,
  approver_id uuid not null references public.app_users(id) on delete restrict,
  decision text not null default 'pending',
  reviewed_hash text,
  reason text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint land_acquisition_approvals_step_check check (step between 1 and 5),
  constraint land_acquisition_approvals_label_check check (length(btrim(label)) > 0 and length(label) <= 80),
  constraint land_acquisition_approvals_decision_check check (decision in ('pending', 'approved', 'rejected')),
  constraint land_acquisition_approvals_decided_check
    check ((decision = 'pending') = (decided_at is null) and (decision = 'pending') = (reviewed_hash is null)),
  constraint land_acquisition_approvals_hash_check check (reviewed_hash is null or reviewed_hash ~ '^[a-f0-9]{64}$'),
  constraint land_acquisition_approvals_reject_reason_check
    check (decision <> 'rejected' or length(btrim(coalesce(reason, ''))) >= 10),
  constraint land_acquisition_approvals_reason_check check (reason is null or length(reason) <= 2000),
  constraint land_acquisition_approvals_step_key unique (review_id, step),
  constraint land_acquisition_approvals_approver_key unique (review_id, approver_id)
);

create index if not exists land_acquisition_approvals_org_review_idx
  on public.land_acquisition_approvals (org_id, review_id);
create index if not exists land_acquisition_approvals_pending_idx
  on public.land_acquisition_approvals (org_id, approver_id) where decision = 'pending';
create index if not exists land_acquisition_approvals_approver_idx
  on public.land_acquisition_approvals (approver_id);

-- ---------------------------------------------------------------------------
-- 5. Takedowns know the deal they came from; 6. files know the deal they
--    document.
-- ---------------------------------------------------------------------------

alter table public.lot_takedowns
  add column if not exists land_opportunity_id uuid references public.land_opportunities(id) on delete set null;
create index if not exists lot_takedowns_land_opportunity_idx
  on public.lot_takedowns (land_opportunity_id) where land_opportunity_id is not null;

-- No action, not set null: a deal is never deleted by a member, and a file that
-- outlived its deal must not fall out from under the wall onto the whole org.
alter table public.files
  add column if not exists land_opportunity_id uuid references public.land_opportunities(id);
create index if not exists files_land_opportunity_idx
  on public.files (org_id, land_opportunity_id) where land_opportunity_id is not null;

alter table public.file_links
  add column if not exists land_opportunity_id uuid references public.land_opportunities(id);
create index if not exists file_links_land_opportunity_idx
  on public.file_links (org_id, land_opportunity_id) where land_opportunity_id is not null;

-- ---------------------------------------------------------------------------
-- Guards.
-- ---------------------------------------------------------------------------

-- Every reference stays inside the organization.
create or replace function public.guard_land_references()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deal_org uuid;
  v_deal_community uuid;
begin
  if tg_table_name = 'land_opportunities' then
    if new.division_id is not null
       and not exists (select 1 from public.divisions d where d.id = new.division_id and d.org_id = new.org_id) then
      raise exception 'The division does not belong to this organization' using errcode = '23503';
    end if;
    if new.seller_company_id is not null
       and not exists (select 1 from public.companies c where c.id = new.seller_company_id and c.org_id = new.org_id) then
      raise exception 'The seller does not belong to this organization' using errcode = '23503';
    end if;
    if new.community_id is not null
       and not exists (select 1 from public.communities c where c.id = new.community_id and c.org_id = new.org_id) then
      raise exception 'The community does not belong to this organization' using errcode = '23503';
    end if;
    if new.lead_user_id is not null
       and not exists (select 1 from public.memberships m where m.user_id = new.lead_user_id and m.org_id = new.org_id) then
      raise exception 'The deal lead is not a member of this organization' using errcode = '23503';
    end if;
    return new;
  end if;

  if tg_table_name = 'land_diligence_items' then
    if not exists (
      select 1 from public.land_opportunities o where o.id = new.land_opportunity_id and o.org_id = new.org_id
    ) then
      raise exception 'The land deal does not belong to this organization' using errcode = '23503';
    end if;
    if new.owner_user_id is not null
       and not exists (select 1 from public.memberships m where m.user_id = new.owner_user_id and m.org_id = new.org_id) then
      raise exception 'The item owner is not a member of this organization' using errcode = '23503';
    end if;
    if new.owner_company_id is not null
       and not exists (select 1 from public.companies c where c.id = new.owner_company_id and c.org_id = new.org_id) then
      raise exception 'The consultant does not belong to this organization' using errcode = '23503';
    end if;
    return new;
  end if;

  if tg_table_name = 'lot_takedowns' then
    if new.land_opportunity_id is null then
      return new;
    end if;
    select o.org_id, o.community_id into v_deal_org, v_deal_community
    from public.land_opportunities o where o.id = new.land_opportunity_id;
    if v_deal_org is distinct from new.org_id then
      raise exception 'The land deal does not belong to this organization' using errcode = '23503';
    end if;
    if v_deal_community is distinct from new.community_id then
      raise exception 'The land deal is not linked to this takedown''s community' using errcode = '23514';
    end if;
    return new;
  end if;

  if tg_table_name = 'files' then
    if new.land_opportunity_id is not null and not exists (
      select 1 from public.land_opportunities o where o.id = new.land_opportunity_id and o.org_id = new.org_id
    ) then
      raise exception 'The land deal does not belong to this organization' using errcode = '23503';
    end if;
    return new;
  end if;

  -- file_links: a link that documents a deal carries the deal, and the file
  -- and the item it documents belong to that deal.
  if new.entity_type in ('land_opportunity', 'land_diligence_item') and new.land_opportunity_id is null then
    raise exception 'Land evidence must name its land deal' using errcode = '23514';
  end if;
  if new.land_opportunity_id is not null then
    if not exists (
      select 1 from public.land_opportunities o where o.id = new.land_opportunity_id and o.org_id = new.org_id
    ) then
      raise exception 'The land deal does not belong to this organization' using errcode = '23503';
    end if;
    if not exists (
      select 1 from public.files f
      where f.id = new.file_id and f.org_id = new.org_id and f.land_opportunity_id = new.land_opportunity_id
    ) then
      raise exception 'Land evidence must be a file filed on the same land deal' using errcode = '23514';
    end if;
    if new.entity_type = 'land_diligence_item' and not exists (
      select 1 from public.land_diligence_items i
      where i.id = new.entity_id and i.org_id = new.org_id and i.land_opportunity_id = new.land_opportunity_id
    ) then
      raise exception 'The diligence item does not belong to this land deal' using errcode = '23514';
    end if;
    if new.entity_type = 'land_opportunity' and new.entity_id is distinct from new.land_opportunity_id then
      raise exception 'The evidence does not belong to this land deal' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_land_references() from public, anon, authenticated;

drop trigger if exists land_opportunities_references on public.land_opportunities;
create trigger land_opportunities_references
  before insert or update of org_id, division_id, seller_company_id, community_id, lead_user_id
  on public.land_opportunities
  for each row execute function public.guard_land_references();

drop trigger if exists land_diligence_items_references on public.land_diligence_items;
create trigger land_diligence_items_references
  before insert or update of org_id, land_opportunity_id, owner_user_id, owner_company_id
  on public.land_diligence_items
  for each row execute function public.guard_land_references();

drop trigger if exists lot_takedowns_land_references on public.lot_takedowns;
create trigger lot_takedowns_land_references
  before insert or update of org_id, community_id, land_opportunity_id on public.lot_takedowns
  for each row execute function public.guard_land_references();

drop trigger if exists files_land_references on public.files;
create trigger files_land_references
  before insert or update of org_id, land_opportunity_id on public.files
  for each row
  when (new.land_opportunity_id is not null)
  execute function public.guard_land_references();

drop trigger if exists file_links_land_references on public.file_links;
create trigger file_links_land_references
  before insert or update of org_id, file_id, entity_type, entity_id, land_opportunity_id on public.file_links
  for each row
  when (new.land_opportunity_id is not null or new.entity_type in ('land_opportunity', 'land_diligence_item'))
  execute function public.guard_land_references();

-- A deal never changes organization, and an item never changes deal.
create or replace function public.guard_land_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.org_id is distinct from old.org_id then
    raise exception 'A land record cannot move to another organization' using errcode = '42501';
  end if;
  if tg_table_name = 'land_diligence_items' then
    if new.land_opportunity_id is distinct from old.land_opportunity_id then
      raise exception 'A diligence item cannot move to another land deal' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_land_identity() from public, anon, authenticated;

drop trigger if exists land_opportunities_identity on public.land_opportunities;
create trigger land_opportunities_identity
  before update on public.land_opportunities
  for each row execute function public.guard_land_identity();

drop trigger if exists land_diligence_items_identity on public.land_diligence_items;
create trigger land_diligence_items_identity
  before update on public.land_diligence_items
  for each row execute function public.guard_land_identity();

-- A review is a record of what was decided. Only its outcome moves, once.
create or replace function public.guard_land_acquisition_review()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.org_id is distinct from old.org_id
     or new.land_opportunity_id is distinct from old.land_opportunity_id
     or new.revision is distinct from old.revision
     or new.decision is distinct from old.decision
     or new.summary is distinct from old.summary
     or new.snapshot is distinct from old.snapshot
     or new.content_hash is distinct from old.content_hash
     or new.submitted_by is distinct from old.submitted_by
     or new.submitted_at is distinct from old.submitted_at
     or new.created_at is distinct from old.created_at then
    raise exception 'A submitted acquisition review cannot be changed' using errcode = '42501';
  end if;
  if old.status <> 'in_review' and (new.status is distinct from old.status or new.decided_at is distinct from old.decided_at) then
    raise exception 'This acquisition review has already been decided' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_land_acquisition_review() from public, anon, authenticated;

drop trigger if exists land_acquisition_reviews_guard on public.land_acquisition_reviews;
create trigger land_acquisition_reviews_guard
  before update on public.land_acquisition_reviews
  for each row execute function public.guard_land_acquisition_review();

-- An approver is named once, decides once, never approves their own review, and
-- decides exactly the version the review froze.
create or replace function public.guard_land_acquisition_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_review public.land_acquisition_reviews%rowtype;
begin
  select * into v_review from public.land_acquisition_reviews r where r.id = new.review_id;
  if not found or v_review.org_id is distinct from new.org_id then
    raise exception 'The acquisition review does not belong to this organization' using errcode = '23503';
  end if;
  if new.approver_id = v_review.submitted_by then
    raise exception 'The person who submitted an acquisition review cannot approve it' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.decision <> 'pending' then
      raise exception 'An approval starts undecided' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.org_id is distinct from old.org_id
     or new.review_id is distinct from old.review_id
     or new.step is distinct from old.step
     or new.label is distinct from old.label
     or new.approver_id is distinct from old.approver_id then
    raise exception 'An approver''s place on a review cannot be changed' using errcode = '42501';
  end if;
  if old.decision <> 'pending' then
    raise exception 'This approval has already been decided' using errcode = '42501';
  end if;
  if new.decision <> 'pending' then
    if v_review.status <> 'in_review' then
      raise exception 'This acquisition review is no longer open' using errcode = '42501';
    end if;
    if new.reviewed_hash is distinct from v_review.content_hash then
      raise exception 'The version you reviewed is not the version under review' using errcode = '40001';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_land_acquisition_approval() from public, anon, authenticated;

drop trigger if exists land_acquisition_approvals_guard on public.land_acquisition_approvals;
create trigger land_acquisition_approvals_guard
  before insert or update on public.land_acquisition_approvals
  for each row execute function public.guard_land_acquisition_approval();

-- A deal that moves while a version is in review supersedes that version. The
-- terms, an item or its evidence: anything the snapshot froze.
create or replace function public.tg_land_review_supersede()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deal uuid;
  v_org uuid;
begin
  if tg_table_name = 'land_opportunities' then
    v_deal := new.id;
    v_org := new.org_id;
  elsif tg_op = 'DELETE' then
    v_deal := old.land_opportunity_id;
    v_org := old.org_id;
  else
    v_deal := new.land_opportunity_id;
    v_org := new.org_id;
  end if;
  -- Reordering a checklist changes nothing an approver read.
  if tg_table_name = 'land_diligence_items' and tg_op = 'UPDATE' then
    if (old.title, old.category, old.owner_user_id, old.owner_company_id, old.due_on, old.status, old.finding, old.waived_reason)
       is not distinct from
       (new.title, new.category, new.owner_user_id, new.owner_company_id, new.due_on, new.status, new.finding, new.waived_reason) then
      return null;
    end if;
  end if;
  if v_deal is null then
    return null;
  end if;

  update public.land_acquisition_reviews r
     set status = 'superseded', decided_at = now()
   where r.org_id = v_org
     and r.land_opportunity_id = v_deal
     and r.status = 'in_review';
  return null;
end;
$$;

revoke all on function public.tg_land_review_supersede() from public, anon, authenticated;

drop trigger if exists land_opportunities_supersede_review on public.land_opportunities;
create trigger land_opportunities_supersede_review
  after update of name, division_id, seller_company_id, acreage, planned_lot_count, purchase_price_cents,
    deposit_cents, contract_executed_on, diligence_ends_on, closing_target_on, community_id
  on public.land_opportunities
  for each row
  when (
    (old.name, old.division_id, old.seller_company_id, old.acreage, old.planned_lot_count, old.purchase_price_cents,
     old.deposit_cents, old.contract_executed_on, old.diligence_ends_on, old.closing_target_on, old.community_id)
    is distinct from
    (new.name, new.division_id, new.seller_company_id, new.acreage, new.planned_lot_count, new.purchase_price_cents,
     new.deposit_cents, new.contract_executed_on, new.diligence_ends_on, new.closing_target_on, new.community_id)
  )
  execute function public.tg_land_review_supersede();

drop trigger if exists land_diligence_items_supersede_review on public.land_diligence_items;
create trigger land_diligence_items_supersede_review
  after insert or update or delete on public.land_diligence_items
  for each row execute function public.tg_land_review_supersede();

drop trigger if exists file_links_land_supersede_review on public.file_links;
create trigger file_links_land_supersede_review
  after insert on public.file_links
  for each row
  when (new.land_opportunity_id is not null)
  execute function public.tg_land_review_supersede();

drop trigger if exists file_links_land_supersede_review_unlink on public.file_links;
create trigger file_links_land_supersede_review_unlink
  after delete on public.file_links
  for each row
  when (old.land_opportunity_id is not null)
  execute function public.tg_land_review_supersede();

drop trigger if exists land_opportunities_set_updated_at on public.land_opportunities;
create trigger land_opportunities_set_updated_at
  before update on public.land_opportunities
  for each row execute function public.tg_set_updated_at();

drop trigger if exists land_diligence_items_set_updated_at on public.land_diligence_items;
create trigger land_diligence_items_set_updated_at
  before update on public.land_diligence_items
  for each row execute function public.tg_set_updated_at();

drop trigger if exists land_acquisition_reviews_set_updated_at on public.land_acquisition_reviews;
create trigger land_acquisition_reviews_set_updated_at
  before update on public.land_acquisition_reviews
  for each row execute function public.tg_set_updated_at();

drop trigger if exists land_acquisition_approvals_set_updated_at on public.land_acquisition_approvals;
create trigger land_acquisition_approvals_set_updated_at
  before update on public.land_acquisition_approvals
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- The division wall.
-- ---------------------------------------------------------------------------

create or replace function public.member_reachable_land_opportunity_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select o.id
  from public.land_opportunities o
  where o.division_id in (select public.member_reachable_division_ids());
$$;

comment on function public.member_reachable_land_opportunity_ids() is
  'Land deals in the divisions a division-restricted caller is assigned to. Policies use it as an uncorrelated IN so it is built once per statement.';

revoke all on function public.member_reachable_land_opportunity_ids() from public, anon;
grant execute on function public.member_reachable_land_opportunity_ids() to authenticated, service_role;

-- Whether a named person (not the caller) holds a permission and reaches a
-- division: the approvers a submitter names are checked by this, the caller by
-- has_org_permission and the policies.
create or replace function public.land_member_may(p_org_id uuid, p_user_id uuid, p_permission text, p_division_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.org_id = p_org_id
      and m.user_id = p_user_id
      and m.status = 'active'
      and (
        exists (select 1 from public.role_permissions rp where rp.role_id = m.role_id and rp.permission_key = p_permission)
        or exists (
          select 1 from public.membership_permission_overrides o
          where o.membership_id = m.id and o.permission_key = p_permission and o.effect = 'grant'
        )
      )
      and not exists (
        select 1 from public.membership_permission_overrides o
        where o.membership_id = m.id and o.permission_key = p_permission and o.effect = 'deny'
      )
      and (
        m.division_scope = 'all'
        or public.membership_is_org_admin(m.id, m.role_id)
        or (
          p_division_id is not null
          and exists (
            select 1 from public.membership_divisions md
            where md.membership_id = m.id and md.division_id = p_division_id
          )
        )
      )
  );
$$;

revoke all on function public.land_member_may(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.land_member_may(uuid, uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Row security.
-- ---------------------------------------------------------------------------

alter table public.land_opportunities enable row level security;

drop policy if exists land_opportunities_read on public.land_opportunities;
create policy land_opportunities_read on public.land_opportunities
  for select
  to authenticated
  using (public.has_org_permission(org_id, 'land.read'));

drop policy if exists land_opportunities_insert on public.land_opportunities;
create policy land_opportunities_insert on public.land_opportunities
  for insert
  to authenticated
  with check (
    public.has_org_permission(org_id, 'land.write')
    and created_by = (select auth.uid())
    and dropped_at is null
  );

drop policy if exists land_opportunities_update on public.land_opportunities;
create policy land_opportunities_update on public.land_opportunities
  for update
  to authenticated
  using (public.has_org_permission(org_id, 'land.write'))
  with check (public.has_org_permission(org_id, 'land.write'));

drop policy if exists land_opportunities_division_scope on public.land_opportunities;
create policy land_opportunities_division_scope on public.land_opportunities
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or division_id in (select public.member_reachable_division_ids())
  )
  with check (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or division_id in (select public.member_reachable_division_ids())
  );

-- Drop, never delete.
revoke all on table public.land_opportunities from anon, authenticated;
grant select, insert, update on table public.land_opportunities to authenticated;
grant all on table public.land_opportunities to service_role;

alter table public.land_diligence_items enable row level security;

drop policy if exists land_diligence_items_read on public.land_diligence_items;
create policy land_diligence_items_read on public.land_diligence_items
  for select
  to authenticated
  using (public.has_org_permission(org_id, 'land.read'));

drop policy if exists land_diligence_items_write on public.land_diligence_items;
create policy land_diligence_items_write on public.land_diligence_items
  for insert
  to authenticated
  with check (public.has_org_permission(org_id, 'land.write'));

drop policy if exists land_diligence_items_update on public.land_diligence_items;
create policy land_diligence_items_update on public.land_diligence_items
  for update
  to authenticated
  using (public.has_org_permission(org_id, 'land.write'))
  with check (public.has_org_permission(org_id, 'land.write'));

drop policy if exists land_diligence_items_delete on public.land_diligence_items;
create policy land_diligence_items_delete on public.land_diligence_items
  for delete
  to authenticated
  using (public.has_org_permission(org_id, 'land.write'));

drop policy if exists land_diligence_items_division_scope on public.land_diligence_items;
create policy land_diligence_items_division_scope on public.land_diligence_items
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or land_opportunity_id in (select public.member_reachable_land_opportunity_ids())
  )
  with check (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or land_opportunity_id in (select public.member_reachable_land_opportunity_ids())
  );

revoke all on table public.land_diligence_items from anon, authenticated;
grant select, insert, update, delete on table public.land_diligence_items to authenticated;
grant all on table public.land_diligence_items to service_role;

alter table public.land_acquisition_reviews enable row level security;

drop policy if exists land_acquisition_reviews_read on public.land_acquisition_reviews;
create policy land_acquisition_reviews_read on public.land_acquisition_reviews
  for select
  to authenticated
  using (public.has_org_permission(org_id, 'land.read'));

drop policy if exists land_acquisition_reviews_division_scope on public.land_acquisition_reviews;
create policy land_acquisition_reviews_division_scope on public.land_acquisition_reviews
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or land_opportunity_id in (select public.member_reachable_land_opportunity_ids())
  );

revoke all on table public.land_acquisition_reviews from anon, authenticated;
grant select on table public.land_acquisition_reviews to authenticated;
grant all on table public.land_acquisition_reviews to service_role;

alter table public.land_acquisition_approvals enable row level security;

drop policy if exists land_acquisition_approvals_read on public.land_acquisition_approvals;
create policy land_acquisition_approvals_read on public.land_acquisition_approvals
  for select
  to authenticated
  using (public.has_org_permission(org_id, 'land.read'));

drop policy if exists land_acquisition_approvals_division_scope on public.land_acquisition_approvals;
create policy land_acquisition_approvals_division_scope on public.land_acquisition_approvals
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or review_id in (
      select r.id from public.land_acquisition_reviews r
      where r.land_opportunity_id in (select public.member_reachable_land_opportunity_ids())
    )
  );

revoke all on table public.land_acquisition_approvals from anon, authenticated;
grant select on table public.land_acquisition_approvals to authenticated;
grant all on table public.land_acquisition_approvals to service_role;

-- Diligence documents: walled like the deal, and readable only with land.read.
drop policy if exists files_land_scope on public.files;
create policy files_land_scope on public.files
  as restrictive
  for all
  to authenticated
  using (
    land_opportunity_id is null
    or (
      public.has_org_permission(org_id, 'land.read')
      and (
        org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
        or land_opportunity_id in (select public.member_reachable_land_opportunity_ids())
      )
    )
  )
  with check (
    land_opportunity_id is null
    or (
      public.has_org_permission(org_id, 'land.write')
      and (
        org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
        or land_opportunity_id in (select public.member_reachable_land_opportunity_ids())
      )
    )
  );

drop policy if exists file_links_land_scope on public.file_links;
create policy file_links_land_scope on public.file_links
  as restrictive
  for all
  to authenticated
  using (
    land_opportunity_id is null
    or (
      public.has_org_permission(org_id, 'land.read')
      and (
        org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
        or land_opportunity_id in (select public.member_reachable_land_opportunity_ids())
      )
    )
  )
  with check (
    land_opportunity_id is null
    or (
      public.has_org_permission(org_id, 'land.write')
      and (
        org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
        or land_opportunity_id in (select public.member_reachable_land_opportunity_ids())
      )
    )
  );

-- ---------------------------------------------------------------------------
-- The decision. Called by the member through their own session: the caller's
-- permission and division come from auth.uid(), the named approvers' from
-- land_member_may. SQL assembles the snapshot; it judges nothing.
-- ---------------------------------------------------------------------------

create or replace function public.submit_land_acquisition_review(
  p_org_id uuid,
  p_opportunity_id uuid,
  p_decision text,
  p_summary text,
  p_approvers jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_deal public.land_opportunities%rowtype;
  v_count integer;
  v_approver record;
  v_snapshot jsonb;
  v_hash text;
  v_revision integer;
  v_review_id uuid;
begin
  if v_actor is null or not public.has_org_permission(p_org_id, 'land.write') then
    raise exception 'You do not have permission to submit land acquisitions' using errcode = '42501';
  end if;

  select * into v_deal
  from public.land_opportunities o
  where o.org_id = p_org_id and o.id = p_opportunity_id
  for update;
  if not found or not (
    p_org_id = any (public.member_division_unscoped_org_ids())
    or v_deal.division_id in (select public.member_reachable_division_ids())
  ) then
    raise exception 'Land deal not found' using errcode = 'P0002';
  end if;
  if v_deal.dropped_at is not null then
    raise exception 'A dropped land deal cannot be submitted for review' using errcode = '22023';
  end if;
  if p_decision is null or p_decision not in ('acquire', 'terminate') then
    raise exception 'Choose acquire or terminate' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.land_acquisition_reviews r
    where r.land_opportunity_id = p_opportunity_id and r.status = 'in_review'
  ) then
    raise exception 'This land deal already has a review open' using errcode = '23505';
  end if;

  if jsonb_typeof(p_approvers) is distinct from 'array' then
    raise exception 'Name between one and five approvers' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_approvers);
  if v_count < 1 or v_count > 5 then
    raise exception 'Name between one and five approvers' using errcode = '22023';
  end if;
  if (select count(distinct a.value ->> 'user_id') from jsonb_array_elements(p_approvers) a) <> v_count then
    raise exception 'Each approver can be named once' using errcode = '22023';
  end if;
  for v_approver in
    select (a.value ->> 'user_id')::uuid as user_id from jsonb_array_elements(p_approvers) a
  loop
    if v_approver.user_id = v_actor then
      raise exception 'You cannot approve a review you submit' using errcode = '42501';
    end if;
    if not public.land_member_may(p_org_id, v_approver.user_id, 'land.approve', v_deal.division_id) then
      raise exception 'Every approver must hold land approval in this deal''s division' using errcode = '42501';
    end if;
  end loop;

  v_snapshot := jsonb_build_object(
    'decision', p_decision,
    'terms', jsonb_build_object(
      'name', v_deal.name,
      'code', v_deal.code,
      'division_id', v_deal.division_id,
      'seller_company_id', v_deal.seller_company_id,
      'address', v_deal.address,
      'city', v_deal.city,
      'state', v_deal.state,
      'county', v_deal.county,
      'acreage', v_deal.acreage,
      'planned_lot_count', v_deal.planned_lot_count,
      'purchase_price_cents', v_deal.purchase_price_cents,
      'deposit_cents', v_deal.deposit_cents,
      'contract_executed_on', v_deal.contract_executed_on,
      'diligence_ends_on', v_deal.diligence_ends_on,
      'closing_target_on', v_deal.closing_target_on,
      'community_id', v_deal.community_id
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id,
        'title', i.title,
        'category', i.category,
        'owner_user_id', i.owner_user_id,
        'owner_company_id', i.owner_company_id,
        'due_on', i.due_on,
        'status', i.status,
        'finding', i.finding,
        'waived_reason', i.waived_reason
      ) order by i.sort_order, i.id)
      from public.land_diligence_items i
      where i.org_id = p_org_id and i.land_opportunity_id = p_opportunity_id
    ), '[]'::jsonb),
    'evidence', coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_id', fl.entity_id,
        'file_id', f.id,
        'file_name', f.file_name,
        'checksum', f.checksum,
        'version_id', f.current_version_id
      ) order by fl.entity_id, f.id)
      from public.file_links fl
      join public.files f on f.org_id = fl.org_id and f.id = fl.file_id
      where fl.org_id = p_org_id
        and fl.land_opportunity_id = p_opportunity_id
        and fl.entity_type = 'land_diligence_item'
        and f.archived_at is null
    ), '[]'::jsonb),
    'takedowns', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t.id,
        'name', t.name,
        'scheduled_date', t.scheduled_date,
        'lot_count', t.lot_count,
        'price_per_lot_cents', t.price_per_lot_cents,
        'status', t.status
      ) order by t.id)
      from public.lot_takedowns t
      where t.org_id = p_org_id and t.land_opportunity_id = p_opportunity_id
    ), '[]'::jsonb)
  );
  v_hash := encode(extensions.digest(v_snapshot::text, 'sha256'), 'hex');

  select coalesce(max(r.revision), 0) + 1 into v_revision
  from public.land_acquisition_reviews r
  where r.land_opportunity_id = p_opportunity_id;

  insert into public.land_acquisition_reviews (
    org_id, land_opportunity_id, revision, decision, summary, snapshot, content_hash, submitted_by
  ) values (
    p_org_id, p_opportunity_id, v_revision, p_decision, nullif(btrim(coalesce(p_summary, '')), ''), v_snapshot, v_hash, v_actor
  )
  returning id into v_review_id;

  insert into public.land_acquisition_approvals (org_id, review_id, step, label, approver_id)
  select p_org_id, v_review_id, a.ordinality::integer,
         coalesce(nullif(btrim(coalesce(a.value ->> 'label', '')), ''), 'Approver'),
         (a.value ->> 'user_id')::uuid
  from jsonb_array_elements(p_approvers) with ordinality a;

  return v_review_id;
end;
$$;

create or replace function public.decide_land_acquisition_approval(
  p_org_id uuid,
  p_approval_id uuid,
  p_decision text,
  p_reason text,
  p_content_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_approval public.land_acquisition_approvals%rowtype;
  v_review public.land_acquisition_reviews%rowtype;
  v_deal public.land_opportunities%rowtype;
  v_status text;
begin
  if v_actor is null or not public.has_org_permission(p_org_id, 'land.approve') then
    raise exception 'You do not have permission to approve land acquisitions' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception 'Choose approve or reject' using errcode = '22023';
  end if;

  select * into v_approval
  from public.land_acquisition_approvals a
  where a.org_id = p_org_id and a.id = p_approval_id
  for update;
  if not found then
    raise exception 'Approval not found' using errcode = 'P0002';
  end if;
  select * into v_review from public.land_acquisition_reviews r where r.id = v_approval.review_id for update;
  select * into v_deal from public.land_opportunities o where o.id = v_review.land_opportunity_id for update;
  if not (
    p_org_id = any (public.member_division_unscoped_org_ids())
    or v_deal.division_id in (select public.member_reachable_division_ids())
  ) then
    raise exception 'Approval not found' using errcode = 'P0002';
  end if;
  if v_approval.approver_id <> v_actor then
    raise exception 'Only the named approver can decide this approval' using errcode = '42501';
  end if;
  if v_review.status <> 'in_review' then
    raise exception 'This acquisition review is no longer open' using errcode = '22023';
  end if;
  if p_content_hash is distinct from v_review.content_hash then
    raise exception 'The version you reviewed has changed. Reopen the review and decide the current version.'
      using errcode = '40001';
  end if;

  update public.land_acquisition_approvals a
     set decision = p_decision,
         reviewed_hash = p_content_hash,
         reason = nullif(btrim(coalesce(p_reason, '')), ''),
         decided_at = now()
   where a.id = p_approval_id;

  v_status := 'in_review';
  if p_decision = 'rejected' then
    v_status := 'rejected';
  elsif not exists (
    select 1 from public.land_acquisition_approvals a
    where a.review_id = v_review.id and a.decision <> 'approved'
  ) then
    v_status := 'approved';
  end if;

  if v_status <> 'in_review' then
    update public.land_acquisition_reviews r
       set status = v_status, decided_at = now()
     where r.id = v_review.id;
  end if;
  if v_status = 'approved' and v_review.decision = 'terminate' and v_deal.dropped_at is null then
    update public.land_opportunities o
       set dropped_at = now(), dropped_reason = format('Terminated by acquisition review r%s', v_review.revision)
     where o.id = v_deal.id;
  end if;

  return jsonb_build_object(
    'review_id', v_review.id,
    'review_status', v_status,
    'revision', v_review.revision,
    'decision', v_review.decision,
    'land_opportunity_id', v_deal.id,
    'submitted_by', v_review.submitted_by
  );
end;
$$;

create or replace function public.withdraw_land_acquisition_review(p_org_id uuid, p_review_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_review public.land_acquisition_reviews%rowtype;
  v_division uuid;
begin
  if (select auth.uid()) is null or not public.has_org_permission(p_org_id, 'land.write') then
    raise exception 'You do not have permission to withdraw land acquisitions' using errcode = '42501';
  end if;
  select * into v_review
  from public.land_acquisition_reviews r
  where r.org_id = p_org_id and r.id = p_review_id
  for update;
  select o.division_id into v_division from public.land_opportunities o where o.id = v_review.land_opportunity_id;
  if v_review.id is null or not (
    p_org_id = any (public.member_division_unscoped_org_ids())
    or v_division in (select public.member_reachable_division_ids())
  ) then
    raise exception 'Acquisition review not found' using errcode = 'P0002';
  end if;
  if v_review.status <> 'in_review' then
    raise exception 'This acquisition review is no longer open' using errcode = '22023';
  end if;
  update public.land_acquisition_reviews r
     set status = 'withdrawn', decided_at = now()
   where r.id = p_review_id;
  return v_review.land_opportunity_id;
end;
$$;

revoke all on function public.submit_land_acquisition_review(uuid, uuid, text, text, jsonb) from public, anon;
revoke all on function public.decide_land_acquisition_approval(uuid, uuid, text, text, text) from public, anon;
revoke all on function public.withdraw_land_acquisition_review(uuid, uuid) from public, anon;
grant execute on function public.submit_land_acquisition_review(uuid, uuid, text, text, jsonb) to authenticated, service_role;
grant execute on function public.decide_land_acquisition_approval(uuid, uuid, text, text, text) to authenticated, service_role;
grant execute on function public.withdraw_land_acquisition_review(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. RBAC.
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('land.read', 'View land deals, diligence, and acquisition reviews'),
  ('land.write', 'Create and manage land deals and diligence, and submit acquisitions for review'),
  ('land.approve', 'Approve or reject land acquisition reviews')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join unnest(array['land.read', 'land.write']) as p(key)
where r.key in ('org_owner', 'org_admin', 'org_land_manager')
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'land.approve'
from public.roles r
where r.key in ('org_owner', 'org_admin')
on conflict (role_id, permission_key) do nothing;
