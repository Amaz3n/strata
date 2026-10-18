-- Rollout: install this migration BEFORE the new CDC/recovery worker. New RPCs
-- are mandatory; unavailable RPCs fail closed. Previous app versions must not
-- restore authenticated writes. Old CDC rollback is intentionally unavailable:
-- the two-argument cursor routine below cannot bypass validated scoped progress.
-- No financial rows, credentials, compatibility relations or Q02/Q03 grants change.
set lock_timeout = '5s';
set statement_timeout = '120s';

create table public.qbo_cdc_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  connection_id uuid not null references public.accounting_connections(id) on delete cascade,
  realm_id text not null,
  original_boundary text,
  expected_cursor text,
  changed_since timestamptz not null,
  checkpoint timestamptz not null,
  first_checkpoint timestamptz not null,
  first_changed_since timestamptz not null,
  reasons text[] not null default '{}',
  status text not null default 'open' check (status in ('open','complete')),
  progress jsonb not null default '{}',
  combined_attempted boolean not null default false,
  next_entity integer not null default 0 check (next_entity between 0 and 6),
  mapped_after uuid,
  mapped_done boolean not null default false,
  mapped_failure_count integer not null default 0,
  recovery_phase text not null default 'enumeration' check(recovery_phase in ('enumeration','mapped')),
  mapped_failures jsonb not null default '[]',
  version integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(id,org_id,connection_id,realm_id)
);
create unique index qbo_cdc_runs_open_idx on public.qbo_cdc_runs(connection_id) where status='open';
create table public.qbo_cdc_candidates (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  org_id uuid not null,
  connection_id uuid not null,
  realm_id text not null,
  entity_name text not null check(entity_name in ('Invoice','Payment','Purchase','Bill','BillPayment','VendorCredit','JournalEntry')),
  external_id text not null,
  revision text not null check(revision ~ '^[a-f0-9]{64}$'),
  import_types text[] not null,
  document_number text,
  transaction_date text,
  last_updated text,
  review_status text not null default 'pending' check(review_status='pending'),
  created_at timestamptz not null default now(),
  foreign key(run_id,org_id,connection_id,realm_id) references public.qbo_cdc_runs(id,org_id,connection_id,realm_id),
  unique(org_id,connection_id,realm_id,entity_name,external_id,revision)
);
create index qbo_cdc_candidates_list_idx on public.qbo_cdc_candidates(org_id,connection_id,id);
create table public.qbo_cdc_receipts (
  run_id uuid not null references public.qbo_cdc_runs(id) on delete cascade,
  receipt_id uuid not null,
  lease_token uuid not null,
  command_hash text not null,
  result jsonb not null,
  primary key(run_id,receipt_id)
);
-- These contain company-wide facts. Human candidate reads go through the
-- authorized server service; membership-only SELECT would leak unassigned facts.
alter table public.qbo_cdc_runs enable row level security;
alter table public.qbo_cdc_candidates enable row level security;
alter table public.qbo_cdc_receipts enable row level security;
revoke all on public.qbo_cdc_runs,public.qbo_cdc_candidates,public.qbo_cdc_receipts from public,anon,authenticated;
grant all on public.qbo_cdc_runs,public.qbo_cdc_candidates,public.qbo_cdc_receipts to service_role;

create function public.qbo_cdc_timestamp_or_null(p_value text) returns timestamptz
language plpgsql stable set search_path=public as $$
begin
  if p_value is null or p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' then return null; end if;
  return p_value::timestamptz;
exception when others then return null; end $$;

create function public.qbo_recovery_entity_name(p_type text,p_metadata jsonb) returns text
language sql immutable set search_path=public as $$
  select coalesce(nullif(p_metadata->>'external_entity_type',''),
    case when p_metadata->>'source' in ('journal_entry','client_deposit') then 'JournalEntry'
    else case p_type when 'invoice' then 'Invoice' when 'payment' then 'Payment'
      when 'project_expense' then 'Purchase' when 'purchase' then 'Purchase'
      when 'bill' then 'Bill' when 'bill_payment' then 'BillPayment'
      when 'vendor_credit' then 'VendorCredit' when 'journal_entry' then 'JournalEntry' end end)
