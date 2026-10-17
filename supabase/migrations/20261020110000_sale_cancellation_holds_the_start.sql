-- EP13 review: a cancelled sale holds the home's start, and signing executes once.
--
-- 1. Cancelling a sale reopened the start package but left what the sale had proved:
--    the financing and selections gates stayed passed and the selection groups locked,
--    and a home with no agreement in force read as a spec home whose financing needs
--    nothing. A refresh then found no change and the release queued on a voided sale.
--    The cancellation now holds the package lock before it reads its plan, resets the
--    sale-derived gates (passed or waived) to pending, reopens the home's selection
--    groups and audits it on the package; a home that has had a purchase agreement and
--    has none in force never passes the financing gate on evidence; and the release
--    queue refuses such a home under its lock unless that gate was waived.
-- 2. Executing a signed agreement read the contract unlocked and then wrote `active`
--    unconditionally, so a cancellation between the two was undone, and a second
--    delivery met the closing's unique index. execute_purchase_agreement_atomic does the
--    contract, reservation, prospect and closing writes under the contract lock, refuses
--    a void agreement, returns at once when execution finished, and hands the remaining
--    effects to one caller at a time through a leased claim; finish_purchase_agreement_execution
--    records completion and its audit row once, or gives the claim back after a failure.

create or replace function public.start_package_sale_cancelled(p_org_id uuid, p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_project_id is not null
    and exists (select 1 from public.contracts where org_id = p_org_id and project_id = p_project_id
                  and contract_type = 'purchase_agreement' and status = 'void')
    and not exists (select 1 from public.contracts where org_id = p_org_id and project_id = p_project_id
                      and contract_type = 'purchase_agreement' and status = 'active')
$$;
revoke all on function public.start_package_sale_cancelled(uuid, uuid) from public, anon, authenticated;
grant execute on function public.start_package_sale_cancelled(uuid, uuid) to service_role;

CREATE OR REPLACE FUNCTION public.void_purchase_agreement_atomic(p_org_id uuid, p_contract_id uuid, p_actor_id uuid, p_reason text, p_deposit_disposition text, p_forfeit_cents bigint, p_expected_plan_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.contracts;
  plan jsonb;
  available bigint;
  disposition text;
  forfeit bigint := 0;
  refund bigint := 0;
  v_reservation_id uuid;
  envelope jsonb;
  pending_ids uuid[];
  receipt public.purchase_agreement_cancellations;
  v_reason text := btrim(coalesce(p_reason, ''));
  reopened_ids uuid[];
  reset_gates jsonb;
  reopened_groups integer;
begin
  if p_actor_id is null or not exists (select 1 from public.app_users where id = p_actor_id) then
    raise exception 'A sale is cancelled by a person' using errcode = '22023';
  end if;
  if (select auth.uid()) is not null and (select auth.uid()) <> p_actor_id then
    raise exception 'Cancellation actor mismatch' using errcode = '42501';
  end if;
  if char_length(v_reason) < 3 then raise exception 'A cancellation reason is required'; end if;
  if p_deposit_disposition not in ('refund', 'forfeit', 'split') then raise exception 'Unknown deposit disposition'; end if;

  select * into c from public.contracts
   where org_id = p_org_id and id = p_contract_id and contract_type = 'purchase_agreement' for update;
  if not found or c.status not in ('draft', 'active') then raise exception 'Active purchase agreement not found'; end if;
  -- The home's start package is held from here, before the plan is read: a release queued
  -- while this waits would otherwise commit `releasing` under a plan that said the
  -- package returns to open, and the update below would then match nothing.
  perform 1 from public.start_packages where org_id = p_org_id and project_id = c.project_id order by id for update;
  plan := public.preview_purchase_agreement_cancellation(p_org_id, p_contract_id);
  if plan->>'blocked' is not null then raise exception '%', plan->>'blocked'; end if;
  if plan->>'hash' is distinct from p_expected_plan_hash then
    raise exception 'The sale changed since you reviewed the cancellation. Review it again.' using detail = 'AGREEMENT_CANCELLATION_CHANGED';
  end if;

  available := (plan->'deposit'->>'available_cents')::bigint;
  if available = 0 then
    disposition := 'none';
  elsif p_deposit_disposition = 'refund' then
    disposition := 'refund'; refund := available;
  elsif p_deposit_disposition = 'forfeit' then
    disposition := 'forfeit'; forfeit := available;
  else
    if p_forfeit_cents is null or p_forfeit_cents <= 0 or p_forfeit_cents >= available then
      raise exception 'A split keeps part of the deposit and refunds the rest: enter an amount between $0 and the deposit';
    end if;
    disposition := 'split'; forfeit := p_forfeit_cents; refund := available - p_forfeit_cents;
  end if;

  update public.contracts set status = 'void' where id = c.id;

  for envelope in select value from jsonb_array_elements(plan->'envelopes') loop
    perform public.cancel_esign_envelope(p_org_id, (envelope->>'id')::uuid, 'Purchase agreement cancelled: ' || v_reason, null, p_actor_id);
  end loop;

  select coalesce(array_agg((x->>'id')::uuid), '{}') into pending_ids from jsonb_array_elements(plan->'pending_change_orders') x;
  update public.change_orders
     set status = 'cancelled', lifecycle = 'void',
         metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('voided_at', now(), 'voided_by', p_actor_id,
           'void_reason', 'Purchase agreement cancelled: ' || v_reason)
   where org_id = p_org_id and id = any (pending_ids);
  update public.commitment_change_orders
     set status = 'voided',
         metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('voided_at', now(), 'voided_by', p_actor_id,
           'void_reason', 'Purchase agreement cancelled: ' || v_reason)
   where org_id = p_org_id and prime_change_order_id = any (pending_ids) and status in ('draft', 'sent');

  with reopened as (
    update public.start_packages
       set status = 'open',
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sale_cancelled',
             jsonb_build_object('contract_id', c.id, 'at', now(), 'reason', v_reason, 'previous_status', status))
     where org_id = p_org_id and project_id = c.project_id and status in ('open', 'ready')
    returning id
  )
  select coalesce(array_agg(id), '{}') into reopened_ids from reopened;

  -- What the sale proved goes with it. The buyer's financing and the locked selections
  -- were evidence of THIS sale: left passed, a later refresh found nothing new to say
  -- and the voided home released as if it were still sold. Waivers given for the sale
  -- go too; a person decides again for the home as it now stands.
  if cardinality(reopened_ids) > 0 then
    select coalesce(jsonb_agg(jsonb_build_object('start_package_id', g.start_package_id, 'gate_id', g.id, 'key', d.key, 'from', g.status, 'to', 'pending')
             order by g.start_package_id, d.key), '[]'::jsonb)
      into reset_gates
      from public.start_package_gates g
      join public.start_gate_definitions d on d.id = g.gate_definition_id and d.org_id = g.org_id
     where g.org_id = p_org_id and g.start_package_id = any (reopened_ids)
       and d.auto_source in ('agreement_milestones_clear', 'selections_locked') and g.status in ('passed', 'waived');
    update public.start_package_gates g
       set status = 'pending', passed_via = null, attested_by = null, attested_at = null, waived_reason = null, evidence_file_id = null
     where g.org_id = p_org_id and g.id in (select (x->>'gate_id')::uuid from jsonb_array_elements(reset_gates) x);
    update public.project_selection_groups set status = 'open', locked_at = null
     where org_id = p_org_id and project_id = c.project_id and status = 'locked';
    get diagnostics reopened_groups = row_count;
    insert into public.audit_log (org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
    select p_org_id, p_actor_id, 'update', 'start_package', pkg_id, jsonb_build_object('contract_id', c.id),
           jsonb_build_object('status', 'open',
             'gates', coalesce((select jsonb_agg(x - 'start_package_id') from jsonb_array_elements(reset_gates) x
                                 where (x->>'start_package_id')::uuid = pkg_id), '[]'::jsonb),
             'selection_groups_reopened', reopened_groups),
           'starts.sale_cancelled'
      from unnest(reopened_ids) pkg_id;
  end if;

  update public.project_selections set locked_at = null
   where org_id = p_org_id and project_id = c.project_id and locked_at is not null
     and status in ('pending', 'selected', 'confirmed');

  update public.closings set status = 'cancelled', cancel_reason = v_reason
   where org_id = p_org_id and project_id = c.project_id and status not in ('closed', 'cancelled');

  v_reservation_id := (plan->'reservation'->>'id')::uuid;
  if v_reservation_id is not null then
    perform public.release_lot_reservation(p_org_id, p_actor_id, v_reservation_id, v_reason,
      case when disposition in ('refund', 'forfeit') then disposition end);
    update public.prospects set status = 'qualified', won_at = null, updated_at = now()
     where org_id = p_org_id and id = (plan->'reservation'->>'prospect_id')::uuid and status = 'won';
  end if;
  update public.projects set client_id = null where org_id = p_org_id and id = c.project_id and client_id is not null;

  insert into public.purchase_agreement_cancellations (org_id, project_id, contract_id, reservation_id, actor_id, reason,
    deposit_disposition, forfeit_cents, refund_cents, plan, plan_hash, outcomes, settlement_status)
  values (p_org_id, c.project_id, c.id, v_reservation_id, p_actor_id, v_reason, disposition, forfeit, refund,
    plan - 'hash', plan->>'hash',
    jsonb_build_object('voided', true, 'envelopes_voided', jsonb_array_length(plan->'envelopes'),
      'change_orders_voided', cardinality(pending_ids)),
    'pending')
  returning * into receipt;
  return jsonb_build_object('cancellation', to_jsonb(receipt), 'before', jsonb_build_object('status', c.status));
end;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_start_package_gates(p_org_id uuid, p_package_id uuid, p_actor_id uuid, p_purchasing_enabled boolean, p_evidence jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare v_pkg public.start_packages%rowtype; r record; v_to text; v_via text; v_changes jsonb:='[]'; v_status text;
begin
  if p_purchasing_enabled is null or jsonb_typeof(p_evidence) is distinct from 'object' then
    raise exception 'Invalid start gate refresh'; end if;
  v_pkg:=public.lock_starts_desk_package(p_org_id,p_package_id,p_actor_id,array['start.read']);
  if v_pkg.status not in ('open','ready') then return jsonb_build_object('status',v_pkg.status,'changed',0); end if;
  for r in select g.id,g.status,g.passed_via,d.key,d.check_kind,d.applies_when,d.auto_source
    from public.start_package_gates g join public.start_gate_definitions d on d.id=g.gate_definition_id and d.org_id=g.org_id
    where g.org_id=p_org_id and g.start_package_id=p_package_id order by g.id for update of g
  loop
    if not public.start_gate_applies(r.applies_when,v_pkg,p_purchasing_enabled) then
      v_to:='not_applicable'; v_via:=null;
    elsif r.check_kind='auto' and r.auto_source='permit_approved' then
      v_to:=case when public.start_gate_sql_evidence(p_org_id,p_package_id,r.auto_source) then 'passed' else 'pending' end;
      v_via:=case when v_to='passed' then 'auto' end;
    elsif r.status='waived' or r.check_kind<>'auto' then
      if r.status<>'not_applicable' then continue; end if;
      v_to:='pending'; v_via:=null;
    elsif r.auto_source='plot_plan_file' then
      v_to:=case when public.start_gate_sql_evidence(p_org_id,p_package_id,r.auto_source) then 'passed' else 'pending' end;
      v_via:=case when v_to='passed' then 'auto' end;
    else
      if jsonb_typeof(p_evidence->(r.id::text)) is distinct from 'boolean' then
        raise exception 'Readiness evidence is missing for the % gate; refresh again.',r.key using errcode='40001'; end if;
      -- A home whose sale was cancelled is not a spec home: "no agreement in force" proves
      -- nothing about its buyer's financing, whatever the caller read.
      v_to:=case when (p_evidence->>(r.id::text))::boolean
        and not (r.auto_source='agreement_milestones_clear' and public.start_package_sale_cancelled(p_org_id,v_pkg.project_id))
        then 'passed' else 'pending' end;
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
end $function$;

CREATE OR REPLACE FUNCTION public.queue_start_release(p_org_id uuid, p_package_id uuid, p_actor_id uuid, p_scheduled_start_date date, p_target_week date, p_slot_target integer, p_confirm_over_slot boolean, p_over_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare v_pkg public.start_packages%rowtype; v_others integer; v_job_id bigint;
  v_now timestamptz:=clock_timestamp(); v_after jsonb;
  v_super uuid; v_division uuid; v_target integer; v_exceeded jsonb:='[]'::jsonb; v_first jsonb;
  v_reason text:=nullif(btrim(coalesce(p_over_reason,'')),''); v_over boolean;
begin
  if p_scheduled_start_date is null or p_target_week is null or p_slot_target is null or p_slot_target<0
    or p_confirm_over_slot is null then raise exception 'Invalid starts release request'; end if;
  v_pkg:=public.lock_starts_release_control(p_org_id,p_package_id,p_actor_id);
  if v_pkg.status is distinct from 'ready' then raise exception 'The start package is not ready to release.' using errcode='40001'; end if;
  if v_pkg.project_id is null then raise exception 'The start package has no home to release.' using errcode='42501'; end if;
  select superintendent_id into v_super from public.projects where org_id=p_org_id and id=v_pkg.project_id for share;
  if v_super is null then raise exception 'Assign a superintendent to this house before releasing it.' using errcode='40001'; end if;
  if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=v_super and status='active') then
    raise exception 'This house''s superintendent is no longer an active member. Assign another before releasing it.' using errcode='40001'; end if;
  -- Read under the package lock the cancellation also takes: a home whose sale was
  -- cancelled starts only as a spec home someone decided on, by waiving its financing gate.
  if public.start_package_sale_cancelled(p_org_id,v_pkg.project_id) and not exists(
      select 1 from public.start_package_gates g join public.start_gate_definitions d on d.id=g.gate_definition_id and d.org_id=g.org_id
      where g.org_id=p_org_id and g.start_package_id=p_package_id and d.auto_source='agreement_milestones_clear' and g.status='waived') then
    raise exception 'This home''s sale was cancelled. Sign its new sale, or waive its financing gate to start it as a spec home.' using errcode='40001'; end if;
  if exists(select 1 from public.start_package_gates g join public.start_gate_definitions d on d.id=g.gate_definition_id and d.org_id=g.org_id
      where g.org_id=p_org_id and g.start_package_id=p_package_id and d.auto_source='permit_approved')
    and not public.start_gate_sql_evidence(p_org_id,p_package_id,'permit_approved') then
    raise exception 'The permit gate is no longer satisfied: the home''s permit changed. Refresh the package.' using errcode='40001'; end if;
  -- An attestation stands on its file: one archived or moved off the home since the gate
  -- cleared is caught here, before any release step has built anything on it.
  if exists(select 1 from public.start_package_gates g where g.org_id=p_org_id and g.start_package_id=p_package_id
      and g.status='passed' and g.passed_via='attested' and g.evidence_file_id is not null
      and not exists(select 1 from public.files f where f.id=g.evidence_file_id and f.org_id=p_org_id
        and f.project_id=v_pkg.project_id and f.archived_at is null)) then
    raise exception 'A gate''s evidence file is no longer on the home. Refresh the package.' using errcode='40001'; end if;
  if exists(select 1 from public.outbox where org_id=p_org_id and job_type='start_release'
    and payload->>'start_package_id'=p_package_id::text and status in ('pending','processing')) then
    raise exception 'This start package is already being released.' using errcode='40001'; end if;

  perform pg_advisory_xact_lock(hashtextextended('start_release_week:'||p_org_id||':'||v_pkg.community_id||':'||p_target_week,0));
  select division_id into v_division from public.communities where org_id=p_org_id and id=v_pkg.community_id;
  if v_division is not null then
    perform pg_advisory_xact_lock(hashtextextended('start_release_throughput:'||p_org_id||':'||v_division||':'||p_target_week,0));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('start_release_throughput:'||p_org_id||':org:'||p_target_week,0));

  select count(*) into v_others from public.start_packages where org_id=p_org_id and community_id=v_pkg.community_id
    and target_week=p_target_week and status in ('releasing','released','attention') and id<>p_package_id;
  if v_others+1>p_slot_target then
    v_exceeded:=v_exceeded||jsonb_build_array(jsonb_build_object('limit','community','target',p_slot_target,'already_targeted',v_others));
  end if;
  if v_division is not null then
    select target_starts into v_target from public.release_throughput_targets
      where org_id=p_org_id and division_id=v_division and week_start=p_target_week;
    if found then
      select count(*) into v_others from public.start_packages sp join public.communities c on c.id=sp.community_id and c.org_id=sp.org_id
        where sp.org_id=p_org_id and c.division_id=v_division and sp.target_week=p_target_week
        and sp.status in ('releasing','released','attention') and sp.id<>p_package_id;
      if v_others+1>v_target then
        v_exceeded:=v_exceeded||jsonb_build_array(jsonb_build_object('limit','division','target',v_target,'already_targeted',v_others));
      end if;
    end if;
  end if;
  select target_starts into v_target from public.release_throughput_targets
    where org_id=p_org_id and division_id is null and week_start=p_target_week;
  if found then
    select count(*) into v_others from public.start_packages where org_id=p_org_id and target_week=p_target_week
      and status in ('releasing','released','attention') and id<>p_package_id;
    if v_others+1>v_target then
      v_exceeded:=v_exceeded||jsonb_build_array(jsonb_build_object('limit','org','target',v_target,'already_targeted',v_others));
    end if;
  end if;

  v_over:=jsonb_array_length(v_exceeded)>0;
  if v_over then
    v_first:=v_exceeded->0;
    if not p_confirm_over_slot then
      return jsonb_build_object('queued',false,'target_week',p_target_week,'target',(v_first->>'target')::integer,
        'already_targeted',(v_first->>'already_targeted')::integer,'limit',v_first->>'limit','exceeded',v_exceeded);
    end if;
    if v_reason is null or length(v_reason)<10 then
      raise exception 'Releasing over a start target needs a reason of at least 10 characters.' using errcode='22023'; end if;
  end if;
  update public.start_packages set status='releasing',scheduled_start_date=p_scheduled_start_date,target_week=p_target_week,
    released_by=p_actor_id,
    metadata=coalesce(metadata,'{}')||jsonb_build_object('release_requested_at',v_now,'release_lease_token',null,'release_lease_at',null)
    where org_id=p_org_id and id=p_package_id;
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
    'job_id',v_job_id::text,'target',p_slot_target,'over_slot',v_over,'actor_id',p_actor_id,
    'exceeded',v_exceeded,'over_reason',case when v_over then v_reason end);
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,before_data,after_data,source)
    values(p_org_id,p_actor_id,'update','start_package',p_package_id,
      jsonb_build_object('status',v_pkg.status,'scheduled_start_date',v_pkg.scheduled_start_date,'target_week',v_pkg.target_week),
      v_after,'starts.release_queued');
  insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
    values(p_org_id,case when v_over then 'start.released_over_slot' else 'start.release_queued' end,'start_package',p_package_id,v_after,'activity');
  insert into public.outbox(org_id,job_type,payload) values(p_org_id,'reindex_search',jsonb_build_object('entity_type','start_package','entity_id',p_package_id));
  return jsonb_build_object('queued',true,'job_id',v_job_id::text,'over_slot',v_over,'target_week',p_target_week,'exceeded',v_exceeded);
