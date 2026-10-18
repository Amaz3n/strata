-- Starts: the desk's package and gate mutations, each one transaction.
--
-- Requires 20261003048000_starts_release_and_purchasing_fences,
-- 20261010100000_starts_release_control and 20261010140000_starts_home_creation,
-- and ships with them. Those fences refuse every browser-role write to start
-- packages and gates, so the desk used to authorize in the service and then
-- write through the unfenced service client: ownership was checked before the
-- write, not with it, and the audit and event followed in separate requests.
-- Here every desk mutation locks the package, re-checks the actor's permission
-- and division reach over the community, lot and home, and writes the state
-- change with its audit, event, search reindex and notification intent — or
-- nothing.
--
-- Lock order is the package's start_release jobs, then the package, then its
-- gates — the order the release controls and worker fences use.
--
-- Readiness is decided here, under the package lock, from the gates as they
-- stand: a package is ready when every applicable gate the coordinator
-- answers for (not the two the release itself produces) is passed, waived or
-- not applicable. It mirrors startPackageReadiness() in lib/starts/gate-logic.ts.
-- Whether the community has a price book is read by the service and passed in.

create function public.assert_starts_desk_actor(p_package public.start_packages,p_actor_id uuid,p_permission text)
returns void language plpgsql set search_path=public,pg_catalog as $$
declare v_actor public.outbox%rowtype;
begin
  v_actor.org_id:=p_package.org_id;
  v_actor.job_type:='start_release';
  v_actor.payload:=jsonb_build_object('start_package_id',p_package.id,'actor_id',p_actor_id);
  perform public.assert_starts_actor_permission(v_actor,p_package,p_permission);
end $$;
revoke all on function public.assert_starts_desk_actor(public.start_packages,uuid,text) from public,anon,authenticated;
grant execute on function public.assert_starts_desk_actor(public.start_packages,uuid,text) to service_role;

create function public.lock_starts_desk_package(p_org_id uuid,p_package_id uuid,p_actor_id uuid,p_permissions text[])
returns public.start_packages language plpgsql set search_path=public,pg_catalog as $$
declare v_headers jsonb; v_pkg public.start_packages%rowtype; v_permission text;
begin
  if current_user in ('anon','authenticated') then
    raise exception 'Start packages require an authorized server action' using errcode='42501'; end if;
  if p_org_id is null or p_package_id is null or p_actor_id is null or coalesce(cardinality(p_permissions),0)=0 then
    raise exception 'Invalid start package request'; end if;
  v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  if v_headers->>'x-starts-job-id' is not null or v_headers->>'x-starts-claim-token' is not null then
    raise exception 'Start package desk writes cannot run inside a worker claim' using errcode='42501'; end if;
  perform 1 from public.outbox where org_id=p_org_id and job_type='start_release'
    and payload->>'start_package_id'=p_package_id::text order by id for update;
  select * into v_pkg from public.start_packages where org_id=p_org_id and id=p_package_id for update;
  if not found then raise exception 'Start package not found' using errcode='42501'; end if;
  foreach v_permission in array p_permissions loop
    perform public.assert_starts_desk_actor(v_pkg,p_actor_id,v_permission);
  end loop;
  return v_pkg;
end $$;
revoke all on function public.lock_starts_desk_package(uuid,uuid,uuid,text[]) from public,anon,authenticated;
grant execute on function public.lock_starts_desk_package(uuid,uuid,uuid,text[]) to service_role;

create function public.start_gate_applies(p_applies_when text,p_package public.start_packages,p_purchasing_enabled boolean)
returns boolean language sql immutable set search_path=public,pg_catalog as $$
  select case p_applies_when when 'financed_only' then p_package.is_financed
    when 'purchasing_enabled' then p_purchasing_enabled else true end
$$;
revoke all on function public.start_gate_applies(text,public.start_packages,boolean) from public,anon,authenticated;
grant execute on function public.start_gate_applies(text,public.start_packages,boolean) to service_role;

-- The applicable gates the coordinator answers for, and how many are satisfied.
create function public.start_package_gate_tally(p_package public.start_packages,p_purchasing_enabled boolean,p_except_key text,
  out satisfied integer,out total integer)
