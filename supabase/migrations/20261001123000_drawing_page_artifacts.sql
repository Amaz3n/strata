-- Immutable generations are shared by adoption and garbage collection.
create table public.drawing_artifacts (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.orgs(id),
 fingerprint text not null, recipe text not null, generation uuid not null default gen_random_uuid(),
 storage_prefix text not null unique, state text not null default 'building' check(state in ('building','active','deleting','deleted')),
 writer_until timestamptz not null default clock_timestamp()+interval '10 minutes',
 writer_version_id uuid, created_at timestamptz not null default now()
);
alter table public.drawing_artifacts enable row level security;
alter table public.drawing_sheet_versions add column artifact_id uuid references public.drawing_artifacts(id);
create index drawing_artifact_version_refs on public.drawing_sheet_versions(artifact_id) where artifact_id is not null;
create index drawing_artifact_fingerprints on public.drawing_artifacts(org_id,fingerprint,recipe,state);
create function public.reserve_drawing_artifact(p_org_id uuid,p_version_id uuid,p_fingerprint text,p_recipe text)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare a public.drawing_artifacts%rowtype; v public.drawing_sheet_versions%rowtype; g uuid;
begin
 select * into v from public.drawing_sheet_versions where id=p_version_id and org_id=p_org_id for update;
 if not found then raise exception 'Drawing version missing'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||p_fingerprint||p_recipe,0));
 if v.artifact_id is not null then
  select * into a from public.drawing_artifacts where id=v.artifact_id and org_id=p_org_id for update;
  if a.state='active' then return to_jsonb(a); end if;
 end if;
 select * into a from public.drawing_artifacts where org_id=p_org_id and fingerprint=p_fingerprint and recipe=p_recipe and state='active' order by created_at limit 1 for update;
 if not found then
  g:=gen_random_uuid();
  insert into public.drawing_artifacts(org_id,fingerprint,recipe,generation,storage_prefix,writer_version_id)
   values(p_org_id,p_fingerprint,p_recipe,g,p_org_id::text||'/artifacts/'||g::text,p_version_id) returning * into a;
 end if;
 update public.drawing_sheet_versions set artifact_id=a.id where id=p_version_id;
 return to_jsonb(a);
end $$;
create function public.activate_drawing_artifact(p_org_id uuid,p_artifact_id uuid,p_version_id uuid)
returns boolean language plpgsql set search_path=public,pg_catalog as $$
begin
 perform 1 from public.drawing_artifacts where id=p_artifact_id and org_id=p_org_id and state='building' and writer_version_id=p_version_id and writer_until>clock_timestamp() for update;
 if not found then raise exception 'Artifact writer expired'; end if;
 perform 1 from public.drawing_sheet_versions where id=p_version_id and org_id=p_org_id and artifact_id=p_artifact_id and tile_manifest is not null and tile_manifest->'Partial' is null;
 if not found then raise exception 'Artifact is incomplete'; end if;
 update public.drawing_artifacts set state='active',writer_until=clock_timestamp() where id=p_artifact_id;
 return true;
end $$;
create function public.retire_drawing_artifact(p_org_id uuid,p_artifact_id uuid)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare a public.drawing_artifacts%rowtype;
begin
 select * into a from public.drawing_artifacts where id=p_artifact_id and org_id=p_org_id for update;
 if not found then return jsonb_build_object('state','missing','retired',false); end if;
 if exists(select 1 from public.drawing_sheet_versions where artifact_id=a.id) then return jsonb_build_object('state','referenced','retired',false); end if;
 if a.writer_until>clock_timestamp() then return jsonb_build_object('state','writing','retired',false,'retry_after',a.writer_until); end if;
 if a.state<>'deleted' then update public.drawing_artifacts set state='deleting' where id=a.id; end if;
 return jsonb_build_object('state',case when a.state='deleted' then 'deleted' else 'deleting' end,'storage_prefix',a.storage_prefix,'generation',a.generation,'retired',true);
end $$;
create function public.complete_drawing_artifact_deletion(p_org_id uuid,p_artifact_id uuid,p_generation uuid)
returns boolean language plpgsql set search_path=public,pg_catalog as $$
begin
 update public.drawing_artifacts set state='deleted' where org_id=p_org_id and id=p_artifact_id and generation=p_generation and state in ('deleting','deleted');
 return found;
end $$;
revoke all on public.drawing_artifacts from anon,authenticated;
grant all on public.drawing_artifacts to service_role;
revoke all on function public.reserve_drawing_artifact(uuid,uuid,text,text),public.activate_drawing_artifact(uuid,uuid,uuid),public.retire_drawing_artifact(uuid,uuid),public.complete_drawing_artifact_deletion(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.reserve_drawing_artifact(uuid,uuid,text,text),public.activate_drawing_artifact(uuid,uuid,uuid),public.retire_drawing_artifact(uuid,uuid),public.complete_drawing_artifact_deletion(uuid,uuid,uuid) to service_role;