end $function$;

create or replace function public.execute_purchase_agreement_atomic(p_org_id uuid, p_contract_id uuid, p_envelope_id uuid, p_executed_file_id uuid, p_claim_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.contracts;
  v_claim jsonb;
  v_signed_at timestamptz;
  v_signature jsonb;
  v_lot record;
begin
  if p_org_id is null or p_contract_id is null or p_envelope_id is null or p_claim_token is null then
    raise exception 'Invalid purchase agreement execution' using errcode = '22023';
  end if;
  select * into c from public.contracts
   where org_id = p_org_id and id = p_contract_id and contract_type = 'purchase_agreement' for update;
  if not found then raise exception 'Purchase agreement not found'; end if;
  if c.status = 'void' then raise exception 'Purchase agreement was voided' using errcode = '40001'; end if;
  if c.status = 'active' and coalesce((c.signature_data->>'execution_effects_completed')::boolean, false) then
    return jsonb_build_object('state', 'completed');
  end if;
  v_claim := c.signature_data->'execution_claim';
  if v_claim is not null and v_claim->>'token' is distinct from p_claim_token::text
     and (v_claim->>'at')::timestamptz > clock_timestamp() - interval '2 minutes' then
    return jsonb_build_object('state', 'in_progress');
  end if;

  v_signed_at := coalesce(c.signed_at, clock_timestamp());
  if c.status = 'active' then
    -- A resumed execution keeps the binding the first one recorded.
    v_signature := coalesce(c.signature_data, '{}'::jsonb);
  else
    -- The signature binds the packet the buyer was shown and the exact bytes they signed.
    v_signature := coalesce(c.signature_data, '{}'::jsonb) || jsonb_build_object(
      'envelope_id', p_envelope_id, 'executed_file_id', p_executed_file_id,
      'packet_hash', c.snapshot->'purchase_agreement'->'packet'->>'hash',
      'source_sha256', (select d.metadata->'esign_source'->>'sha256' from public.documents d
                         where d.org_id = p_org_id and d.source_entity_type = 'contract' and d.source_entity_id = c.id
                           and d.metadata @> '{"purchase_agreement": true}'::jsonb
                         order by d.created_at desc limit 1));
  end if;
  v_signature := v_signature || jsonb_build_object('execution_claim', jsonb_build_object('token', p_claim_token, 'at', clock_timestamp()));
  update public.contracts set status = 'active', signed_at = v_signed_at, signature_data = v_signature where id = c.id;

  select l.id, l.community_id into v_lot from public.lots l where l.org_id = p_org_id and l.project_id = c.project_id;
  if found then
    update public.lot_reservations set status = 'converted', converted_at = v_signed_at, contract_id = c.id
     where org_id = p_org_id and lot_id = v_lot.id and status = 'reserved';
    -- A resumed execution also finds the reservation an earlier attempt converted.
    update public.prospects p set status = 'won', won_at = v_signed_at, lost_at = null, lost_reason = null, updated_at = v_signed_at
      from public.lot_reservations r
     where r.org_id = p_org_id and r.contract_id = c.id and r.status = 'converted'
       and p.org_id = p_org_id and p.id = r.prospect_id and p.status <> 'won';
    if not exists (select 1 from public.closings where org_id = p_org_id and project_id = c.project_id and status <> 'cancelled') then
      begin
        insert into public.closings (org_id, project_id, lot_id, community_id, status, scheduled_date, buyer_contact_id)
        select p_org_id, c.project_id, v_lot.id, v_lot.community_id, 'projected', p.end_date, c.buyer_contact_id
          from public.projects p where p.org_id = p_org_id and p.id = c.project_id;
      exception when unique_violation then
        null; -- another path opened the home's closing; it is the one the sale uses
      end;
    end if;
  end if;
  return jsonb_build_object('state', 'claimed', 'project_id', c.project_id, 'signed_at', v_signed_at,
    'envelope_id', v_signature->>'envelope_id', 'packet_hash', v_signature->>'packet_hash',
    'source_sha256', v_signature->>'source_sha256', 'snapshot', c.snapshot);
end;
$$;
revoke all on function public.execute_purchase_agreement_atomic(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.execute_purchase_agreement_atomic(uuid, uuid, uuid, uuid, uuid) to service_role;

create or replace function public.finish_purchase_agreement_execution(p_org_id uuid, p_contract_id uuid, p_claim_token uuid, p_completed boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.contracts;
begin
  if p_org_id is null or p_contract_id is null or p_claim_token is null or p_completed is null then
    raise exception 'Invalid purchase agreement execution' using errcode = '22023';
  end if;
  select * into c from public.contracts
   where org_id = p_org_id and id = p_contract_id and contract_type = 'purchase_agreement' for update;
  if not found or c.signature_data->'execution_claim'->>'token' is distinct from p_claim_token::text then
    return false;
  end if;
  if not p_completed then
    update public.contracts set signature_data = signature_data - 'execution_claim' where id = c.id;
    return true;
  end if;
  update public.contracts
     set signature_data = (signature_data - 'execution_claim') || jsonb_build_object('execution_effects_completed', true)
   where id = c.id;
  insert into public.audit_log (org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
  values (p_org_id, null, 'update', 'contract', c.id, null,
    jsonb_build_object('status', c.status, 'signed_at', c.signed_at, 'packet_hash', c.signature_data->>'packet_hash',
      'source_sha256', c.signature_data->>'source_sha256'),
    'purchase_agreement_execution');
  insert into public.outbox (org_id, job_type, payload)
  values (p_org_id, 'reindex_search', jsonb_build_object('entity_type', 'contract', 'entity_id', c.id));
  return true;
end;
$$;
revoke all on function public.finish_purchase_agreement_execution(uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.finish_purchase_agreement_execution(uuid, uuid, uuid, boolean) to service_role;
