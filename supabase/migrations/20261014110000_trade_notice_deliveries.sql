-- EP07-05, 06, 07: trade notices that cannot send twice, say something other
-- than what was reviewed, or fail where nobody sees.
--
-- 1. trade_notice_deliveries: one row per notice a trade is owed (a release
--    notice, a look-ahead, a schedule-change digest). The row is reserved
--    BEFORE the email goes out and carries what it will say (items, dates,
--    recipients, subject, link) and a hash of that content, so a retry weeks
--    later sends the same notice, not a rebuilt one. Each row holds one
--    provider idempotency key: a crash between "the provider accepted it" and
--    "we wrote that down" retries with the same key and the provider returns
--    the first message instead of sending a second. A notice whose outcome
--    cannot be known (reserved, then silent for more than the provider's 24h
--    key window) becomes `ambiguous` and waits for a coordinator.
--    Written only by the service-role RPCs below; members read it behind
--    start.read and their division wall.
-- 2. reserve_trade_notice / settle_trade_notice / resolve_trade_notice: the
--    state machine. Settling `accepted` writes the event and the audit row in
--    the same transaction, so a notice is never sent without a record and
--    never recorded twice.
-- 3. enqueue_trade_schedule_change: schedule-change digests coalesce in one
--    statement. The old read-modify-write lost the second of two concurrent
--    moves, updated a job a worker had already claimed, and reported the
--    wrong "from" date when an item moved twice. The first old_start is kept,
--    the latest new_start wins, and a move back to where it started drops out.
-- 4. read_trade_lookahead_workspace: work that is cancelled or completed is
--    not in the look-ahead, work that started before the window and is still
--    running is, and a vendor inferred from a purchase order must hold an
--    approved or complete one (a draft or canceled order awards nothing) and
--    is marked `inferred` instead of passing as an assignment.
-- 5. retry_start_trade_notice also requeues a failed schedule-change digest of
--    the house and a failed package notice; list_trade_notice_attention
--    returns every failed or ambiguous notice in the caller's scope for the
--    Trades desk.
--
-- RBAC: no new key. Sending uses start.write, recovery start.release, as before.
-- Roles holding them: owner and admin (all), org_starts_coordinator (both).

-- ---------------------------------------------------------------------------
-- 1. Deliveries.
-- ---------------------------------------------------------------------------

create table if not exists public.trade_notice_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  kind text not null,
  company_id uuid not null references public.companies(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  outbox_id bigint,
  dedupe_key text not null,
  scope jsonb not null default '{}'::jsonb,
  snapshot jsonb not null,
  recipients text[] not null,
  subject text not null,
  content_hash text not null,
  idempotency_key uuid not null default gen_random_uuid(),
  status text not null default 'reserved',
  attempts integer not null default 0,
  provider_message_id text,
  last_error text,
  actor_id uuid,
  reserved_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  accepted_at timestamptz,
  resolved_by uuid,
  resolved_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trade_notice_deliveries_kind_check check (kind in ('lookahead', 'release', 'schedule_change')),
  constraint trade_notice_deliveries_status_check check (status in ('reserved', 'accepted', 'failed', 'ambiguous')),
  constraint trade_notice_deliveries_attempts_check check (attempts >= 0),
  constraint trade_notice_deliveries_dedupe_unique unique (org_id, dedupe_key)
);

create index if not exists trade_notice_deliveries_company_idx
  on public.trade_notice_deliveries (org_id, company_id, created_at desc);
create index if not exists trade_notice_deliveries_project_idx
  on public.trade_notice_deliveries (org_id, project_id) where project_id is not null;
create index if not exists trade_notice_deliveries_attention_idx
  on public.trade_notice_deliveries (org_id, updated_at desc) where status in ('failed', 'ambiguous');
create index if not exists trade_notice_deliveries_outbox_idx
  on public.trade_notice_deliveries (outbox_id) where outbox_id is not null;

drop trigger if exists trade_notice_deliveries_set_updated_at on public.trade_notice_deliveries;
create trigger trade_notice_deliveries_set_updated_at
  before update on public.trade_notice_deliveries
  for each row execute function public.tg_set_updated_at();

