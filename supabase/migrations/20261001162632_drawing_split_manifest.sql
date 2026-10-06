-- Intent survives revision deletion and is committed BEFORE storage PUT.
create table public.drawing_split_pages (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.orgs(id),
 revision_id uuid not null, source_hash text not null, page_index integer not null check(page_index>=0),
 version_id uuid not null, storage_prefix text not null unique,
 state text not null default 'reserved' check(state in ('reserved','emitted','retired')),
 claim_token uuid, writer_until timestamptz not null default clock_timestamp()+interval '3 minutes',
 job_id bigint, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.drawing_split_pages enable row level security;
revoke all on public.drawing_split_pages from public,anon,authenticated;
grant all on public.drawing_split_pages to service_role;
create unique index drawing_split_live_page on public.drawing_split_pages(org_id,revision_id,source_hash,page_index) where state<>'retired';
create index drawing_split_orphans on public.drawing_split_pages(org_id,revision_id);
create index drawing_split_writer_expiry on public.drawing_split_pages(writer_until);
create trigger drawing_worker_split_fence before insert or update on public.drawing_split_pages for each row execute function public.fence_drawing_worker_write();

create function public.reserve_drawing_split_page(p_org_id uuid,p_revision_id uuid,p_source_hash text,p_page_index integer,p_version_id uuid)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare s public.drawing_split_pages%rowtype; g uuid:=gen_random_uuid();
 token uuid:=nullif(coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-drawing-claim-token','')::uuid;
begin
 perform 1 from public.drawing_revisions where id=p_revision_id and org_id=p_org_id for key share;
 if not found then raise exception 'Drawing revision no longer exists'; end if;
 perform 1 from public.drawing_sheet_versions where id=p_version_id and org_id=p_org_id and drawing_revision_id=p_revision_id for key share;
 if not found then raise exception 'Drawing version missing'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_revision_id::text||p_source_hash||p_page_index::text,0));
 select * into s from public.drawing_split_pages where org_id=p_org_id and revision_id=p_revision_id and source_hash=p_source_hash and page_index=p_page_index and state<>'retired' for update;
 if found then
  if s.state='emitted' then return to_jsonb(s); end if;
  if s.claim_token is not distinct from token and s.writer_until>clock_timestamp() then
   update public.drawing_split_pages set writer_until=clock_timestamp()+interval '3 minutes',updated_at=clock_timestamp() where id=s.id returning * into s;
   return to_jsonb(s);
  end if;
  update public.drawing_split_pages set state='retired',updated_at=clock_timestamp() where id=s.id;
 end if;
 insert into public.drawing_split_pages(org_id,revision_id,source_hash,page_index,version_id,storage_prefix,claim_token)
 values(p_org_id,p_revision_id,p_source_hash,p_page_index,p_version_id,p_org_id::text||'/split/'||g::text,token) returning * into s;
 return to_jsonb(s);