language sql stable set search_path=public,pg_catalog as $$
  select (count(*) filter(where g.status in ('passed','waived','not_applicable')))::integer,count(*)::integer
  from public.start_package_gates g
  join public.start_gate_definitions d on d.id=g.gate_definition_id and d.org_id=g.org_id
  where g.org_id=p_package.org_id and g.start_package_id=p_package.id
    and d.key not in ('budget','po_set') and d.key is distinct from p_except_key
    and public.start_gate_applies(d.applies_when,p_package,p_purchasing_enabled)
$$;
revoke all on function public.start_package_gate_tally(public.start_packages,boolean,text) from public,anon,authenticated;
grant execute on function public.start_package_gate_tally(public.start_packages,boolean,text) to service_role;

-- Move an open or ready package to the readiness its gates prove, with the
-- audit, event, reindex and (on ready) the notice in the same transaction.
create function public.settle_start_package_readiness(p_package public.start_packages,p_actor_id uuid,p_purchasing_enabled boolean)
returns text language plpgsql set search_path=public,pg_catalog as $$
declare v_tally record; v_next text; v_event uuid:=gen_random_uuid(); v_after jsonb;
begin
  if p_package.status not in ('open','ready') then return p_package.status; end if;
  select * into v_tally from public.start_package_gate_tally(p_package,p_purchasing_enabled,null);
  v_next:=case when v_tally.total>0 and v_tally.satisfied=v_tally.total then 'ready' else 'open' end;
  if v_next=p_package.status then return v_next; end if;
  update public.start_packages set status=v_next where org_id=p_package.org_id and id=p_package.id;
  v_after:=jsonb_build_object('status',v_next,'gates_satisfied',v_tally.satisfied,'gates_total',v_tally.total,'actor_id',p_actor_id);
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
    values(p_package.org_id,p_actor_id,'update','start_package',p_package.id,
      jsonb_build_object('status',p_package.status),v_after,'starts.readiness_changed');
  insert into public.events(id,org_id,event_type,entity_type,entity_id,payload,channel)
    values(v_event,p_package.org_id,case v_next when 'ready' then 'start_package.ready' else 'start_package.not_ready' end,
      'start_package',p_package.id,v_after,'activity');
  insert into public.outbox(org_id,job_type,payload)
    values(p_package.org_id,'reindex_search',jsonb_build_object('entity_type','start_package','entity_id',p_package.id));
  if v_next='ready' then perform public.queue_start_package_notice(p_package,'ready',v_event,null); end if;
  return v_next;
end $$;
revoke all on function public.settle_start_package_readiness(public.start_packages,uuid,boolean) from public,anon,authenticated;
grant execute on function public.settle_start_package_readiness(public.start_packages,uuid,boolean) to service_role;