-- What a notice says and who it goes to is fixed when it is reserved. Only its
-- outcome moves, and the provider key is replaced only when an unknown or
-- failed send is deliberately started over.
create or replace function public.tg_trade_notice_delivery_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if row(new.org_id, new.kind, new.company_id, new.project_id, new.outbox_id, new.dedupe_key, new.scope,
         new.snapshot, new.recipients, new.subject, new.content_hash, new.reserved_at, new.created_at)
     is distinct from
     row(old.org_id, old.kind, old.company_id, old.project_id, old.outbox_id, old.dedupe_key, old.scope,
         old.snapshot, old.recipients, old.subject, old.content_hash, old.reserved_at, old.created_at) then
    raise exception 'A trade notice''s content and recipients cannot change after it is reserved' using errcode = '42501';
  end if;
  if new.idempotency_key is distinct from old.idempotency_key
     and not (new.status = 'reserved' and old.status in ('ambiguous', 'failed')) then
    raise exception 'A trade notice''s provider key changes only when its send is started over' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trade_notice_deliveries_immutable on public.trade_notice_deliveries;
create trigger trade_notice_deliveries_immutable
  before update on public.trade_notice_deliveries
  for each row execute function public.tg_trade_notice_delivery_immutable();

alter table public.trade_notice_deliveries enable row level security;

drop policy if exists trade_notice_deliveries_read on public.trade_notice_deliveries;
create policy trade_notice_deliveries_read on public.trade_notice_deliveries
  for select
  to authenticated
  using (public.has_org_permission(org_id, 'start.read'));

drop policy if exists trade_notice_deliveries_division_scope on public.trade_notice_deliveries;
create policy trade_notice_deliveries_division_scope on public.trade_notice_deliveries
  as restrictive
  for select
  to authenticated
  using (
    project_id is null
    or org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or project_id in (select public.member_reachable_project_ids())
  );

revoke insert, update, delete on public.trade_notice_deliveries from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The state machine.
-- ---------------------------------------------------------------------------

