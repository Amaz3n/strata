-- The destructive pending script calls this gate immediately before its DROP.
-- No campaign or approval is manufactured by this migration.
create function public.assert_accounting_d2_ready()
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare c accounting_d2_campaigns%rowtype; v_day date; v_now timestamptz:=clock_timestamp(); v_today date:=(clock_timestamp() at time zone 'UTC')::date; v_bad bigint; v_samples bigint; v_good bigint; v_parity jsonb; v_table text; v_missing bigint; v_approval jsonb;
begin
  select * into c from accounting_d2_campaigns where status='active' for update;
  if not found then raise exception 'HOLD D2: no active approved acceptance campaign'; end if;
  v_approval:=c.release_evidence->'drop_approval';
  if v_approval is null or v_approval->>'candidate_sha' is distinct from c.candidate_sha
    or nullif(v_approval->>'reviewed_by','') is null or nullif(v_approval->>'approved_at','') is null
    or not exists(select 1 from app_users where id::text=v_approval->>'reviewed_by')
    or (v_approval->>'approved_at')::timestamptz<c.started_at
    or (v_approval->>'approved_at')::timestamptz>v_now then
    raise exception 'HOLD D2: explicit final drop approval for this candidate is missing';
  end if;
  if c.schema_fingerprint is distinct from accounting_d2_schema_fingerprint() then raise exception 'HOLD D2: schema changed since acceptance started'; end if;
  if not(c.release_evidence @> jsonb_build_object('candidate_sha',c.candidate_sha,'runtime_consumers',0,'drop_rehearsal_passed',true,'repairs_verified',true,'artifact_inventory_complete',true,'archive_verified',true)) then raise exception 'HOLD D2: release or archive evidence is incomplete'; end if;
  if c.started_at>(v_today-14)::timestamp at time zone 'UTC' then raise exception 'HOLD D2: fourteen complete UTC acceptance days have not elapsed'; end if;
  for v_day in select generate_series(v_today-14,v_today-1,'1 day'::interval)::date loop
    select count(*),count(*) filter(where s.passed and s.candidate_sha=c.candidate_sha and s.checker_version=c.checker_version and s.schema_fingerprint=c.schema_fingerprint and s.evidence @> '{"complete":true,"scope":"global","blockers":[]}'::jsonb and jsonb_array_length(s.evidence->'blockers')=0)
      into v_samples,v_good from accounting_d2_acceptance_samples s where s.campaign_id=c.id and (s.checked_at at time zone 'UTC')::date=v_day;
    if v_samples=0 or v_samples<>v_good then raise exception 'HOLD D2: acceptance date % has missing, failed, or incompatible evidence',v_day; end if;
  end loop;
  if exists(select 1 from accounting_d2_acceptance_samples s where s.campaign_id=c.id and s.checked_at>=(v_today::timestamp at time zone 'UTC') and (not s.passed or s.candidate_sha<>c.candidate_sha or s.schema_fingerprint<>c.schema_fingerprint or s.checker_version<>c.checker_version or s.evidence->>'complete' is distinct from 'true' or s.evidence->>'scope' is distinct from 'global' or s.evidence->'blockers' is distinct from '[]'::jsonb)) then raise exception 'HOLD D2: today has failed or incompatible acceptance evidence'; end if;
  if not exists(select 1 from accounting_d2_acceptance_samples s where s.campaign_id=c.id and s.passed and s.checked_at between v_now-interval '30 minutes' and v_now and s.candidate_sha=c.candidate_sha and s.schema_fingerprint=c.schema_fingerprint and s.checker_version=c.checker_version and s.evidence @> '{"complete":true,"scope":"global","blockers":[]}'::jsonb) then raise exception 'HOLD D2: refresh measured acceptance evidence on the deployed candidate'; end if;
  select count(*) into v_bad from information_schema.columns where table_schema='public' and table_name in ('invoices','project_expenses','vendor_bills','projects','companies') and column_name like 'qbo_%';
  if v_bad<>38 then raise exception 'HOLD D2: legacy column inventory changed'; end if;
  v_parity:=accounting_d2_parity_snapshot();
  if v_parity->>'complete' is distinct from 'true' or v_parity->>'scope' is distinct from 'global' or (v_parity->>'divergent_records')::bigint<>0 then raise exception 'HOLD D2: current global parity failed'; end if;
  if not exists(select 1 from accounting_connections a where a.id=c.expected_connection_id and a.org_id=c.expected_org_id and a.provider='qbo' and a.external_account_id=c.expected_realm_id and a.external_account_name=c.expected_company_name and a.status='active' and a.refresh_failure_count=0 and a.last_error is null and a.token_expires_at>v_now and a.refresh_token_expires_at>v_now and a.last_inbound_poll_at>v_now-interval '45 minutes') then raise exception 'HOLD D2: expected QBO identity or health changed'; end if;
  if exists(select 1 from accounting_d2_decisions where status in ('unreviewed','rejected') or (status='approved' and disposition='repair')) then raise exception 'HOLD D2: unresolved accounting dispositions'; end if;
  if exists(select 1 from accounting_connections a where a.status<>'active' and not accounting_d2_disposition_matches(a.org_id,a.id,'accounting_connection',a.id::text,to_jsonb(a))) then raise exception 'HOLD D2: inactive routing artifacts are undispositioned'; end if;
  if exists(select 1 from accounting_sync_records s where (s.status in ('error','needs_review','conflict') or (s.status in ('pending','processing') and s.updated_at<v_now-interval '30 minutes')) and not accounting_d2_disposition_matches(s.org_id,s.connection_id,s.entity_type,s.entity_id::text,to_jsonb(s))) then raise exception 'HOLD D2: actionable sync backlog'; end if;
  if exists(select 1 from outbox o where (o.job_type like 'accounting_%' or o.job_type like 'qbo_sync_%') and (o.status='failed' or (o.status in ('pending','processing') and o.run_at<v_now-interval '30 minutes')) and not accounting_d2_source_disposition_matches('outbox',o.id::text,to_jsonb(o))) then raise exception 'HOLD D2: actionable outbox backlog'; end if;
  if exists(select 1 from qbo_webhook_events w where (w.process_status='error' or (w.process_status in ('pending','processing','retry') and coalesce(w.next_attempt_at,w.received_at)<v_now-interval '45 minutes')) and not accounting_d2_source_disposition_matches('inbound',w.id::text,to_jsonb(w))) then raise exception 'HOLD D2: actionable inbound backlog'; end if;
  if exists(select 1 from (values ('accounting-process-outbox',30),('accounting-process-inbound',45),('accounting-process-changes',45),('accounting-reconciliation',1560)) required(name,minutes) where not exists(select 1 from job_runs j where j.job_name=required.name and j.status='success' and j.finished_at>v_now-make_interval(mins=>required.minutes)) or exists(select 1 from job_runs j where j.job_name=required.name and j.status<>'success' and j.started_at>v_now-interval '1 day')) then raise exception 'HOLD D2: accounting cron evidence is stale or failed'; end if;
  if to_regclass('public.accounting_d2_legacy_archive') is null then raise exception 'HOLD D2: legacy archive is missing'; end if;
  foreach v_table in array array['invoices','project_expenses','vendor_bills','projects','companies'] loop
    execute format($q$select count(*) from public.%I r cross join lateral(select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) payload from jsonb_each(to_jsonb(r)) where key like 'qbo_%%' and value<>'null'::jsonb) legacy where legacy.payload<>'{}'::jsonb and not exists(select 1 from public.accounting_d2_legacy_archive a where a.org_id=r.org_id and a.entity_id=r.id and a.source_table=%L and a.legacy_data=legacy.payload)$q$,v_table,v_table) into v_missing;
    if v_missing>0 then raise exception 'HOLD D2: % legacy payloads are not archived exactly',v_table; end if;
  end loop;
  return c.id;
end $$;
revoke all on function public.assert_accounting_d2_ready() from public,anon,authenticated;
grant execute on function public.assert_accounting_d2_ready() to service_role;
