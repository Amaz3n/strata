-- Division scope for the search index, and a division history that tells the truth.
--
-- 20261011140000 put the restrictive division backstop on search_documents, but
-- keyed it on project_id. Community and lot documents carry no project, so they
-- passed it: a division-limited member found every division's communities and
-- unsold lots through global search. Their history table also had three gaps:
-- a new home's history began at the client-supplied created_at, the division a
-- home left could no longer read the rows it owned, and a direct write to a
-- home's division could leave it disagreeing with the lot it stands on.
--
-- This migration:
--   1. gives search_documents a division_id, stamped by the database from the
--      community or lot a document indexes (every writer -- the outbox indexer
--      and search.ts's read-through backfill -- gets it without remembering),
--      kept current when a community or lot changes division, and enforced by
--      the search_documents backstop exactly as communities and lots are;
--   2. starts a home's history at now(), lets a division read the history rows
--      it held, and refuses a home division that disagrees with its lot;
--   3. lets a lot moved to another community carry its home with it;
--   4. attributes the closing backlog report's closed-this-year numbers to the
--      division each home was in when it closed.

set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. Community and lot search documents carry their division.
-- ---------------------------------------------------------------------------

alter table public.search_documents
  add column if not exists division_id uuid references public.divisions(id) on delete set null;

comment on column public.search_documents.division_id is
  'Division of a community or lot document, stamped from its row by tg_search_documents_stamp_division and kept current by the community and lot triggers. Null for every other document: project documents are scoped by project_id.';

create index if not exists search_documents_division_idx
  on public.search_documents (division_id) where division_id is not null;

-- Definer so the document gets the row's real division even when the writer
-- cannot see that row: the backstop below then refuses the write instead of
-- filing the document somewhere else.
create or replace function public.tg_search_documents_stamp_division()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.division_id := case new.entity_type
    when 'community' then (
      select c.division_id from public.communities c where c.org_id = new.org_id and c.id = new.entity_id
    )
    when 'lot' then (
      select l.division_id from public.lots l where l.org_id = new.org_id and l.id = new.entity_id
    )
  end;
  return new;
end;
$$;

revoke all on function public.tg_search_documents_stamp_division() from public, anon, authenticated;

drop trigger if exists search_documents_stamp_division on public.search_documents;
create trigger search_documents_stamp_division
  before insert or update of org_id, entity_type, entity_id, division_id on public.search_documents
  for each row execute function public.tg_search_documents_stamp_division();

-- A community or lot that changes division takes its document along in the
-- same statement; the stamp trigger above re-reads the row. A community move
-- updates its lots, so the lot documents follow through the lot trigger.
create or replace function public.tg_search_documents_follow_division()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.search_documents d
     set division_id = new.division_id
   where d.org_id = new.org_id
     and d.entity_type = tg_argv[0]
     and d.entity_id = new.id;
  return null;
end;
$$;

revoke all on function public.tg_search_documents_follow_division() from public, anon, authenticated;

drop trigger if exists communities_search_follow_division on public.communities;
create trigger communities_search_follow_division
  after update on public.communities
  for each row
  when (old.division_id is distinct from new.division_id)
  execute function public.tg_search_documents_follow_division('community');

-- No column list: a lot's division also changes when its community_id does,
-- and that update never names division_id.
drop trigger if exists lots_search_follow_division on public.lots;
create trigger lots_search_follow_division
  after update on public.lots
  for each row
  when (old.division_id is distinct from new.division_id)
  execute function public.tg_search_documents_follow_division('lot');

update public.search_documents d
   set division_id = c.division_id
  from public.communities c
 where d.entity_type = 'community'
   and c.org_id = d.org_id
   and c.id = d.entity_id
   and d.division_id is distinct from c.division_id;

update public.search_documents d
   set division_id = l.division_id
  from public.lots l
 where d.entity_type = 'lot'
   and l.org_id = d.org_id
   and l.id = d.entity_id
   and d.division_id is distinct from l.division_id;

-- Project documents keep the project check. Community and lot documents take
-- the communities/lots check: a document with no division is out of a
-- division-restricted member's scope, as the row it indexes is.
drop policy if exists search_documents_division_scope on public.search_documents;
create policy search_documents_division_scope on public.search_documents
  as restrictive
  for all
  to authenticated
  using (
    (
      project_id is null
      or org_id = any ((select public.member_unscoped_org_ids())::uuid[])
      or project_id in (select public.member_reachable_project_ids())
    )
    and (
      entity_type not in ('community', 'lot')
      or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
      or division_id in (select public.member_reachable_division_ids())
    )
  )
  with check (
    (
      project_id is null
      or org_id = any ((select public.member_unscoped_org_ids())::uuid[])
      or project_id in (select public.member_reachable_project_ids())
    )
    and (
      entity_type not in ('community', 'lot')
      or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
      or division_id in (select public.member_reachable_division_ids())
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Division history.
-- ---------------------------------------------------------------------------

-- A history row starts when the database records it. created_at is whatever
-- the writer sent, and an import's backdated created_at would claim a division
-- for a time before Arc knew the home. (The one-time backfill in
-- 20261011140000 keeps created_at: for rows that already existed it is the
-- best evidence there is.) The closed row never ends before it began.
create or replace function public.tg_projects_division_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_at timestamptz := now();
begin
  if tg_op = 'UPDATE' then
    update public.project_division_history
       set valid_to = greatest(v_at, valid_from)
     where project_id = new.id and valid_to is null;
  end if;
  insert into public.project_division_history (org_id, project_id, division_id, valid_from, changed_by)
  values (
    new.org_id,
    new.id,
    new.division_id,
    v_at,
    case when exists (select 1 from public.app_users u where u.id = v_actor) then v_actor end
  );
  return null;
end;
$$;

-- The division a home left still owns the rows from its time: its period
-- reports read them through project_division_at().
drop policy if exists project_division_history_read on public.project_division_history;
create policy project_division_history_read on public.project_division_history
  for select
  to authenticated
  using (
    public.is_org_member(org_id)
    and (
      org_id = any ((select public.member_unscoped_org_ids())::uuid[])
      or project_id in (select public.member_reachable_project_ids())
      or division_id in (select public.member_reachable_division_ids())
    )
  );

-- A home on a lot stands in the lot's division. The community cascade and the
-- lot trigger move the lot first and the home to match, so they pass; a direct
-- write that would split the two is refused. A lot with no division (its
-- community was taken out of every division) leaves the home's division free,
-- as that cascade does.
create or replace function public.tg_projects_division_matches_lot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lot_division_id uuid;
begin
  select l.division_id into v_lot_division_id
  from public.lots l
  where l.org_id = new.org_id and l.project_id = new.id;
  if v_lot_division_id is not null and v_lot_division_id is distinct from new.division_id then
    raise exception 'A home on a lot stands in its community''s division; move the community or detach the home first'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_projects_division_matches_lot() from public, anon, authenticated;

drop trigger if exists projects_division_matches_lot on public.projects;
create trigger projects_division_matches_lot
  before update of division_id on public.projects
  for each row
  when (old.division_id is distinct from new.division_id)
  execute function public.tg_projects_division_matches_lot();

-- ---------------------------------------------------------------------------
-- 3. A lot moved to another community carries its home.
-- ---------------------------------------------------------------------------

drop trigger if exists lots_file_project_under_lot_division on public.lots;
create trigger lots_file_project_under_lot_division
  after insert or update of project_id, community_id on public.lots
  for each row
  when (new.project_id is not null and new.division_id is not null)
  execute function public.tg_lots_file_project_under_lot_division();

-- ---------------------------------------------------------------------------
-- 4. Closed homes count for the division they closed in.
-- ---------------------------------------------------------------------------

-- The division a home was filed under as its closing day ended. A home whose
-- history begins after it closed (imported already closed) is attributed to
-- the first division Arc recorded for it.
create or replace function public.project_division_on(p_project_id uuid, p_on date)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    public.project_division_at(p_project_id, (p_on + 1)::timestamptz - interval '1 microsecond'),
    (
      select h.division_id
      from public.project_division_history h
      where h.project_id = p_project_id
      order by h.valid_from
      limit 1
    )
  );
$$;

comment on function public.project_division_on(uuid, date) is
  'The division a project (home) was filed under at the end of a day, or the first division recorded for it when its history starts later. Period reports attribute closings with it.';

revoke all on function public.project_division_on(uuid, date) from public, anon;
grant execute on function public.project_division_on(uuid, date) to authenticated, service_role;

-- Filtered by division, the live numbers (leads, specs, holds, backlog, the
-- 30-day horizon, cancellations, incentives) are the communities in that
-- division now, and the closed-this-year numbers are the homes that closed
-- while in it -- including homes in communities that have since moved away,
-- which appear with only their closed numbers. Unfiltered, nothing changes.
create or replace function public.get_sales_backlog_report(p_org_id uuid, p_division_id uuid default null::uuid)
returns table(
  community_id uuid, community_name text, division_id uuid, lead_units bigint, spec_units bigint,
  hold_units bigint, reserved_units bigint, backlog_units bigint, backlog_value_cents bigint,
  scheduled_30d_units bigint, closed_units_ytd bigint, closed_value_ytd_cents bigint,
  avg_days_agreement_to_close numeric, cancellation_count bigint, cancellation_rate numeric,
  incentive_spend_cents bigint, incentive_percent_of_price numeric
)
language sql
stable
set search_path to 'public', 'pg_catalog'
as $function$
  with live_closings as (
    -- One closing per project: cancelled closings are kept for history and must
    -- not multiply the agreement rows they join to.
    select distinct on (cl.project_id) cl.project_id, cl.status, cl.actual_date, cl.scheduled_date, cl.settlement
    from public.closings cl
    where cl.org_id = p_org_id and cl.status <> 'cancelled'
    order by cl.project_id, cl.created_at desc
  ), leads as (
    select p.community_id, count(*) lead_units
    from public.prospects p
    where p.org_id = p_org_id
      and p.community_id is not null
      and p.status in ('new','contacted','qualified','pricing','estimate_sent','changes_requested','client_approved','executed')
    group by p.community_id
  ), agreements as (
    select l.community_id, ct.project_id, ct.id, ct.total_cents, ct.status, ct.signed_at,
      coalesce(
        (ct.snapshot #>> '{purchase_agreement,pricing,incentivesCents}')::bigint,
        (ct.snapshot #>> '{purchase_agreement,pricing,incentives_cents}')::bigint,
        0
      ) incentives_cents,
      cl.status closing_status, cl.actual_date, cl.scheduled_date,
      coalesce((coalesce(cl.settlement->>'finalPriceCents', cl.settlement->>'final_price_cents'))::bigint, ct.total_cents::bigint, 0) final_price_cents
    from public.contracts ct
    join public.lots l on l.org_id = ct.org_id and l.project_id = ct.project_id
    left join live_closings cl on cl.project_id = ct.project_id
    where ct.org_id = p_org_id and ct.contract_type = 'purchase_agreement'
  ), closed_ytd as (
    select a.community_id, a.final_price_cents
    from agreements a
    where a.closing_status = 'closed'
      and a.actual_date >= date_trunc('year', current_date)::date
      and (p_division_id is null or public.project_division_on(a.project_id, a.actual_date) = p_division_id)
  ), closed_rollup as (
    select c.community_id, count(*) closed_units_ytd, coalesce(sum(c.final_price_cents), 0)::bigint closed_value_ytd_cents
    from closed_ytd c group by c.community_id
  ), community_scope as (
    select c.id, c.name, c.division_id, (p_division_id is null or c.division_id = p_division_id) in_division
    from public.communities c
    where c.org_id = p_org_id
      and c.archived_at is null
      and (
        p_division_id is null
        or c.division_id = p_division_id
        or c.id in (select cr.community_id from closed_rollup cr)
      )
  ), reservation_rollup as (
    select r.community_id,
      count(*) filter (where r.status = 'hold') hold_units,
      count(*) filter (where r.status = 'reserved') reserved_units,
      count(*) filter (where r.status in ('released','expired')) cancellation_count,
      count(*) total_reservations
    from public.lot_reservations r where r.org_id = p_org_id group by r.community_id
  ), agreement_rollup as (
    select a.community_id,
      count(*) filter (where a.status = 'active' and coalesce(a.closing_status, '') <> 'closed') backlog_units,
      coalesce(sum(a.total_cents) filter (where a.status = 'active' and coalesce(a.closing_status, '') <> 'closed'), 0)::bigint backlog_value_cents,
      count(*) filter (where a.closing_status in ('scheduled','cleared_to_close') and a.scheduled_date between current_date and current_date + 30) scheduled_30d_units,
      round(avg(a.actual_date - a.signed_at::date) filter (where a.closing_status = 'closed' and a.signed_at is not null), 1) avg_days,
      coalesce(sum(a.incentives_cents) filter (where a.status = 'active' or a.closing_status = 'closed'), 0)::bigint incentive_spend,
      coalesce(sum(a.total_cents) filter (where a.status = 'active' or a.closing_status = 'closed'), 0)::bigint agreement_value
    from agreements a group by a.community_id
  ), specs as (
    select l.community_id, count(*) spec_units
    from public.lots l
    where l.org_id = p_org_id and l.project_id is not null
      and l.status <> 'closed'
      and not exists (
        select 1 from public.lot_reservations r
        where r.org_id = l.org_id and r.lot_id = l.id and r.status in ('hold','reserved','converted')
      )
      and not exists (
        select 1 from public.contracts ct
        where ct.org_id = l.org_id and ct.project_id = l.project_id
          and ct.contract_type = 'purchase_agreement' and ct.status = 'active'
      )
      and not exists (
        select 1 from public.closings cl
        where cl.org_id = l.org_id and cl.project_id = l.project_id and cl.status = 'closed'
      )
    group by l.community_id
  )
  select cs.id, cs.name, cs.division_id,
    coalesce(ld.lead_units, 0),
    coalesce(s.spec_units, 0), coalesce(rr.hold_units, 0), coalesce(rr.reserved_units, 0),
    coalesce(ar.backlog_units, 0), coalesce(ar.backlog_value_cents, 0),
    coalesce(ar.scheduled_30d_units, 0), coalesce(cr.closed_units_ytd, 0),
    coalesce(cr.closed_value_ytd_cents, 0), ar.avg_days,
    coalesce(rr.cancellation_count, 0),
    case when coalesce(rr.total_reservations, 0) = 0 then 0
      else round(rr.cancellation_count::numeric * 100 / rr.total_reservations, 2) end,
    coalesce(ar.incentive_spend, 0),
    case when coalesce(ar.agreement_value, 0) = 0 then 0
      else round(ar.incentive_spend::numeric * 100 / ar.agreement_value, 2) end
  from community_scope cs
  left join leads ld on ld.community_id = cs.id and cs.in_division
  left join specs s on s.community_id = cs.id and cs.in_division
  left join reservation_rollup rr on rr.community_id = cs.id and cs.in_division
  left join agreement_rollup ar on ar.community_id = cs.id and cs.in_division
  left join closed_rollup cr on cr.community_id = cs.id
  order by cs.name;
$function$;