-- Edit an open or ready package. A financing change re-decides which gates
-- apply before readiness settles; the service then re-derives auto evidence.
create function public.update_start_package(p_org_id uuid,p_package_id uuid,p_actor_id uuid,p_patch jsonb,p_purchasing_enabled boolean)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype; v_after public.start_packages%rowtype; v_reapplied integer:=0; v_count integer; v_status text;
begin
  if p_purchasing_enabled is null or jsonb_typeof(p_patch) is distinct from 'object'
    or exists(select 1 from jsonb_object_keys(p_patch) k where k not in ('target_week','scheduled_start_date','is_financed','notes')) then
    raise exception 'Invalid start package update'; end if;
  v_pkg:=public.lock_starts_desk_package(p_org_id,p_package_id,p_actor_id,array['start.write']);
  if v_pkg.status not in ('open','ready') then raise exception 'Only open or ready packages can be edited.' using errcode='40001'; end if;
  update public.start_packages set
    target_week=case when p_patch ? 'target_week' then (p_patch->>'target_week')::date else target_week end,
    scheduled_start_date=case when p_patch ? 'scheduled_start_date' then (p_patch->>'scheduled_start_date')::date else scheduled_start_date end,
    is_financed=case when p_patch ? 'is_financed' then (p_patch->>'is_financed')::boolean else is_financed end,
    notes=case when p_patch ? 'notes' then p_patch->>'notes' else notes end
    where org_id=p_org_id and id=p_package_id returning * into v_after;
  update public.start_package_gates g set status='not_applicable',passed_via=null
    from public.start_gate_definitions d
    where d.id=g.gate_definition_id and d.org_id=g.org_id and g.org_id=p_org_id and g.start_package_id=p_package_id
      and g.status<>'not_applicable' and not public.start_gate_applies(d.applies_when,v_after,p_purchasing_enabled);
  get diagnostics v_count=row_count; v_reapplied:=v_reapplied+v_count;
  update public.start_package_gates g set status='pending',passed_via=null
    from public.start_gate_definitions d
    where d.id=g.gate_definition_id and d.org_id=g.org_id and g.org_id=p_org_id and g.start_package_id=p_package_id
      and g.status='not_applicable' and public.start_gate_applies(d.applies_when,v_after,p_purchasing_enabled);
  get diagnostics v_count=row_count; v_reapplied:=v_reapplied+v_count;
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
    values(p_org_id,p_actor_id,'update','start_package',p_package_id,to_jsonb(v_pkg),
      to_jsonb(v_after)||jsonb_build_object('gates_reapplied',v_reapplied),'starts.package_updated');
  insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
    values(p_org_id,'start_package.updated','start_package',p_package_id,p_patch||jsonb_build_object('actor_id',p_actor_id),'activity');
  insert into public.outbox(org_id,job_type,payload)
    values(p_org_id,'reindex_search',jsonb_build_object('entity_type','start_package','entity_id',p_package_id));
  v_status:=public.settle_start_package_readiness(v_after,p_actor_id,p_purchasing_enabled);
  return jsonb_build_object('status',v_status);