end $$;
create function public.emit_drawing_split_page(p_org_id uuid,p_intent_id uuid,p_payload jsonb)
returns bigint language plpgsql set search_path=public,pg_catalog as $$
declare s public.drawing_split_pages%rowtype; j bigint;
 token uuid:=nullif(coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-drawing-claim-token','')::uuid;
begin
 select * into s from public.drawing_split_pages where id=p_intent_id and org_id=p_org_id for update;
 if not found then raise exception 'Split intent missing'; end if;
 if s.state='emitted' then return s.job_id; end if;
 if s.state<>'reserved' or s.writer_until<=clock_timestamp() or s.claim_token is distinct from token then raise exception 'Split writer expired'; end if;
 perform 1 from public.drawing_revisions where id=s.revision_id and org_id=p_org_id for key share;
 if not found then raise exception 'Drawing revision no longer exists'; end if;
 if p_payload->>'draftRevisionId' is distinct from s.revision_id::text
  or p_payload->>'versionId' is distinct from s.version_id::text
  or (p_payload->>'pagePdfPath' is not null and p_payload->>'pagePdfPath' is distinct from s.storage_prefix||'/page.pdf')
  or (p_payload->>'pageIndex')::integer is distinct from s.page_index
 then raise exception 'Split intent payload mismatch'; end if;
 insert into public.outbox(org_id,job_type,payload,run_at) values(p_org_id,'process_drawing_page',p_payload,clock_timestamp()) returning id into j;
 update public.drawing_split_pages set state='emitted',job_id=j,updated_at=clock_timestamp(),writer_until=clock_timestamp() where id=s.id;
 return j;
end $$;
revoke all on function public.reserve_drawing_split_page(uuid,uuid,text,integer,uuid),public.emit_drawing_split_page(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_drawing_split_page(uuid,uuid,text,integer,uuid),public.emit_drawing_split_page(uuid,uuid,jsonb) to service_role;

alter table public.drawing_artifacts add column last_cleanup_at timestamptz;
alter table public.drawing_split_pages add column last_cleanup_at timestamptz;
create function public.drawing_storage_cleanup_candidates(p_org_id uuid default null,p_limit integer default 100)
returns table(kind text,id uuid,org_id uuid,storage_prefix text,generation uuid)
language sql set search_path=public,pg_catalog as $$
 select kind,id,org_id,storage_prefix,generation from (
 select 'artifact'::text as kind,a.id,a.org_id,a.storage_prefix,a.generation,coalesce(a.last_cleanup_at,a.created_at) as checked_at from public.drawing_artifacts a
 where (p_org_id is null or a.org_id=p_org_id) and a.writer_until<=clock_timestamp()
 and (a.last_cleanup_at is null or a.last_cleanup_at<clock_timestamp()-interval '1 hour')
 and not exists(select 1 from public.drawing_sheet_versions v where v.org_id=a.org_id and v.artifact_id=a.id)
 union all
 select 'split'::text,s.id,s.org_id,s.storage_prefix,s.id,coalesce(s.last_cleanup_at,s.created_at) from public.drawing_split_pages s
 where (p_org_id is null or s.org_id=p_org_id) and s.writer_until<=clock_timestamp()
 and (s.last_cleanup_at is null or s.last_cleanup_at<clock_timestamp()-interval '1 hour')
 and (s.state='retired' or not exists(select 1 from public.drawing_revisions r where r.id=s.revision_id and r.org_id=s.org_id)
  or (s.state='emitted' and exists(select 1 from public.outbox o where o.id=s.job_id and o.status='completed')))
 ) candidates order by checked_at,id limit greatest(1,least(p_limit,500))
$$;
create function public.retire_drawing_split_page(p_org_id uuid,p_intent_id uuid)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare s public.drawing_split_pages%rowtype;
begin
 select * into s from public.drawing_split_pages where id=p_intent_id and org_id=p_org_id for update;
 if not found then return jsonb_build_object('retired',false,'state','missing'); end if;
 if s.writer_until>clock_timestamp() then return jsonb_build_object('retired',false,'state','writing'); end if;
 if s.state<>'retired' and exists(select 1 from public.drawing_revisions where id=s.revision_id and org_id=p_org_id)
 and not (s.state='emitted' and exists(select 1 from public.outbox where id=s.job_id and status='completed'))
 then return jsonb_build_object('retired',false,'state','referenced'); end if;
 -- Preserve emitted receipt: a coordinator retry must not recreate its job.
 if s.state='reserved' then update public.drawing_split_pages set state='retired',updated_at=clock_timestamp() where id=s.id; end if;
 return jsonb_build_object('retired',true,'state','deleting','storage_prefix',s.storage_prefix,'generation',s.id);
end $$;
create function public.complete_drawing_split_deletion(p_org_id uuid,p_intent_id uuid,p_generation uuid)
returns boolean language plpgsql set search_path=public,pg_catalog as $$
begin
 update public.drawing_split_pages set last_cleanup_at=clock_timestamp() where id=p_intent_id and org_id=p_org_id and id=p_generation;
 return found;
end $$;
create or replace function public.complete_drawing_artifact_deletion(p_org_id uuid,p_artifact_id uuid,p_generation uuid)
returns boolean language plpgsql set search_path=public,pg_catalog as $$
begin
 update public.drawing_artifacts set state='deleted',last_cleanup_at=clock_timestamp()
 where id=p_artifact_id and org_id=p_org_id and generation=p_generation and state in ('deleting','deleted');
 return found;
end $$;
revoke all on function public.drawing_storage_cleanup_candidates(uuid,integer),public.retire_drawing_split_page(uuid,uuid),public.complete_drawing_split_deletion(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.drawing_storage_cleanup_candidates(uuid,integer),public.retire_drawing_split_page(uuid,uuid),public.complete_drawing_split_deletion(uuid,uuid,uuid) to service_role;

create or replace function public.claim_drawing_jobs(job_types text[], limit_value integer default 3)
returns table(job_id bigint, org_id uuid, job_type text, payload jsonb, retry_count integer, claim_token uuid)
language plpgsql set search_path = public, pg_catalog as $$
begin
  if limit_value < 1 or limit_value > 6 then raise exception 'Invalid drawing claim limit'; end if;
  if exists (select 1 from unnest(job_types) t where t not in
    ('cleanup_drawing_storage','process_drawing_set','split_drawing_chunk','process_drawing_page','enrich_drawing_metadata',
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

