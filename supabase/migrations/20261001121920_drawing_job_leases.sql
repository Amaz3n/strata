-- Additive drawing-only leases. Deploy schema, drain old drawing workers, then deploy consumers.
alter table public.outbox add column drawing_claim_token uuid;
alter table public.outbox add column drawing_lease_expires_at timestamptz;

create function public.claim_drawing_jobs(job_types text[], limit_value integer default 3)
returns table(job_id bigint, org_id uuid, job_type text, payload jsonb, retry_count integer, claim_token uuid)
language plpgsql set search_path = public, pg_catalog as $$
begin
  if limit_value < 1 or limit_value > 6 then raise exception 'Invalid drawing claim limit'; end if;
  if exists (select 1 from unnest(job_types) t where t not in
    ('process_drawing_set','split_drawing_chunk','process_drawing_page','enrich_drawing_metadata',
     'generate_drawing_tiles','backfill_drawing_page_text','extract_drawing_vectors','detect_drawing_changes'))
  then raise exception 'Not a drawing job type'; end if;
  return query
  with picked as (
    select o.id from public.outbox o where o.status = 'pending' and o.job_type = any(job_types)
    and o.run_at <= clock_timestamp() order by o.priority desc, o.created_at asc
    limit limit_value for update skip locked
  ) update public.outbox o set status='processing', updated_at=clock_timestamp(),
      drawing_claim_token=gen_random_uuid(), drawing_lease_expires_at=clock_timestamp()+interval '3 minutes'
    from picked where o.id=picked.id
    returning o.id,o.org_id,o.job_type,o.payload,o.retry_count,o.drawing_claim_token;
end $$;

create function public.transition_drawing_job_lease(p_id bigint,p_token uuid,p_action text,p_error text default null)
returns boolean language plpgsql set search_path = public, pg_catalog as $$
declare v_job public.outbox%rowtype;
begin
  select * into v_job from public.outbox where id=p_id and status='processing'
    and drawing_claim_token=p_token and drawing_lease_expires_at>clock_timestamp() for update;
  if not found then return false; end if;
  if p_action='heartbeat' then
    update public.outbox set updated_at=clock_timestamp(), drawing_lease_expires_at=clock_timestamp()+interval '3 minutes' where id=p_id;
  elsif p_action='release' then
    update public.outbox set status='pending',drawing_claim_token=null,drawing_lease_expires_at=null,updated_at=clock_timestamp() where id=p_id;
  elsif p_action='complete' then
    update public.outbox set status='completed',last_error=null,drawing_claim_token=null,drawing_lease_expires_at=null,updated_at=clock_timestamp() where id=p_id;
  elsif p_action='retry' then
    update public.outbox set status=case when retry_count+1>=3 then 'failed' else 'pending' end,
      run_at=case when retry_count+1>=3 then run_at else clock_timestamp()+make_interval(secs => (power(2,retry_count+1)*60)::integer) end,
      retry_count=retry_count+1,last_error=p_error,drawing_claim_token=null,drawing_lease_expires_at=null,updated_at=clock_timestamp() where id=p_id;
  else raise exception 'Invalid drawing lease transition'; end if;
  return true;
end $$;

create function public.recover_drawing_job_leases(p_job_types text[])
returns integer language plpgsql set search_path = public, pg_catalog as $$
declare v_count integer:=0; v_job public.outbox%rowtype;
begin
  for v_job in select * from public.outbox where status='processing' and job_type=any(p_job_types)
    and coalesce(drawing_lease_expires_at,updated_at+interval '3 minutes')<=clock_timestamp()
    limit 500 for update skip locked
  loop
    update public.outbox set status=case when retry_count+1>=3 then 'failed' else 'pending' end,
      retry_count=retry_count+1,run_at=clock_timestamp(),updated_at=clock_timestamp(),
      last_error='Drawing lease expired',drawing_claim_token=null,drawing_lease_expires_at=null
      where id=v_job.id;
    if v_job.retry_count+1>=3 then
      if v_job.job_type in ('process_drawing_set','split_drawing_chunk','process_drawing_page') then
        update public.drawing_revisions set processing_stage='failed',error_message='Drawing processing stopped after repeated worker interruptions. Retry this revision.'
          where id=nullif(v_job.payload->>'draftRevisionId','')::uuid and org_id=v_job.org_id and status<>'published';
      elsif v_job.job_type='enrich_drawing_metadata' then
        update public.drawing_sheet_versions set extracted_metadata=jsonb_set(coalesce(extracted_metadata,'{}'),'{sheet_detection}',
          coalesce(extracted_metadata->'sheet_detection','{}')||jsonb_build_object('vision_pending',false,'confidence','low','vision_error','Verification stopped after repeated worker interruptions. Confirm the sheet identity manually.'))
          where id=nullif(v_job.payload->>'sheetVersionId','')::uuid and org_id=v_job.org_id;
      end if;
    end if;
    v_count:=v_count+1;
  end loop;
  return v_count;
end $$;

-- Worker requests carry an isolated client header; lock the ownership row in the
-- same transaction as metadata/fanout mutations so expired owners cannot publish.
create function public.fence_drawing_worker_write() returns trigger
language plpgsql set search_path = public, pg_catalog as $$
declare v_headers jsonb; v_job public.outbox%rowtype; v_revision uuid;
begin
  v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  if v_headers->>'x-drawing-job-id' is null then return new; end if;
  select * into v_job from public.outbox where id=(v_headers->>'x-drawing-job-id')::bigint
    and drawing_claim_token=(v_headers->>'x-drawing-claim-token')::uuid
    and status='processing' and drawing_lease_expires_at>clock_timestamp() for update;
  if not found then raise exception 'Drawing job lease lost' using errcode='40001'; end if;
  if new.org_id is distinct from v_job.org_id then raise exception 'Drawing worker organization mismatch'; end if;
  v_revision:=nullif(v_job.payload->>'draftRevisionId','')::uuid;
  if v_revision is not null then
    perform 1 from public.drawing_revisions where id=v_revision and org_id=v_job.org_id for key share;
    if not found then raise exception 'Drawing revision no longer exists' using errcode='40001'; end if;
  end if;
  return new;
end $$;
create trigger drawing_worker_sheet_fence before insert or update on public.drawing_sheets for each row execute function public.fence_drawing_worker_write();
create trigger drawing_worker_version_fence before insert or update on public.drawing_sheet_versions for each row execute function public.fence_drawing_worker_write();
create trigger drawing_worker_revision_fence before insert or update on public.drawing_revisions for each row execute function public.fence_drawing_worker_write();
create trigger drawing_worker_fanout_fence before insert on public.outbox for each row execute function public.fence_drawing_worker_write();

revoke all on function public.claim_drawing_jobs(text[],integer) from public,anon,authenticated;
revoke all on function public.transition_drawing_job_lease(bigint,uuid,text,text) from public,anon,authenticated;
revoke all on function public.recover_drawing_job_leases(text[]) from public,anon,authenticated;
revoke all on function public.fence_drawing_worker_write() from public,anon,authenticated;
grant execute on function public.claim_drawing_jobs(text[],integer) to service_role;
grant execute on function public.transition_drawing_job_lease(bigint,uuid,text,text) to service_role;
grant execute on function public.recover_drawing_job_leases(text[]) to service_role;