-- Reserve the notice, or return the one already reserved for this key, and say
-- whether this call should send. `reserved` and `failed` rows within the
-- provider's 24 hour key window send again with the SAME key. A reserved row
-- silent for longer has an unknowable outcome (the provider may have sent it)
-- and becomes ambiguous; a failed row that old starts over with a new key.
create or replace function public.reserve_trade_notice(
  p_org_id uuid, p_kind text, p_company_id uuid, p_project_id uuid, p_outbox_id bigint,
  p_dedupe_key text, p_scope jsonb, p_snapshot jsonb, p_recipients text[], p_subject text,
  p_content_hash text, p_actor_id uuid
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v public.trade_notice_deliveries%rowtype;
  v_send boolean := false;
begin
  if coalesce(cardinality(p_recipients), 0) = 0 then
    raise exception 'A trade notice needs at least one recipient';
  end if;
  insert into public.trade_notice_deliveries(org_id, kind, company_id, project_id, outbox_id, dedupe_key, scope,
    snapshot, recipients, subject, content_hash, actor_id)
  values (p_org_id, p_kind, p_company_id, p_project_id, p_outbox_id, p_dedupe_key, coalesce(p_scope, '{}'::jsonb),
    p_snapshot, p_recipients, p_subject, p_content_hash, p_actor_id)
  on conflict (org_id, dedupe_key) do nothing;
  select * into v from public.trade_notice_deliveries where org_id = p_org_id and dedupe_key = p_dedupe_key for update;
  if v.status = 'reserved' and v.last_attempt_at is not null and v.last_attempt_at < clock_timestamp() - interval '24 hours' then
    update public.trade_notice_deliveries set status = 'ambiguous',
      last_error = 'The provider may have sent this notice; its outcome is unknown' where id = v.id returning * into v;
  elsif v.status = 'failed' and v.last_attempt_at is not null and v.last_attempt_at < clock_timestamp() - interval '24 hours' then
    update public.trade_notice_deliveries set status = 'reserved', idempotency_key = gen_random_uuid(),
      attempts = attempts + 1, last_attempt_at = clock_timestamp() where id = v.id returning * into v;
    v_send := true;
  elsif v.status in ('reserved', 'failed') then
    update public.trade_notice_deliveries set status = 'reserved', attempts = attempts + 1,
      last_attempt_at = clock_timestamp() where id = v.id returning * into v;
    v_send := true;
  end if;
  return jsonb_build_object('send', v_send, 'delivery', to_jsonb(v));
end $$;

-- Record the outcome of an attempt. Accepting is idempotent and carries the
-- event and the audit row, so the record exists exactly when the notice was sent.
create or replace function public.settle_trade_notice(
  p_org_id uuid, p_id uuid, p_outcome text, p_message_id text, p_error text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v public.trade_notice_deliveries%rowtype;
begin
  if p_outcome not in ('accepted', 'failed') then raise exception 'Unknown trade notice outcome'; end if;
  select * into v from public.trade_notice_deliveries where org_id = p_org_id and id = p_id for update;
  if not found then raise exception 'Trade notice delivery not found' using errcode = '42501'; end if;
  if v.status = 'accepted' then return to_jsonb(v); end if;
  if v.status <> 'reserved' then
    raise exception 'Only a reserved trade notice can be settled' using errcode = '40001';
  end if;
  if p_outcome = 'failed' then
    update public.trade_notice_deliveries set status = 'failed', last_error = left(coalesce(p_error, 'The email was not accepted'), 2000)
      where id = v.id returning * into v;
    return to_jsonb(v);
  end if;
  update public.trade_notice_deliveries set status = 'accepted', provider_message_id = p_message_id,
    accepted_at = clock_timestamp(), last_error = null where id = v.id returning * into v;
  insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
    values (p_org_id, 'trade_notice.sent', 'company', v.company_id,
      jsonb_build_object('delivery_id', v.id, 'kind', v.kind, 'company_id', v.company_id, 'project_id', v.project_id,
        'recipients', cardinality(v.recipients), 'item_count', jsonb_array_length(coalesce(v.snapshot->'lines', '[]'::jsonb)),
        'actor_id', v.actor_id), 'activity');
  insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, after_data, source)
    values (p_org_id, v.actor_id, 'insert', 'trade_notice', v.id,
      jsonb_build_object('company_id', v.company_id, 'project_id', v.project_id, 'kind', v.kind,
        'content_hash', v.content_hash, 'provider_message_id', v.provider_message_id),
      'trade_notice');
  return to_jsonb(v);
end $$;

-- A coordinator's decision on a notice whose outcome is unknown: it did arrive
-- (mark delivered), or send it again under a new provider key. A re-sent
-- notice requeues the job that owns it.
create or replace function public.resolve_trade_notice(
  p_org_id uuid, p_id uuid, p_actor_id uuid, p_resolution text, p_note text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v public.trade_notice_deliveries%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_resolution not in ('delivered', 'resend') then raise exception 'Unknown trade notice resolution'; end if;
  if v_note is null or length(v_note) < 5 then
    raise exception 'Say why the notice is being resolved (at least 5 characters)';
  end if;
  select * into v from public.trade_notice_deliveries where org_id = p_org_id and id = p_id for update;
  if not found then raise exception 'Trade notice delivery not found' using errcode = '42501'; end if;
  if v.status <> 'ambiguous' then
    raise exception 'Only an ambiguous trade notice can be resolved' using errcode = '40001';
  end if;
  if p_resolution = 'delivered' then
    update public.trade_notice_deliveries set status = 'accepted', accepted_at = clock_timestamp(), last_error = null,
      resolved_by = p_actor_id, resolved_note = v_note where id = v.id returning * into v;
  else
    update public.trade_notice_deliveries set status = 'reserved', idempotency_key = gen_random_uuid(),
      last_attempt_at = null, resolved_by = p_actor_id, resolved_note = v_note where id = v.id returning * into v;
    update public.outbox set status = 'pending', retry_count = 0, last_error = null, run_at = clock_timestamp(),
      updated_at = clock_timestamp(), start_claim_token = null, start_job_lease_expires_at = null
      where id = v.outbox_id and org_id = p_org_id and status in ('failed', 'completed');
  end if;
  insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
    values (p_org_id, 'trade_notice.resolved', 'company', v.company_id,
      jsonb_build_object('delivery_id', v.id, 'resolution', p_resolution, 'project_id', v.project_id, 'actor_id', p_actor_id), 'activity');
  insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, after_data, source)
    values (p_org_id, p_actor_id, 'update', 'trade_notice', v.id,
      jsonb_build_object('resolution', p_resolution, 'note', v_note, 'status', v.status), 'trade_notice.resolved');
  return to_jsonb(v);
end $$;

revoke all on function public.reserve_trade_notice(uuid, text, uuid, uuid, bigint, text, jsonb, jsonb, text[], text, text, uuid) from public, anon, authenticated;
revoke all on function public.settle_trade_notice(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.resolve_trade_notice(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.reserve_trade_notice(uuid, text, uuid, uuid, bigint, text, jsonb, jsonb, text[], text, text, uuid) to service_role;
grant execute on function public.settle_trade_notice(uuid, uuid, text, text, text) to service_role;
grant execute on function public.resolve_trade_notice(uuid, uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Digest coalescing.
-- ---------------------------------------------------------------------------

-- One pending digest per (company, house, window), merged in one transaction.
-- The pending row is locked while it is merged, so a worker that claims it
-- first sends what it had and the move opens the next digest instead of
-- editing a job that already left.
create or replace function public.enqueue_trade_schedule_change(
  p_org_id uuid, p_actor_id uuid, p_company_id uuid, p_project_id uuid, p_item_id uuid, p_item_name text,
  p_old_start date, p_new_start date, p_dedupe_key text, p_delay_seconds integer
) returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_row public.outbox%rowtype;
  v_existing jsonb;
  v_old jsonb;
  v_changes jsonb;
  v_run_at timestamptz := clock_timestamp() + make_interval(secs => greatest(coalesce(p_delay_seconds, 0), 0));
  v_id bigint;
begin
  if p_dedupe_key is null or p_item_id is null then raise exception 'A schedule change names its digest and its item'; end if;
  loop
    select * into v_row from public.outbox
      where org_id = p_org_id and dedupe_key = p_dedupe_key and status = 'pending' for update;
    if found then
      v_existing := (select e from jsonb_array_elements(coalesce(v_row.payload->'changes', '[]'::jsonb)) e
        where e->>'schedule_item_id' = p_item_id::text limit 1);
      -- The trade knew the first date it was told, whatever happened since.
      v_old := case when v_existing is not null then v_existing->'old_start' else coalesce(to_jsonb(p_old_start), 'null'::jsonb) end;
      v_changes := coalesce((select jsonb_agg(e order by ord) from jsonb_array_elements(coalesce(v_row.payload->'changes', '[]'::jsonb))
        with ordinality t(e, ord) where e->>'schedule_item_id' is distinct from p_item_id::text), '[]'::jsonb);
      if v_old is distinct from coalesce(to_jsonb(p_new_start), 'null'::jsonb) then
        v_changes := v_changes || jsonb_build_array(jsonb_build_object('schedule_item_id', p_item_id,
          'name', coalesce(v_existing->>'name', p_item_name), 'old_start', v_old, 'new_start', p_new_start));
      end if;
      update public.outbox set payload = jsonb_set(payload || jsonb_build_object('actor_id', p_actor_id), '{changes}', v_changes),
        run_at = v_run_at, updated_at = clock_timestamp() where id = v_row.id;
      return v_row.id;
    end if;
    if p_old_start is not distinct from p_new_start then return null; end if;
    insert into public.outbox(org_id, job_type, dedupe_key, payload, run_at)
      values (p_org_id, 'trade_schedule_change_notice', p_dedupe_key,
        jsonb_build_object('company_id', p_company_id, 'project_id', p_project_id, 'actor_id', p_actor_id,
          'changes', jsonb_build_array(jsonb_build_object('schedule_item_id', p_item_id, 'name', p_item_name,
            'old_start', p_old_start, 'new_start', p_new_start))), v_run_at)
      on conflict (org_id, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing
      returning id into v_id;
    if v_id is not null then return v_id; end if;
  end loop;
end $$;

revoke all on function public.enqueue_trade_schedule_change(uuid, uuid, uuid, uuid, uuid, text, date, date, text, integer) from public, anon, authenticated;
grant execute on function public.enqueue_trade_schedule_change(uuid, uuid, uuid, uuid, uuid, text, date, date, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 4. The look-ahead workspace.
-- ---------------------------------------------------------------------------

-- The look-ahead statuses and purchase-order statuses are restated here
-- literally (lib/starts/lookahead-rules.ts is the twin; a test compares them).
create or replace function public.read_trade_lookahead_workspace(p_org uuid,p_actor uuid,p_weeks integer,p_division uuid default null,p_community uuid default null,p_q text default '',p_page integer default 1,p_group text default null,p_item_page integer default 1)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare start_day date:=(statement_timestamp() at time zone 'UTC')::date;end_day date;result jsonb;
begin
 if auth.uid() is null or auth.uid() is distinct from p_actor then raise exception 'Trade workspace authenticated actor mismatch' using errcode='42501';end if;
 if p_weeks is null or p_weeks not in(2,3,4) or p_page is null or p_page not between 1 and 1000000 or p_item_page is null or p_item_page not between 1 and 1000000 or p_q is null or length(p_q)>120 or length(p_group)>500 then raise exception 'Invalid trade workspace query';end if;
 end_day:=start_day+p_weeks*7;
 if exists(select 1 from public.trade_workspace_readable_homes(p_org,p_actor,p_division,p_community) h join public.lots l on l.project_id=h.project_id and l.org_id=p_org group by h.project_id having count(*)>1) then raise exception 'Trade home has multiple lot sources; reconcile the home before review';end if;
 if exists(select 1 from public.trade_workspace_readable_homes(p_org,p_actor,p_division,p_community) h join public.schedule_items s on s.project_id=h.project_id and s.org_id=p_org join public.schedule_assignments a on a.schedule_item_id=s.id left join public.companies c on c.id=a.company_id where s.start_date<=end_day and coalesce(s.end_date,s.start_date)>=start_day and s.status not in('cancelled','completed') and (a.org_id is distinct from p_org or a.project_id is distinct from s.project_id or a.company_id is not null and c.org_id is distinct from p_org)) then raise exception 'Trade assignment source belongs to another home or organization';end if;
 with homes as materialized(select project_id from public.trade_workspace_readable_homes(p_org,p_actor,p_division,p_community)),
 schedule as materialized(select s.id,s.project_id,s.name,nullif(s.trade,'') trade,s.status,s.start_date,coalesce(s.end_date,s.start_date) end_date,s.cost_code_id,
 coalesce(case when nullif(l.block,'') is not null then l.block||'-'||l.lot_number else l.lot_number end,'Lot') lot_label,coalesce(c.name,'Community') community_name
 from public.schedule_items s join homes h on h.project_id=s.project_id left join public.lots l on l.project_id=s.project_id and l.org_id=p_org left join public.communities c on c.id=l.community_id and c.org_id=p_org
 where s.org_id=p_org and s.start_date<=end_day and coalesce(s.end_date,s.start_date)>=start_day and s.status not in('cancelled','completed')),
 assigned as materialized(select s.id,a.company_id,max(c.name) company_name,bool_or(a.confirmed_at is not null) confirmed from schedule s join public.schedule_assignments a on a.schedule_item_id=s.id and a.org_id=p_org and a.project_id=s.project_id join public.companies c on c.id=a.company_id and c.org_id=p_org group by s.id,a.company_id),
 fallback as (select s.id,case when count(distinct c.id)=1 then min(c.id::text)::uuid end company_id,case when count(distinct c.id)=1 then max(c.name) end company_name from schedule s
 join public.commitments po on po.org_id=p_org and po.project_id=s.project_id and po.commitment_type='purchase_order' and po.status in('approved','complete')
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

-- ---------------------------------------------------------------------------
-- 5. Recovery: every failed notice of a house, and the Trades desk's view.
-- ---------------------------------------------------------------------------

-- The release notices of a house, its schedule-change digests, and its package
-- notices are all this house's: any of them that failed is requeued here.
create or replace function public.retry_start_trade_notice(p_org_id uuid,p_package_id uuid,p_notice_id bigint,p_actor_id uuid)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype; v_notice public.outbox%rowtype;
begin
  if p_notice_id is null or p_notice_id<=0 then raise exception 'Invalid trade notice request'; end if;
  v_pkg:=public.lock_starts_desk_package(p_org_id,p_package_id,p_actor_id,array['start.release','start.write']);
  if v_pkg.status is distinct from 'released' then
    raise exception 'Only released houses can retry trade delivery' using errcode='40001'; end if;
  select * into v_notice from public.outbox where org_id=p_org_id and id=p_notice_id
    and ((job_type in ('start_release_trade_notice','start_package_notice') and payload->>'start_package_id'=p_package_id::text)
      or (job_type='trade_schedule_change_notice' and payload->>'project_id'=v_pkg.project_id::text)) for update;
  if not found then raise exception 'Trade notice not found' using errcode='42501'; end if;
  if v_notice.status is distinct from 'failed' then
    raise exception 'Only failed trade notices can be retried' using errcode='40001'; end if;
  update public.outbox set status='pending',retry_count=0,last_error=null,run_at=clock_timestamp(),updated_at=clock_timestamp(),
    payload=payload||jsonb_build_object('actor_id',p_actor_id),start_claim_token=null,start_job_lease_expires_at=null
    where id=p_notice_id;
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
    values(p_org_id,p_actor_id,'update','start_trade_notice',p_package_id,
      jsonb_build_object('id',v_notice.id,'notice_id',p_notice_id::text,'status',v_notice.status,'retry_count',v_notice.retry_count,
        'last_error',v_notice.last_error,'payload',v_notice.payload),
      jsonb_build_object('notice_id',p_notice_id::text,'status','pending','actor_id',p_actor_id,'start_package_id',p_package_id),
      'starts.trade_notice_retried');
  insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
    values(p_org_id,'start.trade_notice_retried','start_package',p_package_id,
      jsonb_build_object('notice_id',p_notice_id::text,'company_id',v_notice.payload->>'company_id','job_type',v_notice.job_type,'actor_id',p_actor_id),'activity');
  return jsonb_build_object('notice_id',p_notice_id::text,'status','pending');
end $$;

-- A delivery whose outcome is unknown is resolved on the house's package sheet
-- (or the desk, for a look-ahead no house owns); the package the notice belongs
-- to is the one the caller must be able to see.
create or replace function public.list_trade_notice_attention(
  p_org_id uuid, p_division_ids uuid[], p_member_user_id uuid, p_limit integer
) returns jsonb
language sql
stable
set search_path = ''
as $$
  with job_rows as (
    select 'job'::text source, o.id::text id, o.job_type kind, o.status,
      o.last_error, o.retry_count attempts, o.updated_at,
      coalesce(nullif(o.payload->>'project_id', '')::uuid, sp.project_id) project_id,
      coalesce(nullif(o.payload->>'start_package_id', '')::uuid,
        (select s.id from public.start_packages s where s.org_id = o.org_id
          and s.project_id = nullif(o.payload->>'project_id', '')::uuid order by s.created_at desc limit 1)) package_id,
      nullif(o.payload->>'company_id', '')::uuid company_id
    from public.outbox o
    left join public.start_packages sp on sp.org_id = o.org_id and sp.id = nullif(o.payload->>'start_package_id', '')::uuid
    where o.org_id = p_org_id and o.status = 'failed'
      and o.job_type in ('start_release_trade_notice', 'trade_schedule_change_notice', 'start_package_notice')
      and not exists (select 1 from public.trade_notice_deliveries d where d.outbox_id = o.id and d.status in ('failed', 'ambiguous'))
  ), delivery_rows as (
    select 'delivery'::text source, d.id::text id, d.kind, d.status, d.last_error, d.attempts, d.updated_at,
      d.project_id,
      (select s.id from public.start_packages s where s.org_id = d.org_id and s.project_id = d.project_id order by s.created_at desc limit 1) package_id,
      d.company_id
    from public.trade_notice_deliveries d
    where d.org_id = p_org_id and d.status in ('failed', 'ambiguous')
  ), attention as (
    select * from job_rows union all select * from delivery_rows
  ), visible as (
    select a.*, c.name company_name, p.name project_name from attention a
    left join public.companies c on c.org_id = p_org_id and c.id = a.company_id
    left join public.projects p on p.org_id = p_org_id and p.id = a.project_id
    where (p_division_ids is null or (a.project_id is not null and p.division_id = any (p_division_ids)))
      and (p_member_user_id is null or (a.project_id is not null and exists (
        select 1 from public.project_members pm where pm.org_id = p_org_id and pm.project_id = a.project_id
          and pm.user_id = p_member_user_id and pm.status = 'active')))
  )
  select jsonb_build_object(
    'total', (select count(*) from visible),
    'rows', coalesce((select jsonb_agg(to_jsonb(r) order by r.updated_at desc, r.id) from (
      select source, id, kind, status, last_error, attempts, updated_at, project_id, project_name, package_id, company_id, company_name
      from visible order by updated_at desc, id limit least(greatest(p_limit, 1), 100)) r), '[]'::jsonb))
$$;

revoke all on function public.list_trade_notice_attention(uuid, uuid[], uuid, integer) from public, anon, authenticated;
grant execute on function public.list_trade_notice_attention(uuid, uuid[], uuid, integer) to service_role;
