-- Additive, service-only release evidence. No campaign is activated by this migration.
set lock_timeout = '5s';
set statement_timeout = '120s';
create table public.accounting_d2_campaigns (
  id uuid primary key default gen_random_uuid(),
  candidate_sha text not null check (candidate_sha ~ '^[a-f0-9]{40}$'),
  schema_fingerprint text not null,
  checker_version text not null check (checker_version = 'accounting-d2-v1'),
  parity_version text not null check (parity_version = 'legacy-present-neutral-equivalence-v1'),
  expected_org_id uuid not null references public.orgs(id) on delete restrict,
  expected_connection_id uuid not null references public.accounting_connections(id) on delete restrict,
  expected_realm_id text not null,
  expected_company_name text not null,
  release_evidence jsonb not null check (jsonb_typeof(release_evidence) = 'object'),
  approved_by uuid not null references public.app_users(id) on delete restrict,
  approved_at timestamptz not null default now(),
  started_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'held', 'retired')),
  created_at timestamptz not null default now(),
  check (started_at >= created_at and approved_at <= started_at)
);
create unique index accounting_d2_one_active_campaign on public.accounting_d2_campaigns ((true)) where status = 'active';
create index accounting_d2_campaign_org_idx on public.accounting_d2_campaigns(expected_org_id);
create index accounting_d2_campaign_connection_idx on public.accounting_d2_campaigns(expected_connection_id);
create table public.accounting_d2_decisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete restrict,
  connection_id uuid references public.accounting_connections(id) on delete restrict,
  entity_type text not null,
  entity_id text not null,
  before_state jsonb not null check (jsonb_typeof(before_state) = 'object' and (before_state ? 'updated_at' or before_state ? 'last_updated')),
  proposed_action text not null,
  expected_after_state jsonb not null,
  source_preconditions jsonb not null default '[]'::jsonb check (jsonb_typeof(source_preconditions) = 'array'),
  status text not null default 'unreviewed' check (status in ('unreviewed', 'approved', 'applied', 'rejected')),
  disposition text check (disposition in ('repair', 'preserve_history', 'test_exclusion', 'equivalent_reference')),
  rationale text,
  reviewed_by uuid references public.app_users(id) on delete restrict,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status not in ('approved','applied') or (reviewed_by is not null and reviewed_at is not null and length(trim(rationale)) > 0 and disposition is not null))
);
create trigger accounting_d2_decisions_updated_at before update on public.accounting_d2_decisions
  for each row execute function public.tg_set_updated_at();
create index accounting_d2_decision_scope_idx on public.accounting_d2_decisions(org_id, connection_id, entity_type, entity_id);
create index accounting_d2_decision_connection_idx on public.accounting_d2_decisions(connection_id);
create table public.accounting_d2_acceptance_samples (
  id bigint generated always as identity primary key,
  campaign_id uuid not null references public.accounting_d2_campaigns(id) on delete restrict,
  checked_at timestamptz not null default clock_timestamp(),
  candidate_sha text not null,
  schema_fingerprint text not null,
  checker_version text not null,
  passed boolean not null,
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object')
);
create index accounting_d2_sample_campaign_time_idx on public.accounting_d2_acceptance_samples(campaign_id, checked_at desc);
alter table public.accounting_d2_campaigns enable row level security;
alter table public.accounting_d2_decisions enable row level security;
alter table public.accounting_d2_acceptance_samples enable row level security;
revoke all on public.accounting_d2_campaigns, public.accounting_d2_decisions, public.accounting_d2_acceptance_samples from public, anon, authenticated, service_role;
grant select, insert, update on public.accounting_d2_campaigns, public.accounting_d2_decisions to service_role;
grant select on public.accounting_d2_acceptance_samples to service_role;
-- Samples are inserted only by the collector, with database time and measured facts.