$$;

create function public.claim_qbo_cdc_run(p_org_id uuid,p_connection_id uuid,p_realm_id text,
  p_original_boundary text,p_changed_since timestamptz,p_checkpoint timestamptz,p_reasons text[])
returns jsonb language plpgsql security definer set search_path=public as $$
declare c public.accounting_connections; r public.qbo_cdc_runs; token uuid := gen_random_uuid();
begin
  select * into c from public.accounting_connections where id=p_connection_id and org_id=p_org_id
    and provider='qbo' and external_account_id=p_realm_id and status='active' for update;
  if not found then raise exception 'Invalid CDC company scope'; end if;
  if p_checkpoint is null or p_changed_since is null or p_realm_id is null or p_realm_id !~ '^[^[:space:]:[:cntrl:]]{1,255}$' or length(p_original_boundary)>1024 or array_position(p_reasons,null) is not null or p_checkpoint > clock_timestamp()+interval '1 second' or p_changed_since>p_checkpoint
    or p_changed_since<clock_timestamp()-interval '30 days' or p_reasons is null
    or not(p_reasons <@ array['lost_window','invalid_cursor','future_cursor']) then raise exception 'Invalid CDC boundary'; end if;
  select * into r from public.qbo_cdc_runs where connection_id=c.id and status='open' for update;
  if found and r.realm_id<>p_realm_id then raise exception 'CDC company identity changed'; end if;
  if found and r.lease_until>clock_timestamp() then return null; end if;
  if r.id is null then
    insert into public.qbo_cdc_runs(org_id,connection_id,realm_id,original_boundary,expected_cursor,changed_since,checkpoint,first_checkpoint,first_changed_since,reasons)
    values(p_org_id,c.id,p_realm_id,p_original_boundary,c.settings->>'qbo_cdc_last_synced_at',p_changed_since,p_checkpoint,p_checkpoint,p_changed_since,p_reasons) returning * into r;
  end if;
  r.reasons := array(select distinct unnest(r.reasons||p_reasons));
  if r.changed_since<clock_timestamp()-interval '29 days' then
    r.reasons := array(select distinct unnest(r.reasons||array['recovery_window_expired']));
    r.changed_since := p_changed_since;
    r.combined_attempted := true;
    r.checkpoint := p_checkpoint;
    select coalesce(jsonb_object_agg(key,value||jsonb_build_object('cdc_complete',false,'cdc_attempted',false)),'{}') into r.progress from jsonb_each(r.progress);
  end if;
  if cardinality(r.reasons)>0 and not exists(select 1 from unnest(array['Invoice','Payment','Purchase','Bill','BillPayment','VendorCredit','JournalEntry']) n where coalesce(r.progress->n->>'cdc_attempted','false')<>'true') then
    r.combined_attempted := true;
    r.checkpoint := p_checkpoint;
    r.changed_since := p_changed_since;
    select coalesce(jsonb_object_agg(key,value||jsonb_build_object('cdc_complete',false,'cdc_attempted',false)),'{}') into r.progress from jsonb_each(r.progress);
  end if;
  update public.qbo_cdc_runs set lease_token=token,lease_until=clock_timestamp()+interval '90 seconds',
    reasons=r.reasons,changed_since=r.changed_since,checkpoint=r.checkpoint,progress=r.progress,combined_attempted=r.combined_attempted,updated_at=clock_timestamp()
    where id=r.id returning * into r;
  update public.accounting_connections set settings=coalesce(settings,'{}')||jsonb_build_object('qbo_cdc_recovery',
    jsonb_build_object('run_id',r.id,'original_boundary',r.original_boundary,'checkpoint',r.checkpoint,'first_checkpoint',r.first_checkpoint,'first_changed_since',r.first_changed_since,'reasons',r.reasons,'status',case when cardinality(r.reasons)>0 then 'required' else 'catching_up' end,
      'mapped_failure_count',r.mapped_failure_count,'mapped_failures',r.mapped_failures,
      'mapped_failures_truncated',r.mapped_failure_count>jsonb_array_length(r.mapped_failures)))
    where id=c.id and org_id=p_org_id and external_account_id=p_realm_id;
  return to_jsonb(r);
