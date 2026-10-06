-- STAGED, UNAPPLIED. Requires starts claim/core migrations. This is narrowly
-- scoped lease control, not release finalization or consumer activation.
create function public.transition_starts_package_lease(p_org_id uuid,p_job_id bigint,p_token uuid,p_action text)
returns boolean language plpgsql set search_path=public,pg_catalog as $$
declare v_job public.outbox%rowtype; v_pkg public.start_packages%rowtype; v_held text; v_held_at timestamptz;
  v_headers text:=current_setting('request.headers',true);
begin
  if current_user in ('anon','authenticated') then raise exception 'Starts lease control requires service role' using errcode='42501'; end if;
  if p_action is null or p_action not in ('acquire','heartbeat','clear') then raise exception 'Invalid package lease transition'; end if;
  -- The lock order matches the write fences: job, then package. Reclaim waits
  -- for this transaction, so identity cannot change between validation/write.
  select * into v_job from public.outbox where id=p_job_id and org_id=p_org_id and job_type='start_release'
    and status='processing' and start_claim_token=p_token and start_job_lease_expires_at>clock_timestamp() for update;
  if not found then return false; end if;
  select * into v_pkg from public.start_packages where org_id=p_org_id and id=(v_job.payload->>'start_package_id')::uuid for update;
  if not found then return false; end if;
  if v_pkg.metadata is not null and jsonb_typeof(v_pkg.metadata)<>'object' then raise exception 'Invalid package metadata' using errcode='22023'; end if;
  v_held:=v_pkg.metadata->>'release_lease_token';
  begin v_held_at:=(v_pkg.metadata->>'release_lease_at')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then v_held_at:=null;
  end;
  if p_action='clear' then
    if v_held is distinct from p_token::text or v_pkg.status is null or v_pkg.status not in ('releasing','released','attention') then return false; end if;
  else
    if v_pkg.status is distinct from 'releasing' then return false; end if;
    if p_action='heartbeat' then
      if v_held is distinct from p_token::text or v_held_at is null or v_held_at<=clock_timestamp()-interval '5 minutes' then return false; end if;
    elsif v_held is not null and v_held is distinct from p_token::text and v_held_at>clock_timestamp()-interval '5 minutes' then return false;
    end if;
  end if;
  -- Only after validating and locking ownership, narrowly suppress worker
  -- headers for this lease-only control write. Preserve and restore them in
  -- this transaction; never change shared client or session authorization.
  perform set_config('request.headers','{}',true);
  update public.start_packages set metadata=coalesce(metadata,'{}')||case when p_action='clear'
    then jsonb_build_object('release_lease_token',null,'release_lease_at',null)
    else jsonb_build_object('release_lease_token',p_token::text,'release_lease_at',clock_timestamp()) end
    where id=v_pkg.id and org_id=p_org_id;
  perform set_config('request.headers',coalesce(v_headers,''),true);
  return true;
end $$;
revoke all on function public.transition_starts_package_lease(uuid,bigint,uuid,text) from public,anon,authenticated;
grant execute on function public.transition_starts_package_lease(uuid,bigint,uuid,text) to service_role;
