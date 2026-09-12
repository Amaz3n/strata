-- Correct the project label lookup: projects has location JSONB, not an address column.
-- Preserve the atomic save, idempotency, and service-only permissions.
create or replace function public.create_daily_log_submission(
  p_org_id uuid, p_project_id uuid, p_actor_id uuid,
  p_submission_id uuid, p_input jsonb, p_mentioned_user_ids uuid[] default '{}'
) returns jsonb
language plpgsql security invoker set search_path = ''
as $$
declare
  v_log public.daily_logs%rowtype;
  v_report public.daily_reports%rowtype;
  v_entry jsonb;
  v_user_id uuid;
  v_location text;
  v_event public.events%rowtype;
  v_events jsonb := '[]'::jsonb;
  v_replayed boolean := false;
  v_actor_name text;
  v_project_name text;
  v_mark boolean;
begin
  if p_submission_id is null or p_actor_id is null or p_input is null then
    raise exception 'Submission, actor and input are required';
  end if;
  if not exists (select 1 from public.projects where id = p_project_id and org_id = p_org_id) then
    raise exception 'Project not found';
  end if;
  -- Serialize retries before looking up the original; unique index is the final
  -- backstop. A retry never adds hours, entries, notifications or audit twice.
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || p_project_id::text || p_actor_id::text || p_submission_id::text, 0));
  select * into v_log from public.daily_logs
    where org_id = p_org_id and project_id = p_project_id
      and created_by = p_actor_id and submission_id = p_submission_id;
  if found then
    if v_log.submission_payload is distinct from p_input then
      raise exception 'This submission was already saved with different content';
    end if;
    v_replayed := true;
  else
    -- Validate every reference before any durable mutation. FK checks alone do
    -- not prove that a referenced item belongs to this project/organization.
    for v_entry in select value from jsonb_array_elements(coalesce(p_input->'entries', '[]'::jsonb)) loop
      if v_entry->>'entry_type' not in ('work','constraint','inspection','safety','delivery','note','task_update','punch_update') then
        raise exception 'Invalid entry type';
      end if;
      if v_entry->>'schedule_item_id' is not null and not exists (
        select 1 from public.schedule_items where id = (v_entry->>'schedule_item_id')::uuid and org_id = p_org_id and project_id = p_project_id
      ) then raise exception 'Schedule item is unavailable'; end if;
      if v_entry->>'task_id' is not null and not exists (
        select 1 from public.tasks where id = (v_entry->>'task_id')::uuid and org_id = p_org_id and project_id = p_project_id
      ) then raise exception 'Task is unavailable'; end if;
      if v_entry->>'punch_item_id' is not null and not exists (
        select 1 from public.punch_items where id = (v_entry->>'punch_item_id')::uuid and org_id = p_org_id and project_id = p_project_id
      ) then raise exception 'Punch item is unavailable'; end if;
      if v_entry->>'cost_code_id' is not null and not exists (
        select 1 from public.cost_codes where id = (v_entry->>'cost_code_id')::uuid and org_id = p_org_id and is_active is not false
      ) then raise exception 'Cost code is unavailable'; end if;
      if v_entry->>'location_id' is not null and not exists (
        select 1 from public.project_locations where id = (v_entry->>'location_id')::uuid and org_id = p_org_id and project_id = p_project_id and is_active
      ) then raise exception 'Location is unavailable'; end if;
    end loop;
    foreach v_user_id in array p_mentioned_user_ids loop
      if v_user_id = p_actor_id or not exists (
        select 1 from public.project_members where user_id = v_user_id and org_id = p_org_id and project_id = p_project_id and status = 'active'
      ) then raise exception 'Mentioned user is unavailable'; end if;
    end loop;

    insert into public.daily_reports(org_id, project_id, report_date, status, weather, created_by)
      values (p_org_id, p_project_id, (p_input->>'date')::date, 'draft', nullif(p_input->'weather', 'null'::jsonb), p_actor_id)
      on conflict (project_id, report_date) do nothing;
    select * into strict v_report from public.daily_reports
      where org_id = p_org_id and project_id = p_project_id and report_date = (p_input->>'date')::date for update;
    -- Submitted reports accept addenda, but their day-level conditions stay locked.
    if v_report.status = 'draft' and v_report.weather is null and p_input->>'weather' is not null then
      update public.daily_reports set weather = p_input->'weather' where id = v_report.id;
    end if;
    insert into public.daily_logs(org_id, project_id, log_date, summary, weather, daily_report_id, created_by, submission_id, submission_payload)
      values (p_org_id, p_project_id, (p_input->>'date')::date, nullif(p_input->>'summary', ''), nullif(p_input->'weather', 'null'::jsonb), v_report.id, p_actor_id, p_submission_id, p_input)
      returning * into v_log;

    for v_entry in select value from jsonb_array_elements(coalesce(p_input->'entries', '[]'::jsonb)) loop
      v_location := v_entry->>'location';
      if v_entry->>'location_id' is not null then
        select full_path into strict v_location from public.project_locations
          where id = (v_entry->>'location_id')::uuid and org_id = p_org_id and project_id = p_project_id and is_active;
      end if;
      insert into public.daily_log_entries(org_id, project_id, daily_log_id, entry_type, description, quantity, hours, progress,
        schedule_item_id, task_id, punch_item_id, cost_code_id, location_id, location, trade, labor_type, inspection_result, metadata)
      values (p_org_id, p_project_id, v_log.id, v_entry->>'entry_type', v_entry->>'description', (v_entry->>'quantity')::numeric,
        (v_entry->>'hours')::numeric, (v_entry->>'progress')::integer, (v_entry->>'schedule_item_id')::uuid,
        (v_entry->>'task_id')::uuid, (v_entry->>'punch_item_id')::uuid, (v_entry->>'cost_code_id')::uuid,
        (v_entry->>'location_id')::uuid, v_location, v_entry->>'trade', v_entry->>'labor_type', v_entry->>'inspection_result', coalesce(v_entry->'metadata', '{}'::jsonb));

      if v_entry->>'schedule_item_id' is not null and (v_entry->>'progress' is not null or v_entry->>'hours' is not null or v_entry->>'inspection_result' is not null) then
        update public.schedule_items set
          actual_hours = case when v_entry->>'hours' is not null then coalesce(actual_hours, 0) + (v_entry->>'hours')::numeric else actual_hours end,
          progress = coalesce((v_entry->>'progress')::integer, progress),
          status = case when (v_entry->>'progress')::integer >= 100 then 'completed' when (v_entry->>'progress')::integer > 0 then 'in_progress' else status end,
          inspection_result = coalesce(v_entry->>'inspection_result', inspection_result),
          inspected_at = case when v_entry->>'inspection_result' is not null then now() else inspected_at end,
          inspected_by = case when v_entry->>'inspection_result' is not null then p_actor_id else inspected_by end
          where id = (v_entry->>'schedule_item_id')::uuid and org_id = p_org_id and project_id = p_project_id;
        if not found then raise exception 'Schedule item is unavailable'; end if;
        insert into public.events(org_id,event_type,entity_type,entity_id,payload)
          values(p_org_id,'schedule_item_updated','schedule_item',(v_entry->>'schedule_item_id')::uuid,jsonb_build_object('project_id',p_project_id,'source','daily_log','actor_id',p_actor_id)) returning * into v_event;
        v_events := v_events || jsonb_build_array(to_jsonb(v_event));
      end if;
      if v_entry->>'task_id' is not null and v_entry->>'entry_type' = 'task_update' then
        v_mark := coalesce((v_entry->'metadata'->>'mark_complete')::boolean, false);
        update public.tasks set status = case when v_mark then 'done' else status end,
          completed_at = case when v_mark then now() else completed_at end,
          metadata = coalesce(metadata,'{}'::jsonb) || coalesce(v_entry->'metadata','{}'::jsonb) || jsonb_build_object('linked_daily_log_id', v_log.id)
          where id = (v_entry->>'task_id')::uuid and org_id = p_org_id and project_id = p_project_id;
        if not found then raise exception 'Task is unavailable'; end if;
        if v_mark then
          insert into public.events(org_id,event_type,entity_type,entity_id,payload)
            values(p_org_id,'task_completed','task',(v_entry->>'task_id')::uuid,jsonb_build_object('project_id',p_project_id,'source','daily_log','actor_id',p_actor_id)) returning * into v_event;
          v_events := v_events || jsonb_build_array(to_jsonb(v_event));
        end if;
      end if;
      if v_entry->>'punch_item_id' is not null and v_entry->>'entry_type' = 'punch_update' and coalesce((v_entry->'metadata'->>'mark_closed')::boolean, false) then
        update public.punch_items set status = 'closed', resolved_at = now(), resolved_by = p_actor_id
          where id = (v_entry->>'punch_item_id')::uuid and org_id = p_org_id and project_id = p_project_id;
        if not found then raise exception 'Punch item is unavailable'; end if;
        insert into public.events(org_id,event_type,entity_type,entity_id,payload)
          values(p_org_id,'punch_item_updated','punch_item',(v_entry->>'punch_item_id')::uuid,jsonb_build_object('project_id',p_project_id,'status','closed','source','daily_log','actor_id',p_actor_id)) returning * into v_event;
        v_events := v_events || jsonb_build_array(to_jsonb(v_event));
      end if;
    end loop;
    select coalesce(full_name,email,'A teammate') into v_actor_name from public.app_users where id = p_actor_id;
    select coalesce(nullif(btrim(name), ''),'a project') into v_project_name from public.projects where id = p_project_id and org_id = p_org_id;
    for v_user_id in select distinct unnest(p_mentioned_user_ids) loop
      insert into public.daily_log_mentions(org_id,project_id,daily_log_id,mentioned_user_id,mentioned_by)
        values(p_org_id,p_project_id,v_log.id,v_user_id,p_actor_id);
      insert into public.outbox(org_id,job_type,payload,dedupe_key)
        values(p_org_id,'send_daily_log_mention_email',jsonb_build_object('user_id',v_user_id,'project_id',p_project_id,
          'daily_log_id',v_log.id,'mentioned_by',p_actor_id,'source','log','title','You were mentioned in a daily log',
          'message',coalesce(v_actor_name,'A teammate') || ' mentioned you in a daily log on ' || v_project_name || case when nullif(btrim(p_input->>'summary'),'') is null then '.' else ': ' || btrim(p_input->>'summary') end),
          'daily_log_mention:' || v_log.id::text || ':' || v_user_id::text);
    end loop;
    insert into public.events(org_id,event_type,entity_type,entity_id,payload)
      values(p_org_id,'daily_log_created','daily_log',v_log.id,jsonb_build_object('project_id',p_project_id,'summary',p_input->>'summary','actor_id',p_actor_id)) returning * into v_event;
    v_events := v_events || jsonb_build_array(to_jsonb(v_event));
    insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data)
      values(p_org_id,p_actor_id,'insert','daily_log',v_log.id,to_jsonb(v_log) - 'submission_payload');
    insert into public.outbox(org_id,job_type,payload)
      values(p_org_id,'reindex_search',jsonb_build_object('entity_type','daily_log','entity_id',v_log.id));
  end if;
  return jsonb_build_object('log',to_jsonb(v_log) - 'submission_payload','replayed',v_replayed,'events',v_events,
    'entries',coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at,e.id) from public.daily_log_entries e where e.daily_log_id=v_log.id),'[]'::jsonb),
    'mentions',coalesce((select jsonb_agg(to_jsonb(m) || jsonb_build_object('user',jsonb_build_object('id',u.id,'full_name',u.full_name,'email',u.email,'avatar_url',u.avatar_url))) from public.daily_log_mentions m join public.app_users u on u.id=m.mentioned_user_id where m.daily_log_id=v_log.id and m.daily_log_comment_id is null),'[]'::jsonb));
end;
$$;
revoke all on function public.create_daily_log_submission(uuid,uuid,uuid,uuid,jsonb,uuid[]) from public, anon, authenticated;
grant execute on function public.create_daily_log_submission(uuid,uuid,uuid,uuid,jsonb,uuid[]) to service_role;