create function public.accounting_d2_schema_fingerprint() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select md5(coalesce(string_agg(table_name || '.' || column_name || ':' || data_type, ',' order by table_name, ordinal_position), '') ||
    coalesce((select string_agg(pg_get_functiondef(p.oid), E'\n' order by p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind in ('f','p')), '') ||
    coalesce((select string_agg(pg_get_triggerdef(t.oid), E'\n' order by t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal), ''))
  from information_schema.columns
  where table_schema = 'public' and (table_name in ('invoices','project_expenses','vendor_bills','projects','companies','outbox','qbo_webhook_events') or table_name like 'accounting_%');
$$;
create function public.accounting_d2_disposition_matches(p_org uuid, p_connection uuid, p_type text, p_id text, p_current jsonb) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.accounting_d2_decisions d where d.org_id = p_org
    and d.connection_id is not distinct from p_connection and d.entity_type = p_type and d.entity_id = p_id
    and d.status in ('approved','applied') and d.disposition in ('preserve_history','test_exclusion','equivalent_reference')
    and d.before_state <@ p_current);
$$;

create function public.accounting_d2_source_disposition_matches(p_type text, p_id text, p_current jsonb) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists(select 1 from public.accounting_d2_decisions d cross join lateral jsonb_array_elements(d.source_preconditions) s
    where d.status in ('approved','applied') and d.disposition in ('preserve_history','test_exclusion')
      and s->>'kind'=p_type and s->>'id'=p_id
      and jsonb_typeof(s->'before_state')='object'
      and ((s->'before_state') ? 'updated_at' or (s->'before_state') ? 'last_updated')
      and (s->'before_state') <@ p_current);
$$;
revoke all on function public.accounting_d2_source_disposition_matches(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.accounting_d2_source_disposition_matches(text,text,jsonb) to service_role;

-- Global exact aggregate scans; to_jsonb avoids dependencies on the drop-set columns.
-- Legacy NULL with a valid neutral value is not divergence. Only retained legacy
-- identity/coding meaning must resolve, with reviewed exact-before-value exceptions.
create function public.accounting_d2_parity_snapshot() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  t text; e text; r jsonb; c jsonb; v text; n text; k text; conn uuid; matched bigint;
  checked bigint := 0; divergent bigint := 0; fields bigint := 0; tables jsonb := '{}'::jsonb; table_count bigint; keys text[];
begin
  foreach t in array array['invoices','project_expenses','vendor_bills','projects','companies'] loop
    table_count := 0;
    e := case t when 'invoices' then 'invoice' when 'vendor_bills' then 'bill' when 'project_expenses' then 'project_expense' when 'projects' then 'project' else 'company' end;
    for r in execute format('select to_jsonb(r) from public.%I r', t) loop
      checked := checked + 1; table_count := table_count + 1; fields := 0; c := coalesce(r->'accounting_coding','{}'::jsonb); conn := null; matched := 0;
      if t = 'vendor_bills' then e := case when r#>>'{metadata,source}' = 'vendor_credit' then 'vendor_credit' else 'bill' end; end if;
      if e in ('invoice','bill','vendor_credit','project_expense') then
        select count(*), (array_agg(s.connection_id))[1] into matched, conn from public.accounting_sync_records s
        where s.org_id = (r->>'org_id')::uuid and s.entity_type = e and s.entity_id = (r->>'id')::uuid and s.provider = 'qbo'
          and (nullif(r->>'qbo_id','') is null or s.external_id = r->>'qbo_id');
        if matched > 1 or (nullif(r->>'qbo_id','') is not null and matched <> 1) then fields := fields + 1; end if;
      end if;
      if public.accounting_d2_disposition_matches((r->>'org_id')::uuid, conn, e, r->>'id', r) then continue; end if;
      keys := case when e = 'project' then array['class','customer'] when e = 'company' then array['vendor'] when e = 'invoice' then array[]::text[] else array['expense_account','payment_account','ap_account','vendor','class','transaction_type'] end;
      foreach k in array keys loop
        v := nullif(r->>(case when k = 'transaction_type' then 'qbo_transaction_type' else 'qbo_' || k || '_id' end),'');
        if v is null then continue; end if;
        n := case k when 'vendor' then c#>>'{counterparty,id}' when 'class' then c#>>'{dimensions,class,id}' when 'transaction_type' then c->>'transaction_type' else c#>>array[k,'id'] end;
        if e = 'project' then
          -- A legacy cache has no connection namespace. Multiple books must all
          -- agree, or an explicit reviewed historical disposition is required.
          select case when count(*) > 0 and bool_and((m.dimensions#>>array[k,'id']) is not distinct from v) then v end into n from public.accounting_entity_map m join public.accounting_connections ac on ac.id = m.connection_id and ac.org_id = m.org_id
          where m.org_id = (r->>'org_id')::uuid and m.project_id = (r->>'id')::uuid and ac.provider = 'qbo';
        elsif k = 'vendor' and (n is null or e = 'company') then
          select case when count(*) > 0 and bool_and(l.external_id is not distinct from v) then v end into n from public.accounting_counterparty_links l where l.org_id = (r->>'org_id')::uuid and l.provider = 'qbo' and l.role = 'vendor' and l.entity_type = 'company'
            and l.entity_id = coalesce(nullif(r->>'company_id',''), nullif(r->>'vendor_company_id',''), nullif(r->>'vendor_id',''), case when e = 'company' then r->>'id' end)::uuid
            and (e = 'company' or l.connection_id = conn);
        end if;
        if n is distinct from v then fields := fields + 1; end if;
      end loop;
      if fields > 0 then divergent := divergent + 1; fields := 0; end if;
    end loop;
    tables := tables || jsonb_build_object(t,table_count);
  end loop;
  return jsonb_build_object('complete',true,'scope','global','checked_rows',checked,'checked_tables',tables,'divergent_records',divergent,'parity_version','legacy-present-neutral-equivalence-v1');
end;
$$;

-- This conservative census catches PL/pgSQL record fields and unqualified reads,
-- which pg_depend does not track. One retained tax-readiness cache uses the old
-- spelling as an output column, after reading canonical counterparty links.
-- Its exact definition passed the real 38-column drop rehearsal. Any edit loses
-- this exception and requires a new reviewed rehearsal; routine names alone
-- never exempt a business consumer.
create function public.accounting_d2_sql_legacy_dependencies() returns bigint
language sql stable security definer set search_path = public, pg_temp as $classifier$
  select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prokind in ('f','p')
    and p.proname not like 'accounting_d2_%' and p.proname <> 'capture_accounting_d2_acceptance'
    and pg_get_functiondef(p.oid) ~ '\m(qbo_id|qbo_expense_account_id|qbo_expense_account_name|qbo_payment_account_id|qbo_payment_account_name|qbo_ap_account_id|qbo_ap_account_name|qbo_vendor_id|qbo_vendor_name|qbo_class_id|qbo_class_name|qbo_customer_id|qbo_customer_name|qbo_sync_status|qbo_synced_at|qbo_sync_error|qbo_transaction_type|qbo_vendor_synced_at|qbo_vendor_sync_status)\M'
    and not (p.oid='public.refresh_vendor_tax_readiness(uuid,integer)'::regprocedure
      and md5(pg_get_functiondef(p.oid))='65001d828401d218509fb6ceb5082634');
$classifier$;
revoke all on function public.accounting_d2_sql_legacy_dependencies() from public, anon, authenticated;
grant execute on function public.accounting_d2_sql_legacy_dependencies() to service_role;

create function public.capture_accounting_d2_acceptance(p_deployed_sha text, p_checker_version text, p_reconciliation_complete boolean)
returns table(sample_id bigint, passed boolean)
language plpgsql security definer set search_path = public, pg_temp as $$
declare campaign public.accounting_d2_campaigns%rowtype; parity jsonb; metrics jsonb; blockers jsonb; schema_hash text;
  issue_count bigint; inactive_count bigint; unresolved bigint; cron_bad bigint; health_bad bigint; sql_dependencies bigint; legacy_columns bigint;
  sample bigint; ok boolean;
begin
  for campaign in select * from public.accounting_d2_campaigns where status = 'active' loop
    blockers := '[]'::jsonb; metrics := '{}'::jsonb;
    if p_reconciliation_complete is distinct from true then blockers := blockers || '"nightly_reconciliation_incomplete"'::jsonb; end if;
    begin
      schema_hash := public.accounting_d2_schema_fingerprint();
      parity := public.accounting_d2_parity_snapshot();
      select count(*) into legacy_columns from information_schema.columns where table_schema='public' and table_name in ('invoices','project_expenses','vendor_bills','projects','companies') and column_name like 'qbo_%';
      if legacy_columns <> 38 then blockers := blockers || '"legacy_column_inventory_changed"'::jsonb; end if;
      if p_deployed_sha is distinct from campaign.candidate_sha then blockers := blockers || '"deployment_sha_mismatch"'::jsonb; end if;
      if schema_hash is distinct from campaign.schema_fingerprint then blockers := blockers || '"schema_fingerprint_mismatch"'::jsonb; end if;
      if p_checker_version is distinct from campaign.checker_version then blockers := blockers || '"checker_version_mismatch"'::jsonb; end if;
      if (parity->>'divergent_records')::bigint <> 0 then blockers := blockers || '"legacy_neutral_divergence"'::jsonb; end if;
      if not (campaign.release_evidence @> jsonb_build_object('candidate_sha',campaign.candidate_sha,'runtime_consumers',0,'drop_rehearsal_passed',true,'repairs_verified',true,'artifact_inventory_complete',true)) then blockers := blockers || '"release_prerequisites_unverified"'::jsonb; end if;
      select count(*) into unresolved from public.accounting_d2_decisions where status in ('unreviewed','rejected') or (status = 'approved' and disposition = 'repair');
      if unresolved > 0 then blockers := blockers || '"unresolved_decisions"'::jsonb; end if;
      select count(*) into health_bad from public.accounting_connections c where c.id = campaign.expected_connection_id and c.org_id = campaign.expected_org_id and c.provider = 'qbo'
        and c.external_account_id = campaign.expected_realm_id and c.external_account_name = campaign.expected_company_name
        and c.status = 'active' and c.refresh_failure_count = 0 and c.last_error is null
        and c.token_expires_at > now() and c.refresh_token_expires_at > now()
        and c.last_inbound_poll_at > now() - interval '45 minutes';
      if health_bad <> 1 then blockers := blockers || '"expected_connection_identity_or_health"'::jsonb; end if;
      select count(*) into cron_bad from (values ('accounting-process-outbox',30),('accounting-process-inbound',45),('accounting-process-changes',45),('accounting-reconciliation',1560)) required(name,minutes)
      where not exists(select 1 from public.job_runs j where j.job_name = required.name and j.status = 'success' and j.finished_at > now() - make_interval(mins => required.minutes))
        or exists(select 1 from public.job_runs j where j.job_name = required.name and j.status <> 'success' and j.started_at > now() - interval '1 day');
      if cron_bad > 0 then blockers := blockers || '"cron_failure_or_stale"'::jsonb; end if;
      select count(*) into inactive_count from public.accounting_connections c where c.status <> 'active'
        and not public.accounting_d2_disposition_matches(c.org_id,c.id,'accounting_connection',c.id::text,to_jsonb(c));
      if inactive_count > 0 then blockers := blockers || '"inactive_artifacts_undispositioned"'::jsonb; end if;
      select count(*) into issue_count from public.accounting_sync_records s where (s.status in ('error','needs_review','conflict') or (s.status in ('pending','processing') and s.updated_at < now() - interval '30 minutes'))
        and not public.accounting_d2_disposition_matches(s.org_id,s.connection_id,s.entity_type,s.entity_id::text,to_jsonb(s));
      metrics := metrics || jsonb_build_object('actionable_sync_records',issue_count);
      if issue_count > 0 then blockers := blockers || '"actionable_sync_records"'::jsonb; end if;
      select count(*) into issue_count from public.outbox o where (o.job_type like 'accounting_%' or o.job_type like 'qbo_sync_%')
        and (o.status = 'failed' or (o.status in ('pending','processing') and o.run_at < now() - interval '30 minutes'))
        and not public.accounting_d2_source_disposition_matches('outbox',o.id::text,to_jsonb(o));
      metrics := metrics || jsonb_build_object('actionable_outbox_jobs',issue_count);
      if issue_count > 0 then blockers := blockers || '"actionable_outbox_jobs"'::jsonb; end if;
      select count(*) into issue_count from public.qbo_webhook_events w where (w.process_status = 'error' or (w.process_status in ('pending','processing') and coalesce(w.next_attempt_at,w.received_at) < now() - interval '45 minutes'))
        and not public.accounting_d2_source_disposition_matches('inbound',w.id::text,to_jsonb(w));
      metrics := metrics || jsonb_build_object('actionable_inbound_events',issue_count);
      if issue_count > 0 then blockers := blockers || '"actionable_inbound_events"'::jsonb; end if;
      select public.accounting_d2_sql_legacy_dependencies() into sql_dependencies;
      if sql_dependencies > 0 then blockers := blockers || '"sql_legacy_dependencies"'::jsonb; end if;
      metrics := metrics || jsonb_build_object('complete',true,'scope','global','parity',parity,'legacy_columns',legacy_columns,'unresolved_decisions',unresolved,'inactive_artifacts',inactive_count,'unhealthy_crons',cron_bad,'sql_dependencies',sql_dependencies,'expected_connection_healthy',health_bad = 1,'release_evidence',campaign.release_evidence);
    exception when others then
      -- Preserve a failed day; never store SQL message text that could contain customer data.
      blockers := blockers || '"collector_error"'::jsonb;
      metrics := jsonb_build_object('complete',false,'scope','global','error_code',sqlstate);
    end;
    ok := jsonb_array_length(blockers) = 0;
    insert into public.accounting_d2_acceptance_samples(campaign_id,candidate_sha,schema_fingerprint,checker_version,passed,evidence)
    values(campaign.id,p_deployed_sha,coalesce(schema_hash,'unknown'),p_checker_version,ok,metrics || jsonb_build_object('blockers',blockers)) returning id into sample;
    sample_id := sample; passed := ok; return next;
  end loop;
end;
$$;
revoke all on function public.accounting_d2_schema_fingerprint(), public.accounting_d2_disposition_matches(uuid,uuid,text,text,jsonb), public.accounting_d2_parity_snapshot(), public.capture_accounting_d2_acceptance(text,text,boolean) from public, anon, authenticated;
grant execute on function public.accounting_d2_schema_fingerprint(), public.accounting_d2_disposition_matches(uuid,uuid,text,text,jsonb), public.accounting_d2_parity_snapshot(), public.capture_accounting_d2_acceptance(text,text,boolean) to service_role;
