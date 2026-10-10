-- Starts: the coordinator's release controls (queue, retry, cancel) and the
-- worker's publication, each one transaction.
--
-- Requires 20261003048000_starts_release_and_purchasing_fences (claim tokens,
-- the package/step/gate fences and assert_starts_release_actor) and ships with
-- it: those fences refuse every browser-role write to start packages, steps,
-- gates and starts jobs, so the interactive mutations run as the service role
-- after the service has authorized the caller, and the ones that touch a
-- release in flight run here, where they re-check the actor and coordinate with
-- the worker's claim under the same locks the fences take.
--
-- Lock order everywhere is the package's start_release jobs, then the package —
-- the order the worker fences and claim transitions use.
--
-- Every audit row written here is paired with a `reindex_search` outbox job in
-- the same transaction: that job is what recordAudit() enqueues for TS writes,
-- and SQL audits bypass recordAudit, so without it the start package's status
-- in global search would only move on the next TS-side edit.

create function public.lock_starts_release_control(p_org_id uuid,p_package_id uuid,p_actor_id uuid)
returns public.start_packages language plpgsql set search_path=public,pg_catalog as $$
declare v_headers jsonb; v_pkg public.start_packages%rowtype; v_actor public.outbox%rowtype;
begin
  if current_user in ('anon','authenticated') then
    raise exception 'Starts release control requires an authorized server action' using errcode='42501'; end if;
  if p_org_id is null or p_package_id is null or p_actor_id is null then raise exception 'Invalid starts release request'; end if;
  v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  if v_headers->>'x-starts-job-id' is not null or v_headers->>'x-starts-claim-token' is not null then
    raise exception 'Starts release control cannot run inside a worker claim' using errcode='42501'; end if;
  perform 1 from public.outbox where org_id=p_org_id and job_type='start_release'
    and payload->>'start_package_id'=p_package_id::text order by id for update;
  select * into v_pkg from public.start_packages where org_id=p_org_id and id=p_package_id for update;
  if not found then raise exception 'Start package not found' using errcode='42501'; end if;
  -- The coordinator is the actor: current membership, start.release (grants,
  -- denies, wildcard) and division reach over the community, lot and home.
  v_actor.org_id:=p_org_id;
  v_actor.job_type:='start_release';
  v_actor.payload:=jsonb_build_object('start_package_id',p_package_id,'actor_id',p_actor_id);
  perform public.assert_starts_release_actor(v_actor,v_pkg);
  return v_pkg;
