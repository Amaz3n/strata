-- STAGED, UNAPPLIED. Operator recovery must not rebuild a released house.
-- This service-only RPC is not enabled until actual-schema and QA acceptance.
create index outbox_start_release_package_idx on public.outbox(org_id,(payload->>'start_package_id'),id)
 where job_type='start_release';
create function public.retry_start_confirmation(p_org_id uuid,p_package_id uuid,p_job_id bigint,p_actor_id uuid,p_reason text)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_job public.outbox%rowtype; v_pkg public.start_packages%rowtype; v_actor_job public.outbox%rowtype;
 v_before jsonb; v_after jsonb; v_headers jsonb; v_event_id uuid; v_audit_id bigint;
begin
 if current_user in ('anon','authenticated') then raise exception 'Confirmation recovery requires service role' using errcode='42501'; end if;
 if p_org_id is null or p_package_id is null or p_job_id is null or p_job_id<=0 or p_actor_id is null
   or p_reason is null or length(btrim(p_reason))<10 or length(btrim(p_reason))>1000 then raise exception 'Invalid confirmation recovery request'; end if;
 v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
 if v_headers->>'x-starts-job-id' is not null or v_headers->>'x-starts-claim-token' is not null then
   raise exception 'Confirmation recovery cannot run inside a worker claim' using errcode='42501'; end if;
 -- Match worker job -> package lock order. Reuse this exact failed job; never
 -- insert replacement jobs when history was pruned or is ambiguous.
 select * into v_job from public.outbox where org_id=p_org_id and id=p_job_id
   and job_type='start_release' and payload->>'start_package_id'=p_package_id::text for update;
 if not found then raise exception 'Confirmation job unavailable in package' using errcode='42501'; end if;
 if v_job.status is distinct from 'failed' or v_job.start_claim_token is not null or v_job.start_job_lease_expires_at is not null then
   raise exception 'Only unclaimed failed confirmation jobs can be retried' using errcode='40001'; end if;
 select * into v_pkg from public.start_packages where org_id=p_org_id and id=p_package_id for update;
 if not found or v_pkg.status is distinct from 'released' or v_pkg.project_id is null or v_pkg.released_at is null
   or v_pkg.released_by is null or v_pkg.actual_start_date is null then
   raise exception 'Confirmation recovery requires a released home and original release evidence' using errcode='42501'; end if;
 if exists(select 1 from public.outbox where org_id=p_org_id and job_type='start_release'
   and payload->>'start_package_id'=p_package_id::text and id<>p_job_id and status in ('pending','processing')) then
   raise exception 'Another confirmation attempt is active' using errcode='40001'; end if;
 -- The coordinator authorizes recovery; confirmation still records released_by
 -- as the original release actor. Do not manufacture missing historical actors.
 v_actor_job:=v_job;
 v_actor_job.payload:=v_job.payload||jsonb_build_object('actor_id',p_actor_id);
 perform public.assert_starts_release_actor(v_actor_job,v_pkg);
 v_before:=jsonb_build_object('job_id',v_job.id::text,'status',v_job.status,'retry_count',v_job.retry_count,'actor_id',v_job.payload->>'actor_id');
 update public.outbox set status='pending',retry_count=0,last_error=null,run_at=clock_timestamp(),updated_at=clock_timestamp(),payload=v_actor_job.payload
   where id=v_job.id and org_id=p_org_id returning * into v_job;
 v_after:=jsonb_build_object('job_id',v_job.id::text,'status',v_job.status,'retry_count',v_job.retry_count,'actor_id',p_actor_id,
   'reason',btrim(p_reason),'released_by',v_pkg.released_by,'project_id',v_pkg.project_id,'released_at',v_pkg.released_at,'actual_start_date',v_pkg.actual_start_date);
 insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
   values(p_org_id,p_actor_id,'update','start_package',p_package_id,v_before,v_after,'starts.confirmation_recovery') returning id into v_audit_id;
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
   values(p_org_id,'start.confirmation_retried','start_package',p_package_id,v_after,'activity') returning id into v_event_id;
 -- Guard against late revocation or source-state changes in trigger side effects.
 select * into v_pkg from public.start_packages where org_id=p_org_id and id=p_package_id for update;
 if not found or v_pkg.status is distinct from 'released' or v_pkg.released_by::text is distinct from v_after->>'released_by'
   or v_pkg.project_id::text is distinct from v_after->>'project_id'
   or to_jsonb(v_pkg.released_at) is distinct from v_after->'released_at'
   or to_jsonb(v_pkg.actual_start_date) is distinct from v_after->'actual_start_date' then raise exception 'Release evidence changed during confirmation recovery' using errcode='40001'; end if;
 select * into v_job from public.outbox where id=p_job_id and org_id=p_org_id for update;
 if not found or v_job.status is distinct from 'pending' or v_job.start_claim_token is not null
   or v_job.payload is distinct from v_actor_job.payload then raise exception 'Confirmation intent changed during recovery' using errcode='40001'; end if;
 perform public.assert_starts_release_actor(v_actor_job,v_pkg);
 return jsonb_build_object('job_id',v_job.id::text,'event_id',v_event_id,'audit_id',v_audit_id::text,'status','pending');
end $$;
revoke all on function public.retry_start_confirmation(uuid,uuid,bigint,uuid,text) from public,anon,authenticated;
grant execute on function public.retry_start_confirmation(uuid,uuid,bigint,uuid,text) to service_role;