end $$;

create function public.persist_qbo_cdc_progress(p_org_id uuid,p_connection_id uuid,p_realm_id text,
  p_run_id uuid,p_lease_token uuid,p_expected_version integer,p_receipt_id uuid,p_change jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.qbo_cdc_runs; c public.accounting_connections; receipt public.qbo_cdc_receipts;
  e jsonb; candidate jsonb; entity text; patch jsonb; ids text[]; inserted text[] := '{}';
  queue_key text; hash text; affected integer; result jsonb; all_complete boolean; summary jsonb;
  names text[] := array['Invoice','Payment','Purchase','Bill','BillPayment','VendorCredit','JournalEntry'];
  reasons text[];
begin
  if p_lease_token is null or p_run_id is null or p_receipt_id is null or jsonb_typeof(p_change) is distinct from 'object' then raise exception 'Invalid CDC progress command or owner'; end if;
  hash := encode(sha256(convert_to(p_change::text,'UTF8')),'hex');
  select * into c from public.accounting_connections where id=p_connection_id and org_id=p_org_id
    and provider='qbo' and external_account_id=p_realm_id and status='active' for update;
  if not found then raise exception 'Invalid CDC company scope'; end if;
  select * into r from public.qbo_cdc_runs where id=p_run_id and org_id=p_org_id and connection_id=c.id and realm_id=p_realm_id for update;
  if not found then raise exception 'Invalid CDC run scope'; end if;
  select * into receipt from public.qbo_cdc_receipts where run_id=r.id and receipt_id=p_receipt_id;
  if found then
    if receipt.lease_token is distinct from p_lease_token or receipt.command_hash is distinct from hash then raise exception 'Invalid CDC receipt owner or command'; end if;
    return receipt.result;
  end if;
  if p_expected_version is null or p_expected_version<0 or p_receipt_id is null or r.status<>'open' or r.lease_token is distinct from p_lease_token or r.lease_until<=clock_timestamp()
    or r.version is distinct from p_expected_version then raise exception 'Stale CDC progress fence'; end if;
  if (p_change ? 'release' and jsonb_typeof(p_change->'release') is distinct from 'boolean') or jsonb_typeof(p_change) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_change) k where k not in
    ('events','investigations','candidates','confirmed_missing','completed_entities','combined_attempted','entity','progress','reasons','next_entity','mapped_after','mapped_done','failed_mapping','recovery_phase','release')) then raise exception 'Invalid CDC progress command'; end if;
  if jsonb_typeof(coalesce(p_change->'events','[]')) is distinct from 'array' or jsonb_array_length(coalesce(p_change->'events','[]'))>200
    or jsonb_typeof(coalesce(p_change->'investigations','[]')) is distinct from 'array' or jsonb_array_length(coalesce(p_change->'investigations','[]'))>200
    or jsonb_typeof(coalesce(p_change->'candidates','[]')) is distinct from 'array' or jsonb_array_length(coalesce(p_change->'candidates','[]'))>200 then raise exception 'Invalid CDC intake batch'; end if;
  if jsonb_typeof(coalesce(p_change->'confirmed_missing','[]')) is distinct from 'array' or jsonb_array_length(coalesce(p_change->'confirmed_missing','[]'))>20 then raise exception 'Invalid confirmed missing batch'; end if;
  for e in select value from jsonb_array_elements(coalesce(p_change->'events','[]')) loop
    if e->>'realm_id' is distinct from r.realm_id or not(e->>'entity_name'=any(names)) then raise exception 'Foreign CDC event'; end if;
  end loop;
  hash := encode(sha256(convert_to(p_change::text,'UTF8')),'hex');
  ids := public.intake_qbo_webhook_events(coalesce(p_change->'events','[]'),hash);
  inserted := inserted||ids;
  -- Missing-time CDC evidence is separate from signed intake. Each differing
  -- revision survives a terminal sentinel; it cannot run money reconciliation.
  for e in select value from jsonb_array_elements(coalesce(p_change->'investigations','[]')) loop
    if e->>'realm_id' is distinct from r.realm_id or not(e->>'entity_name'=any(names))
      or coalesce(e->>'entity_qbo_id','') !~ '^[^[:space:]:[:cntrl:]]{1,255}$'
      or e->>'operation' not in ('Update','Delete') or coalesce(e->>'revision','') !~ '^[a-f0-9]{64}$'
      or e->>'event_id' is distinct from r.realm_id||':'||(e->>'entity_name')||':'||(e->>'entity_qbo_id')||':'||(e->>'operation')||':unknown-time:'||(e->>'revision')
      then raise exception 'Invalid CDC investigation'; end if;
    insert into public.qbo_webhook_events(event_id,payload_hash,realm_id,entity_name,entity_qbo_id,operation,last_updated,process_status,process_error)
      values(e->>'event_id',hash,r.realm_id,e->>'entity_name',e->>'entity_qbo_id',e->>'operation',null,'investigation','CDC timestamp unavailable; recovery required')
      on conflict(event_id) do nothing returning qbo_webhook_events.event_id into queue_key;
    if found then inserted := array_append(inserted,queue_key); end if;
  end loop;
  for e in select value from jsonb_array_elements(coalesce(p_change->'confirmed_missing','[]')) loop
    if coalesce(e->>'entity_name','')<>all(names) or not exists(select 1 from public.accounting_sync_records s
      where s.id=(e->>'mapping_id')::uuid and s.org_id=r.org_id and s.connection_id=r.connection_id and s.provider='qbo'
        and s.external_id=e->>'entity_qbo_id' and public.qbo_recovery_entity_name(s.entity_type,s.metadata)=e->>'entity_name') then raise exception 'Invalid confirmed missing identity'; end if;
    queue_key := r.realm_id||':'||(e->>'entity_name')||':'||(e->>'entity_qbo_id')||':Delete:confirmed-missing:'||r.id||':'||(e->>'mapping_id');
    insert into public.qbo_webhook_events(event_id,payload_hash,realm_id,entity_name,entity_qbo_id,operation,process_status)
      values(queue_key,hash,r.realm_id,e->>'entity_name',e->>'entity_qbo_id','Delete','pending')
      on conflict(event_id) do nothing;
    get diagnostics affected=row_count;
    if affected=1 then inserted := array_append(inserted,queue_key); end if;
  end loop;
  if p_change ? 'failed_mapping' then
    e := p_change->'failed_mapping';
    if jsonb_typeof(e) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(e) k where k not in ('mapping_id','entity_name','entity_qbo_id','reason'))
      or e->>'reason' is distinct from 'malformed_read'
      or coalesce(e->>'entity_name','')<>all(names)
      or e->>'mapping_id' is distinct from p_change->>'mapped_after'
      or not exists(select 1 from public.accounting_sync_records s where s.id=(e->>'mapping_id')::uuid
        and s.org_id=r.org_id and s.connection_id=r.connection_id and s.provider='qbo'
        and s.external_id=e->>'entity_qbo_id' and public.qbo_recovery_entity_name(s.entity_type,s.metadata)=e->>'entity_name')
      then raise exception 'Invalid failed recovery mapping'; end if;
    queue_key := r.realm_id||':'||(e->>'entity_name')||':'||(e->>'entity_qbo_id')||':Update:invalid-read:'||r.id||':'||(e->>'mapping_id');
    insert into public.qbo_webhook_events(event_id,payload_hash,realm_id,entity_name,entity_qbo_id,operation,process_status,process_error)
      values(queue_key,hash,r.realm_id,e->>'entity_name',e->>'entity_qbo_id','Update','investigation','Malformed mapped recovery read; identity remains unresolved')
      on conflict(event_id) do nothing;
    get diagnostics affected=row_count;
    if affected=1 then inserted:=array_append(inserted,queue_key); end if;
    r.reasons:=array(select distinct unnest(r.reasons||array['malformed_response']));
    r.mapped_failure_count:=r.mapped_failure_count+1;
    if jsonb_array_length(r.mapped_failures)<10 then r.mapped_failures:=r.mapped_failures||jsonb_build_array(e); end if;
  end if;
  for candidate in select value from jsonb_array_elements(coalesce(p_change->'candidates','[]')) loop
    entity := candidate->>'entity_name';
    if not(entity=any(names)) or coalesce(candidate->>'external_id','') !~ '^[^[:space:]:[:cntrl:]]{1,255}$'
      or coalesce(candidate->>'revision','') !~ '^[a-f0-9]{64}$'
      or length(coalesce(candidate->>'document_number',''))>255 or length(coalesce(candidate->>'transaction_date',''))>10
      or length(coalesce(candidate->>'last_updated',''))>80 then raise exception 'Invalid CDC candidate'; end if;
    -- Existing identities use the reviewed inbound path, never a second import.
    if not exists(select 1 from public.accounting_sync_records s where s.org_id=r.org_id and s.connection_id=r.connection_id
      and s.provider='qbo' and s.external_id=candidate->>'external_id' and public.qbo_recovery_entity_name(s.entity_type,s.metadata)=entity) then
      insert into public.qbo_cdc_candidates(run_id,org_id,connection_id,realm_id,entity_name,external_id,revision,import_types,document_number,transaction_date,last_updated)
      values(r.id,r.org_id,r.connection_id,r.realm_id,entity,candidate->>'external_id',candidate->>'revision',
        case entity when 'Invoice' then array['invoice'] when 'Payment' then array['payment'] when 'Purchase' then array['expense','expense_credit']
          when 'Bill' then array['bill'] when 'BillPayment' then array['bill_payment'] when 'VendorCredit' then array['vendor_credit'] else array['journal_entry','client_deposit'] end,
        candidate->>'document_number',candidate->>'transaction_date',candidate->>'last_updated') on conflict(org_id,connection_id,realm_id,entity_name,external_id,revision) do nothing;
    end if;
  end loop;
  if p_change ? 'combined_attempted' then
    if jsonb_typeof(p_change->'combined_attempted') is distinct from 'boolean' or (r.combined_attempted and p_change->>'combined_attempted'<>'true') then raise exception 'Invalid combined CDC progress'; end if;
    r.combined_attempted := (p_change->>'combined_attempted')::boolean;
  end if;
  reasons := array(select jsonb_array_elements_text(coalesce(p_change->'reasons','[]')));
  if not(reasons <@ array['saturated','ambiguous_timestamp','future_entity_timestamp','contradictory_count','malformed_response',
    'lost_window','invalid_cursor','future_cursor','recovery_window_expired','offset_scan_not_snapshot','historic_unmapped_deletions','unclassified_mapping']) then raise exception 'Invalid CDC recovery reason'; end if;
  r.reasons := array(select distinct unnest(r.reasons||reasons));
  if p_change ? 'completed_entities' then
    if jsonb_typeof(p_change->'completed_entities') is distinct from 'array' then raise exception 'Invalid CDC completion set'; end if;
    for entity in select jsonb_array_elements_text(p_change->'completed_entities') loop
      if coalesce(entity,'')<>all(names) then raise exception 'Invalid CDC completed entity'; end if;
      r.progress := r.progress||jsonb_build_object(entity,coalesce(r.progress->entity,'{}')||jsonb_build_object('cdc_complete',true,'cdc_attempted',true));
    end loop;
  end if;
  entity := p_change->>'entity'; patch := coalesce(p_change->'progress','{}');
  if entity is not null then
    if not(entity=any(names)) or jsonb_typeof(patch) is distinct from 'object' or exists(select 1 from jsonb_object_keys(patch) k where k not in ('cdc_complete','cdc_attempted','enumeration_position','enumeration_done')) then raise exception 'Invalid CDC entity progress'; end if;
    if (patch ? 'cdc_attempted' and jsonb_typeof(patch->'cdc_attempted') is distinct from 'boolean')
      or (patch ? 'cdc_complete' and jsonb_typeof(patch->'cdc_complete') is distinct from 'boolean')
      or (patch ? 'enumeration_done' and jsonb_typeof(patch->'enumeration_done') is distinct from 'boolean')
      or (patch ? 'enumeration_position' and (coalesce(patch->>'enumeration_position','') !~ '^[0-9]+$' or (patch->>'enumeration_position')::bigint<coalesce((r.progress->entity->>'enumeration_position')::bigint,1)))
      or (r.progress->entity->>'cdc_complete'='true' and patch->>'cdc_complete'='false')
      or (r.progress->entity->>'enumeration_done'='true' and patch->>'enumeration_done'='false') then raise exception 'Regressing CDC progress'; end if;
    r.progress := r.progress||jsonb_build_object(entity,coalesce(r.progress->entity,'{}')||patch);
  elsif patch<>'{}'::jsonb then raise exception 'CDC progress needs entity'; end if;
  if p_change ? 'next_entity' then
    if coalesce(p_change->>'next_entity','') !~ '^[0-6]$' then raise exception 'Invalid CDC next entity'; end if;
    r.next_entity := (p_change->>'next_entity')::integer;
  end if;
  if p_change ? 'recovery_phase' then
    if jsonb_typeof(p_change->'recovery_phase') is distinct from 'string' or p_change->>'recovery_phase' not in ('enumeration','mapped') then raise exception 'Invalid recovery phase'; end if;
    r.recovery_phase:=p_change->>'recovery_phase';
  end if;
  if p_change ? 'mapped_after' then
    if jsonb_typeof(p_change->'mapped_after') is distinct from 'string' then raise exception 'Invalid mapped recovery identity'; end if;
    if r.mapped_after is not null and (p_change->>'mapped_after')::uuid<=r.mapped_after then raise exception 'Regressing mapped recovery progress'; end if;
    r.mapped_after := (p_change->>'mapped_after')::uuid;
  end if;
  if p_change ? 'mapped_done' then
    if jsonb_typeof(p_change->'mapped_done') is distinct from 'boolean' or (r.mapped_done and p_change->>'mapped_done'<>'true') then raise exception 'Invalid mapped recovery completion'; end if;
    r.mapped_done := (p_change->>'mapped_done')::boolean;
  end if;
  if not exists(select 1 from unnest(names) n where coalesce(r.progress->n->>'cdc_attempted','false')<>'true') then
    update public.accounting_connections set settings=coalesce(settings,'{}')||jsonb_build_object('qbo_cdc_observation_start',r.checkpoint)
      where id=r.connection_id and org_id=r.org_id and external_account_id=r.realm_id;
  end if;
  all_complete := not exists(select 1 from unnest(names) n where coalesce(r.progress->n->>'cdc_complete','false')<>'true');
  if all_complete then
    -- Historic cursor remains intact when proof of the lost window is unavailable.
    -- A separate current observation allows recovery to keep collecting changes.
    update public.accounting_connections set settings=coalesce(settings,'{}')||jsonb_build_object('qbo_cdc_observed_until',
      greatest(coalesce(case when public.qbo_cdc_timestamp_or_null(settings->>'qbo_cdc_observed_until')<=clock_timestamp() then public.qbo_cdc_timestamp_or_null(settings->>'qbo_cdc_observed_until') end,'-infinity'::timestamptz),r.checkpoint))
      where id=r.connection_id and org_id=r.org_id and external_account_id=r.realm_id;
    if cardinality(r.reasons)=0 and r.mapped_failure_count=0 then
      update public.accounting_connections set settings=coalesce(settings,'{}')||jsonb_build_object('qbo_cdc_last_synced_at',r.checkpoint)
        where id=r.connection_id and org_id=r.org_id and external_account_id=r.realm_id
          and settings->>'qbo_cdc_last_synced_at' is not distinct from r.expected_cursor
          and (r.expected_cursor is null or public.qbo_cdc_timestamp_or_null(r.expected_cursor)<=r.checkpoint);
      get diagnostics affected = row_count;
      -- A newer completion is safe; an unexpected older/different boundary is not.
      if affected=0 and not exists(select 1 from public.accounting_connections where id=r.connection_id and org_id=r.org_id and external_account_id=r.realm_id
        and public.qbo_cdc_timestamp_or_null(settings->>'qbo_cdc_last_synced_at')>=r.checkpoint) then raise exception 'CDC cursor compare-and-swap failed'; end if;
      r.status := 'complete';
    end if;
  end if;
  summary := jsonb_build_object('run_id',r.id,'original_boundary',r.original_boundary,'checkpoint',r.checkpoint,'first_checkpoint',r.first_checkpoint,'first_changed_since',r.first_changed_since,'reasons',r.reasons,
    'status',case when r.status='complete' then 'complete' when cardinality(r.reasons)>0 then 'required' else 'catching_up' end,
    'progress',r.progress,'mapped_done',r.mapped_done,'mapped_failure_count',r.mapped_failure_count,
    'mapped_failures',r.mapped_failures,'mapped_failures_truncated',r.mapped_failure_count>jsonb_array_length(r.mapped_failures));
  update public.accounting_connections set settings=coalesce(settings,'{}')||jsonb_build_object('qbo_cdc_recovery',summary)
    where id=r.connection_id and org_id=r.org_id and external_account_id=r.realm_id;
  update public.qbo_cdc_runs set progress=r.progress,reasons=r.reasons,combined_attempted=r.combined_attempted,next_entity=r.next_entity,mapped_after=r.mapped_after,mapped_done=r.mapped_done,mapped_failure_count=r.mapped_failure_count,mapped_failures=r.mapped_failures,recovery_phase=r.recovery_phase,
    status=r.status,version=version+1,updated_at=clock_timestamp(),lease_until=case when p_change->>'release'='true' or r.status='complete' then null else lease_until end,
    lease_token=case when p_change->>'release'='true' or r.status='complete' then null else lease_token end
    where id=r.id returning * into r;
  result := jsonb_build_object('run',to_jsonb(r),'inserted_ids',inserted,'summary',summary);
  insert into public.qbo_cdc_receipts(run_id,receipt_id,lease_token,command_hash,result) values(r.id,p_receipt_id,p_lease_token,hash,result);
  return result;
end $$;

-- Prior app instances cannot advance past missing proof or overwrite a new run.
create or replace function public.update_qbo_cdc_cursor(p_connection_id uuid,p_cursor timestamptz)
returns void language plpgsql security definer set search_path=public as $$
begin raise exception 'CDC cursor requires scoped validated progress'; end $$;

revoke all on function public.qbo_cdc_timestamp_or_null(text) from public,anon,authenticated;
revoke all on function public.qbo_recovery_entity_name(text,jsonb) from public,anon,authenticated;
revoke all on function public.claim_qbo_cdc_run(uuid,uuid,text,text,timestamptz,timestamptz,text[]) from public,anon,authenticated;
revoke all on function public.persist_qbo_cdc_progress(uuid,uuid,text,uuid,uuid,integer,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.update_qbo_cdc_cursor(uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.qbo_cdc_timestamp_or_null(text),public.qbo_recovery_entity_name(text,jsonb),public.claim_qbo_cdc_run(uuid,uuid,text,text,timestamptz,timestamptz,text[]),
  public.persist_qbo_cdc_progress(uuid,uuid,text,uuid,uuid,integer,uuid,jsonb),public.update_qbo_cdc_cursor(uuid,timestamptz) to service_role;