end $$;
revoke all on function public.lock_starts_release_control(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.lock_starts_release_control(uuid,uuid,uuid) to service_role;

-- Claim the package, measure the week with this house in it, seed the step
-- ledger and queue the job — or change nothing and report the slot.
create function public.queue_start_release(p_org_id uuid,p_package_id uuid,p_actor_id uuid,
  p_scheduled_start_date date,p_target_week date,p_slot_target integer,p_confirm_over_slot boolean)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype; v_others integer; v_over boolean; v_job_id bigint;
  v_now timestamptz:=clock_timestamp(); v_after jsonb;
begin
  if p_scheduled_start_date is null or p_target_week is null or p_slot_target is null or p_slot_target<0
    or p_confirm_over_slot is null then raise exception 'Invalid starts release request'; end if;
  v_pkg:=public.lock_starts_release_control(p_org_id,p_package_id,p_actor_id);
  if v_pkg.status is distinct from 'ready' then raise exception 'The start package is not ready to release.' using errcode='40001'; end if;
  if v_pkg.project_id is null then raise exception 'The start package has no home to release.' using errcode='42501'; end if;
  if exists(select 1 from public.outbox where org_id=p_org_id and job_type='start_release'
    and payload->>'start_package_id'=p_package_id::text and status in ('pending','processing')) then
    raise exception 'This start package is already being released.' using errcode='40001'; end if;
  -- Two coordinators releasing into the same week must each count the other.
  perform pg_advisory_xact_lock(hashtextextended('start_release_week:'||p_org_id||':'||v_pkg.community_id||':'||p_target_week,0));
  select count(*) into v_others from public.start_packages where org_id=p_org_id and community_id=v_pkg.community_id
    and target_week=p_target_week and status in ('releasing','released') and id<>p_package_id;
  v_over:=v_others+1>p_slot_target;
  if v_over and not p_confirm_over_slot then
    return jsonb_build_object('queued',false,'target_week',p_target_week,'target',p_slot_target,'already_targeted',v_others);
  end if;
  update public.start_packages set status='releasing',scheduled_start_date=p_scheduled_start_date,target_week=p_target_week,
    released_by=p_actor_id,
    metadata=coalesce(metadata,'{}')||jsonb_build_object('release_requested_at',v_now,'release_lease_token',null,'release_lease_at',null)
    where org_id=p_org_id and id=p_package_id;
  -- A cancelled release keeps what it already committed; re-releasing resumes.
  insert into public.start_release_steps(org_id,start_package_id,step_key,status,completed_at,started_at,error)
    select p_org_id,p_package_id,step,case when step='project' then 'completed' else 'pending' end,
      case when step='project' then v_now end,null,null
    from unnest(array['project','budget','schedule','checklists','drawings','pos','notify_trades','finalize']) step
  on conflict (start_package_id,step_key) do update set status=excluded.status,completed_at=excluded.completed_at,started_at=null,error=null
    where public.start_release_steps.status not in ('completed','skipped');
  insert into public.outbox(org_id,job_type,payload,run_at,dedupe_key)
    values(p_org_id,'start_release',jsonb_build_object('start_package_id',p_package_id,'actor_id',p_actor_id),v_now,
      'start_release:start_package_id:'||p_package_id)
    returning id into v_job_id;
  v_after:=jsonb_build_object('status','releasing','scheduled_start_date',p_scheduled_start_date,'target_week',p_target_week,
    'job_id',v_job_id::text,'target',p_slot_target,'already_targeted',v_others,'over_slot',v_over,'actor_id',p_actor_id);
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
    values(p_org_id,p_actor_id,'update','start_package',p_package_id,
      jsonb_build_object('status',v_pkg.status,'scheduled_start_date',v_pkg.scheduled_start_date,'target_week',v_pkg.target_week),
      v_after,'starts.release_queued');
  insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
    values(p_org_id,case when v_over then 'start.released_over_slot' else 'start.release_queued' end,'start_package',p_package_id,v_after,'activity');
  insert into public.outbox(org_id,job_type,payload) values(p_org_id,'reindex_search',jsonb_build_object('entity_type','start_package','entity_id',p_package_id));
  return jsonb_build_object('queued',true,'job_id',v_job_id::text,'over_slot',v_over,
    'target_week',p_target_week,'target',p_slot_target,'already_targeted',v_others);
end $$;
revoke all on function public.queue_start_release(uuid,uuid,uuid,date,date,integer,boolean) from public,anon,authenticated;
grant execute on function public.queue_start_release(uuid,uuid,uuid,date,date,integer,boolean) to service_role;

-- A retry is the coordinator deciding the parked attempt is over. It refuses
-- while any attempt is still queued or claimed, so it cannot race a worker.
create function public.retry_start_release(p_org_id uuid,p_package_id uuid,p_actor_id uuid)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype; v_job public.outbox%rowtype; v_payload jsonb; v_after jsonb;
begin
  v_pkg:=public.lock_starts_release_control(p_org_id,p_package_id,p_actor_id);
  if v_pkg.status is distinct from 'attention' then raise exception 'Only releases needing attention can be retried.' using errcode='40001'; end if;
  if exists(select 1 from public.outbox where org_id=p_org_id and job_type='start_release'
    and payload->>'start_package_id'=p_package_id::text and status in ('pending','processing')) then
    raise exception 'A release attempt is still running for this start package.' using errcode='40001'; end if;
  update public.start_packages set status='releasing',released_by=p_actor_id,
    metadata=coalesce(metadata,'{}')||jsonb_build_object('release_lease_token',null,'release_lease_at',null)
    where org_id=p_org_id and id=p_package_id;
  v_payload:=jsonb_build_object('start_package_id',p_package_id,'actor_id',p_actor_id);
  select * into v_job from public.outbox where org_id=p_org_id and job_type='start_release'
    and payload->>'start_package_id'=p_package_id::text order by id desc limit 1;
  if found then
    update public.outbox set status='pending',retry_count=0,last_error=null,run_at=clock_timestamp(),updated_at=clock_timestamp(),
      payload=payload||v_payload,start_claim_token=null,start_job_lease_expires_at=null
      where id=v_job.id and org_id=p_org_id returning * into v_job;
  else
    insert into public.outbox(org_id,job_type,payload,run_at,dedupe_key)
      values(p_org_id,'start_release',v_payload,clock_timestamp(),'start_release:start_package_id:'||p_package_id)
      returning * into v_job;
  end if;
  v_after:=jsonb_build_object('status','releasing','job_id',v_job.id::text,'actor_id',p_actor_id);
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
    values(p_org_id,p_actor_id,'update','start_package',p_package_id,jsonb_build_object('status',v_pkg.status),v_after,'starts.release_retried');
  insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
    values(p_org_id,'start.release_retried','start_package',p_package_id,v_after,'activity');
  insert into public.outbox(org_id,job_type,payload) values(p_org_id,'reindex_search',jsonb_build_object('entity_type','start_package','entity_id',p_package_id));
  return jsonb_build_object('job_id',v_job.id::text);
end $$;
revoke all on function public.retry_start_release(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.retry_start_release(uuid,uuid,uuid) to service_role;

-- Cancel preempts a worker rather than waiting for it: the claim is revoked in
-- the same transaction that returns the package to ready, and every fenced
-- worker write rechecks both under the package lock, so nothing a preempted
-- worker attempts afterwards can land. Settled steps stay settled — their work
-- is on the house — and the rest return to pending for the next release.
create function public.cancel_start_release(p_org_id uuid,p_package_id uuid,p_actor_id uuid)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype; v_preserved text[]; v_reset text[]; v_stopped integer; v_after jsonb;
begin
  v_pkg:=public.lock_starts_release_control(p_org_id,p_package_id,p_actor_id);
  if v_pkg.status is null or v_pkg.status not in ('releasing','attention') then
    raise exception 'This release is not cancellable.' using errcode='40001'; end if;
  select coalesce(array_agg(step_key order by step_key) filter(where status in ('completed','skipped')),'{}'),
    coalesce(array_agg(step_key order by step_key) filter(where status not in ('completed','skipped')),'{}')
    into v_preserved,v_reset
    from public.start_release_steps where org_id=p_org_id and start_package_id=p_package_id;
  update public.outbox set status='failed',last_error='Release cancelled by coordinator',updated_at=clock_timestamp(),
    start_claim_token=null,start_job_lease_expires_at=null
    where org_id=p_org_id and job_type='start_release' and payload->>'start_package_id'=p_package_id::text
      and status in ('pending','processing');
  get diagnostics v_stopped=row_count;
  update public.start_release_steps set status='pending',error=null,started_at=null,completed_at=null
    where org_id=p_org_id and start_package_id=p_package_id and status not in ('completed','skipped');
  update public.start_packages set status='ready',
    metadata=coalesce(metadata,'{}')||jsonb_build_object('release_lease_token',null,'release_lease_at',null)
    where org_id=p_org_id and id=p_package_id;
  v_after:=jsonb_build_object('status','ready','release_cancelled',true,'preserved_steps',to_jsonb(v_preserved),
    'reset_steps',to_jsonb(v_reset),'stopped_jobs',v_stopped,'actor_id',p_actor_id);
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
    values(p_org_id,p_actor_id,'update','start_package',p_package_id,
      jsonb_build_object('status',v_pkg.status,'release_lease_token',v_pkg.metadata->>'release_lease_token'),v_after,'starts.release_cancelled');
  insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
    values(p_org_id,'start.release_cancelled','start_package',p_package_id,v_after,'activity');
  insert into public.outbox(org_id,job_type,payload) values(p_org_id,'reindex_search',jsonb_build_object('entity_type','start_package','entity_id',p_package_id));
  return jsonb_build_object('preserved',to_jsonb(v_preserved),'reset',to_jsonb(v_reset));
end $$;
revoke all on function public.cancel_start_release(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.cancel_start_release(uuid,uuid,uuid) to service_role;


-- Publication under the worker's claim. The house leaves preconstruction, the
-- lot starts, the package turns released, and its audit, its `start.released`
-- event and their search reindex are written in one transaction — or nothing
-- is. The step ledger is the release's receipt: publication refuses unless
-- every step settled without error, so an interrupted or failed step can never
-- count as complete.
--
-- The worker calls this on the plain service client, not its fenced claim
-- client: it re-checks the claim, the package lease and the actor itself, and
-- the claim fences refuse the reindex jobs a worker may not enqueue.
--
-- p_event_id is the release's stable confirmation identity
-- (startsConfirmationId(org, package, 'event')): the per-recipient
-- notifications cite it, so the event they point at exists the moment the
-- house is released. Notification intent is the claimed start_release job
-- itself, locked here and still processing: it completes only after the
-- idempotent confirmation (one notification identity per recipient) has run,
-- and a worker lost after this commit leaves it to the lease reaper, whose
-- retry re-enters a released package and only re-runs that confirmation.
create function public.publish_start_release(p_org_id uuid,p_job_id bigint,p_token uuid,p_event_id uuid)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_job public.outbox%rowtype; v_pkg public.start_packages%rowtype; v_after public.start_packages%rowtype;
  v_lot public.lots%rowtype; v_project public.projects%rowtype; v_audit_id bigint; v_unsettled text[];
begin
  if current_user in ('anon','authenticated') then raise exception 'Starts publication requires service role' using errcode='42501'; end if;
  if p_event_id is null then raise exception 'Starts publication requires its confirmation identity'; end if;
  select * into v_job from public.outbox where id=p_job_id and org_id=p_org_id and job_type='start_release'
    and status='processing' and start_claim_token=p_token and start_job_lease_expires_at>clock_timestamp() for update;
  if not found then raise exception 'Starts worker lease lost' using errcode='40001'; end if;
  select * into v_pkg from public.start_packages where org_id=p_org_id and id=(v_job.payload->>'start_package_id')::uuid for update;
  if not found or v_pkg.status is distinct from 'releasing' then raise exception 'Start package no longer releasing' using errcode='40001'; end if;
  if v_pkg.metadata->>'release_lease_token' is distinct from p_token::text or v_pkg.metadata->>'release_lease_at' is null
    or (v_pkg.metadata->>'release_lease_at')::timestamptz<=clock_timestamp()-interval '5 minutes'
    then raise exception 'Start package lease lost' using errcode='40001'; end if;
  if v_pkg.project_id is null or v_pkg.scheduled_start_date is null then
    raise exception 'Release package is missing its home or start date' using errcode='42501'; end if;
  -- Also proves the lot still belongs to this package's community and home.
  perform public.assert_starts_release_actor(v_job,v_pkg);
  select coalesce(array_agg(s.step order by s.step),'{}') into v_unsettled
    from unnest(array['project','budget','schedule','checklists','drawings','pos','notify_trades','finalize']) s(step)
    left join public.start_release_steps r on r.org_id=p_org_id and r.start_package_id=v_pkg.id and r.step_key=s.step
    where r.id is null or r.error is not null or r.completed_at is null
      or not(r.status='completed' or (s.step='pos' and r.status='skipped' and r.detail->>'purchasing_enabled'='false'));
  if cardinality(v_unsettled)>0 then
    raise exception 'Release completion is not proven for: %',array_to_string(v_unsettled,', ') using errcode='40001'; end if;
  update public.lots set status='started' where org_id=p_org_id and id=v_pkg.lot_id and project_id=v_pkg.project_id returning * into v_lot;
  if not found then raise exception 'Starts lot home ancestry differs from package' using errcode='42501'; end if;
  update public.projects set start_date=v_pkg.scheduled_start_date,phase='delivery'
    where org_id=p_org_id and id=v_pkg.project_id returning * into v_project;
  if not found then raise exception 'Starts home not found in organization' using errcode='42501'; end if;
  update public.start_packages set status='released',released_at=clock_timestamp(),
    released_by=(v_job.payload->>'actor_id')::uuid,actual_start_date=v_pkg.scheduled_start_date
    where org_id=p_org_id and id=v_pkg.id returning * into v_after;
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
    values(p_org_id,v_after.released_by,'update','start_package',v_pkg.id,
      jsonb_build_object('status',v_pkg.status,'released_at',v_pkg.released_at,'actual_start_date',v_pkg.actual_start_date),
      jsonb_build_object('status',v_after.status,'released_at',v_after.released_at,'released_by',v_after.released_by,
        'actual_start_date',v_after.actual_start_date,'project_id',v_after.project_id,'lot_id',v_after.lot_id,'job_id',p_job_id::text),
      'starts.release_published')
    returning id into v_audit_id;
  insert into public.events(id,org_id,event_type,entity_type,entity_id,payload,channel)
    values(p_event_id,p_org_id,'start.released','start_package',v_pkg.id,jsonb_build_object('project_id',v_pkg.project_id,
      'lot_id',v_pkg.lot_id,'community_id',v_pkg.community_id,'start_date',v_after.actual_start_date,'actor_id',v_after.released_by),'activity');
  insert into public.outbox(org_id,job_type,payload)
    select p_org_id,'reindex_search',jsonb_build_object('entity_type',entity,'entity_id',entity_id)
    from (values('start_package',v_pkg.id),('project',v_project.id),('lot',v_lot.id)) indexed(entity,entity_id);
  return jsonb_build_object('released_at',v_after.released_at,'actual_start_date',v_after.actual_start_date,
    'audit_id',v_audit_id::text,'event_id',p_event_id);
end $$;
revoke all on function public.publish_start_release(uuid,bigint,uuid,uuid) from public,anon,authenticated;
grant execute on function public.publish_start_release(uuid,bigint,uuid,uuid) to service_role;