end $$;
revoke all on function public.update_start_package(uuid,uuid,uuid,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.update_start_package(uuid,uuid,uuid,jsonb,boolean) to service_role;

-- Attest, waive or reopen one gate. Attesting needs start.write plus the
-- gate's own attestation permission, and final approval only once every other
-- gate the coordinator answers for is clear; waiving needs start.release.
create function public.mutate_start_gate(p_org_id uuid,p_package_id uuid,p_gate_id uuid,p_actor_id uuid,
  p_action text,p_input jsonb,p_purchasing_enabled boolean)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype; v_gate public.start_package_gates%rowtype; v_after public.start_package_gates%rowtype;
  v_def public.start_gate_definitions%rowtype; v_tally record; v_event uuid:=gen_random_uuid(); v_reason text;
  v_evidence uuid; v_verb text; v_status text;
begin
  if p_action is null or p_action not in ('attest','waive','reopen') or p_purchasing_enabled is null
    or jsonb_typeof(coalesce(p_input,'{}')) is distinct from 'object' then raise exception 'Invalid start gate request'; end if;
  v_pkg:=public.lock_starts_desk_package(p_org_id,p_package_id,p_actor_id,
    case when p_action='waive' then array['start.release'] else array['start.write'] end);
  if v_pkg.status not in ('open','ready') then raise exception 'Gates cannot change after release begins.' using errcode='40001'; end if;
  select * into v_gate from public.start_package_gates where org_id=p_org_id and start_package_id=p_package_id and id=p_gate_id for update;
  if not found then raise exception 'Start gate not found' using errcode='42501'; end if;
  select * into v_def from public.start_gate_definitions where org_id=p_org_id and id=v_gate.gate_definition_id;
  if not found then raise exception 'Start gate not found' using errcode='42501'; end if;
  if p_action='attest' then
    if v_def.check_kind<>'manual' then raise exception 'Only manual gates can be attested.' using errcode='42501'; end if;
    if v_def.requires_attestation_permission is not null then
      perform public.assert_starts_desk_actor(v_pkg,p_actor_id,v_def.requires_attestation_permission); end if;
    if v_def.key='final_approval' then
      select * into v_tally from public.start_package_gate_tally(v_pkg,p_purchasing_enabled,'final_approval');
      if v_tally.satisfied<>v_tally.total then
        raise exception 'Clear every other readiness gate before final approval.' using errcode='40001'; end if;
    end if;
    v_evidence:=nullif(p_input->>'evidence_file_id','')::uuid;
    if v_evidence is not null then
      perform 1 from public.files where org_id=p_org_id and id=v_evidence;
      if not found then raise exception 'Evidence file not found' using errcode='42501'; end if;
    end if;
    update public.start_package_gates set status='passed',passed_via='attested',attested_by=p_actor_id,attested_at=clock_timestamp(),
      evidence_file_id=v_evidence,notes=nullif(btrim(coalesce(p_input->>'notes','')),''),waived_reason=null
      where id=p_gate_id returning * into v_after;
    v_verb:='attested';
  elsif p_action='waive' then
    v_reason:=btrim(coalesce(p_input->>'reason',''));
    if length(v_reason)<10 then raise exception 'A waiver needs a reason of at least 10 characters.'; end if;
    update public.start_package_gates set status='waived',passed_via='waived',attested_by=p_actor_id,attested_at=clock_timestamp(),
      waived_reason=v_reason where id=p_gate_id returning * into v_after;
    v_verb:='waived';
  else
    update public.start_package_gates set status='pending',passed_via=null,attested_by=null,attested_at=null,waived_reason=null
      where id=p_gate_id returning * into v_after;
    v_verb:='reopened';
  end if;
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
    values(p_org_id,p_actor_id,'update','start_gate',p_gate_id,to_jsonb(v_gate),to_jsonb(v_after),'starts.gate_'||v_verb);
  insert into public.events(id,org_id,event_type,entity_type,entity_id,payload,channel)
    values(v_event,p_org_id,'start_gate.'||v_verb,'start_gate',p_gate_id,
      jsonb_strip_nulls(jsonb_build_object('start_package_id',p_package_id,'gate_key',v_def.key,'reason',v_reason,'actor_id',p_actor_id)),'activity');
  if p_action='waive' then perform public.queue_start_package_notice(v_pkg,'gate_waived',v_event,v_reason); end if;
  v_status:=public.settle_start_package_readiness(v_pkg,p_actor_id,p_purchasing_enabled);
  return jsonb_build_object('status',v_status);
end $$;
revoke all on function public.mutate_start_gate(uuid,uuid,uuid,uuid,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.mutate_start_gate(uuid,uuid,uuid,uuid,text,jsonb,boolean) to service_role;

-- Re-decide applicability and record the auto evidence the service derived
-- (p_evidence: gate id -> passed). An auto gate that applies must have
-- evidence; a waived or manual gate keeps its human verdict. Only an open or
-- ready package is refreshed — once a release begins its gates belong to it.
create function public.refresh_start_package_gates(p_org_id uuid,p_package_id uuid,p_actor_id uuid,
  p_purchasing_enabled boolean,p_evidence jsonb)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype; r record; v_to text; v_via text; v_changes jsonb:='[]'; v_status text;
begin
  if p_purchasing_enabled is null or jsonb_typeof(p_evidence) is distinct from 'object' then
    raise exception 'Invalid start gate refresh'; end if;
  v_pkg:=public.lock_starts_desk_package(p_org_id,p_package_id,p_actor_id,array['start.read']);
  if v_pkg.status not in ('open','ready') then return jsonb_build_object('status',v_pkg.status,'changed',0); end if;
  for r in select g.id,g.status,g.passed_via,d.key,d.check_kind,d.applies_when
    from public.start_package_gates g join public.start_gate_definitions d on d.id=g.gate_definition_id and d.org_id=g.org_id
    where g.org_id=p_org_id and g.start_package_id=p_package_id order by g.id for update of g
  loop
    if not public.start_gate_applies(r.applies_when,v_pkg,p_purchasing_enabled) then
      v_to:='not_applicable'; v_via:=null;
    elsif r.status='waived' or r.check_kind<>'auto' then
      if r.status<>'not_applicable' then continue; end if;
      v_to:='pending'; v_via:=null;
    else
      if jsonb_typeof(p_evidence->(r.id::text)) is distinct from 'boolean' then
        raise exception 'Readiness evidence is missing for the % gate; refresh again.',r.key using errcode='40001'; end if;
      v_to:=case when (p_evidence->>(r.id::text))::boolean then 'passed' else 'pending' end;
      v_via:=case when v_to='passed' then 'auto' end;
    end if;
    if r.status is distinct from v_to or r.passed_via is distinct from v_via then
      update public.start_package_gates set status=v_to,passed_via=v_via where id=r.id;
      v_changes:=v_changes||jsonb_build_array(jsonb_build_object('gate_id',r.id,'key',r.key,'from',r.status,'to',v_to));
    end if;
  end loop;
  if jsonb_array_length(v_changes)>0 then
    insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
      values(p_org_id,p_actor_id,'update','start_package',p_package_id,jsonb_build_object('status',v_pkg.status),
        jsonb_build_object('gates',v_changes),'starts.gates_refreshed');
    insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
      values(p_org_id,'start_gate.refreshed','start_package',p_package_id,
        jsonb_build_object('gates',v_changes,'actor_id',p_actor_id),'activity');
  end if;
  v_status:=public.settle_start_package_readiness(v_pkg,p_actor_id,p_purchasing_enabled);
  return jsonb_build_object('status',v_status,'changed',jsonb_array_length(v_changes));
end $$;
revoke all on function public.refresh_start_package_gates(uuid,uuid,uuid,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.refresh_start_package_gates(uuid,uuid,uuid,boolean,jsonb) to service_role;

-- Withdraw a package that has not begun releasing. Its lot is free for a new one.
create function public.cancel_start_package(p_org_id uuid,p_package_id uuid,p_actor_id uuid,p_reason text)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype; v_after public.start_packages%rowtype; v_reason text:=btrim(coalesce(p_reason,''));
begin
  if length(v_reason)<10 then raise exception 'Cancellation reason must be at least 10 characters.'; end if;
  v_pkg:=public.lock_starts_desk_package(p_org_id,p_package_id,p_actor_id,array['start.write']);
  if v_pkg.status in ('releasing','released') then
    raise exception 'A releasing or released start package cannot be cancelled.' using errcode='40001'; end if;
  if exists(select 1 from public.outbox where org_id=p_org_id and job_type='start_release'
    and payload->>'start_package_id'=p_package_id::text and status in ('pending','processing')) then
    raise exception 'A release attempt is still running for this start package.' using errcode='40001'; end if;
  update public.start_packages set status='cancelled',metadata=coalesce(metadata,'{}')||jsonb_build_object('cancellation_reason',v_reason)
    where org_id=p_org_id and id=p_package_id returning * into v_after;
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
    values(p_org_id,p_actor_id,'update','start_package',p_package_id,to_jsonb(v_pkg),to_jsonb(v_after),'starts.package_cancelled');
  insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
    values(p_org_id,'start_package.cancelled','start_package',p_package_id,
      jsonb_build_object('reason',v_reason,'actor_id',p_actor_id),'activity');
  insert into public.outbox(org_id,job_type,payload)
    values(p_org_id,'reindex_search',jsonb_build_object('entity_type','start_package','entity_id',p_package_id));
  return jsonb_build_object('status',v_after.status);
end $$;
revoke all on function public.cancel_start_package(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.cancel_start_package(uuid,uuid,uuid,text) to service_role;

-- Requeue one failed trade notice of a released house under the coordinator.
create function public.retry_start_trade_notice(p_org_id uuid,p_package_id uuid,p_notice_id bigint,p_actor_id uuid)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_pkg public.start_packages%rowtype; v_notice public.outbox%rowtype;
begin
  if p_notice_id is null or p_notice_id<=0 then raise exception 'Invalid trade notice request'; end if;
  v_pkg:=public.lock_starts_desk_package(p_org_id,p_package_id,p_actor_id,array['start.release','start.write']);
  if v_pkg.status is distinct from 'released' then
    raise exception 'Only released houses can retry trade delivery' using errcode='40001'; end if;
  select * into v_notice from public.outbox where org_id=p_org_id and id=p_notice_id and job_type='start_release_trade_notice'
    and payload->>'start_package_id'=p_package_id::text for update;
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
      jsonb_build_object('notice_id',p_notice_id::text,'company_id',v_notice.payload->>'company_id','actor_id',p_actor_id),'activity');
  return jsonb_build_object('notice_id',p_notice_id::text,'status','pending');
end $$;
revoke all on function public.retry_start_trade_notice(uuid,uuid,bigint,uuid) from public,anon,authenticated;
grant execute on function public.retry_start_trade_notice(uuid,uuid,bigint,uuid) to service_role;
