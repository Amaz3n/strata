-- EP12 review fixes for the resumable Open-WIP cutover (20261019100000).
--
-- 1. Members cannot forge a commit. import_batches and import_rows are written
--    by the import service (service role); a signed-in member writing them
--    directly through PostgREST could set a batch 'committing' under another
--    operator's id and have the reaper build homes as that operator. A member
--    now edits only a staged batch's mapping and options, and only staged
--    rows; status, claims, counts, actors and receipts are the service's.
--    A resumed batch is also re-checked against its operator's platform access
--    by the service before anything is built.
-- 2. A rollback takes back only the homes the failing attempt built, and only
--    while nothing but the import has touched them. Homes from an earlier
--    attempt (kept by an exhausted or failed batch, and possibly in use) are
--    never deleted. Any row that references a home, its budget, POs, contract
--    or schedule and was not written by the transaction that built the home is
--    activity: the batch then fails with every home kept. A buyer or vendor the
--    import created is removed only when nothing outside its own creation still
--    references it.
-- 3. A home records the lot's real status and delivery date before it was
--    started, and a rollback restores both.
-- 4. A half-built home is cleared only when no lot holds it.
-- 5. An interrupted attempt (a transient error, not a refusal) releases its
--    claim without undoing anything, so the reaper resumes it from its receipts.

-- 1. Member write fences ---------------------------------------------------

create or replace function public.tg_import_batches_member_write_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  -- What a member may change on a batch that is still being prepared.
  v_editable constant text[] := array['column_mapping', 'update_existing', 'source_filename', 'updated_at'];
begin
  if current_user <> 'authenticated' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'INSERT' then
    if new.status not in ('parsing', 'staged') or new.commit_claim_token is not null or new.commit_lease_expires_at is not null
      or new.commit_attempts <> 0 or new.commit_actor_id is not null or new.committed_at is not null
      or coalesce(new.committed_count, 0) <> 0 or new.created_by is distinct from (select auth.uid()) then
      raise exception 'Import batches are staged and committed by the import service' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status not in ('parsing', 'staged', 'discarded')
      or exists (select 1 from public.import_rows r where r.batch_id = old.id and r.status = 'committed') then
      raise exception 'An import batch that committed records is kept' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.status not in ('parsing', 'staged')
    or (to_jsonb(new) - v_editable) is distinct from (to_jsonb(old) - v_editable) then
    raise exception 'Import batch status, counts and commit claims are written by the import service' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists import_batches_member_write_guard on public.import_batches;
create trigger import_batches_member_write_guard before insert or update or delete on public.import_batches
  for each row execute function public.tg_import_batches_member_write_guard();

create or replace function public.tg_import_rows_member_write_guard()
returns trigger language plpgsql set search_path = '' as $$
declare v_batch_status text;
begin
  if current_user <> 'authenticated' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  select status into v_batch_status from public.import_batches
  where id = case when tg_op = 'DELETE' then old.batch_id else new.batch_id end;
  if tg_op = 'DELETE' then
    if old.status = 'committed' or v_batch_status is distinct from 'staged' and v_batch_status is distinct from 'parsing'
      and v_batch_status is distinct from 'discarded' then
      raise exception 'Import rows of a batch past staging are kept' using errcode = '42501';
    end if;
    return old;
  end if;
  -- A receipt is the service's: a member never commits a row or points it at a record.
  if new.status = 'committed' or new.target_entity_type is not null or new.target_entity_id is not null or new.action is not null then
    if tg_op = 'INSERT' or (new.status, new.target_entity_type, new.target_entity_id, new.action)
      is distinct from (old.status, old.target_entity_type, old.target_entity_id, old.action) then
      raise exception 'Import receipts are written by the import service' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'UPDATE' and (new.org_id, new.batch_id) is distinct from (old.org_id, old.batch_id) then
    raise exception 'An import row stays in its batch' using errcode = '42501';
  end if;
  if v_batch_status not in ('parsing', 'staged') and (tg_op = 'INSERT'
    or (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at')) then
    raise exception 'Import rows are edited only while their batch is staged' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists import_rows_member_write_guard on public.import_rows;
create trigger import_rows_member_write_guard before insert or update or delete on public.import_rows
  for each row execute function public.tg_import_rows_member_write_guard();

-- A resumed claim runs as the operator who committed the batch, never as its creator.
create or replace function public.claim_open_wip_commit(
  p_org_id uuid, p_batch_id uuid, p_actor_id uuid, p_allow_failed boolean, p_enqueue boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_batch public.import_batches%rowtype;
  v_token uuid := gen_random_uuid();
  v_committed integer;
  v_job bigint;
  v_actor uuid;
begin
  select * into v_batch from public.import_batches where org_id = p_org_id and id = p_batch_id and importer = 'open_wip' for update;
  if not found then raise exception 'Import batch not found'; end if;
  -- A fresh commit needs an operator; the worker only resumes a lapsed claim that has one.
  if not ((v_batch.status = 'staged' and v_batch.error_count = 0 and p_actor_id is not null)
    or (v_batch.status = 'committing' and (v_batch.commit_lease_expires_at is null or v_batch.commit_lease_expires_at <= clock_timestamp())
      and coalesce(p_actor_id, v_batch.commit_actor_id) is not null)
    or (v_batch.status = 'failed' and p_allow_failed and p_actor_id is not null)) then
    return null;
  end if;
  v_actor := coalesce(p_actor_id, v_batch.commit_actor_id);
  select count(*) into v_committed from public.import_rows where org_id = p_org_id and batch_id = p_batch_id and status = 'committed';
  update public.import_batches set
    status = 'committing', commit_claim_token = v_token, commit_lease_expires_at = clock_timestamp() + public.open_wip_commit_lease(),
    commit_attempts = commit_attempts + 1, commit_actor_id = v_actor,
    report = report || jsonb_build_object('commit_attempts', coalesce(report->'commit_attempts', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'attempt', v_batch.commit_attempts + 1, 'claimed_at', clock_timestamp(), 'from_status', v_batch.status,
      'actor_id', v_actor, 'rows_already_committed', v_committed)))
  where id = p_batch_id;
  if p_enqueue then
    insert into public.outbox(org_id, job_type, payload, run_at)
    values (p_org_id, 'import_open_wip_commit', jsonb_build_object('batch_id', p_batch_id), clock_timestamp() + public.open_wip_commit_lease() + interval '30 seconds')
    returning id into v_job;
  end if;
  return jsonb_build_object('token', v_token, 'attempt', v_batch.commit_attempts + 1, 'jobId', v_job, 'rowsAlreadyCommitted', v_committed, 'actorId', v_actor);
end $$;
revoke all on function public.claim_open_wip_commit(uuid, uuid, uuid, boolean, boolean) from public, anon, authenticated;
grant execute on function public.claim_open_wip_commit(uuid, uuid, uuid, boolean, boolean) to service_role;

-- 2. Activity: rows that reference a record and were not written by the transaction that built it.

-- p_table's rows p_ids were written by the transactions p_own_xids. Returns every
-- table (including p_table itself, for an edited row) holding a row that points
-- at them, or is one of them, from any other transaction.
create or replace function public.open_wip_foreign_activity(p_table regclass, p_ids uuid[], p_own_xids text[])
returns text[] language plpgsql security definer set search_path = '' as $$
declare v_fk record; v_found boolean; v_tables text[] := '{}';
begin
  if coalesce(cardinality(p_ids), 0) = 0 then return v_tables; end if;
  execute format('select exists (select 1 from %s where id = any($1) and xmin::text <> all($2))', p_table) into v_found using p_ids, p_own_xids;
  if v_found then v_tables := v_tables || p_table::text; end if;
  for v_fk in
    select distinct c.conrelid::regclass tbl, a.attname col
    from pg_catalog.pg_constraint c
    join lateral unnest(c.conkey, c.confkey) as k(src, dst) on true
    join pg_catalog.pg_attribute ra on ra.attrelid = c.confrelid and ra.attnum = k.dst and ra.attname = 'id'
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.src
    where c.contype = 'f' and c.confrelid = p_table
  loop
    execute format('select exists (select 1 from %s where %I = any($1) and xmin::text <> all($2))', v_fk.tbl, v_fk.col)
      into v_found using p_ids, p_own_xids;
    if v_found and not v_fk.tbl::text = any(v_tables) then v_tables := v_tables || v_fk.tbl::text; end if;
  end loop;
  return v_tables;
end $$;
revoke all on function public.open_wip_foreign_activity(regclass, uuid[], text[]) from public, anon, authenticated;
grant execute on function public.open_wip_foreign_activity(regclass, uuid[], text[]) to service_role;

-- 3/4. A home records the lot as it really was and which attempt built it.
create or replace function public.commit_open_wip_house(p_org_id uuid, p_batch_id uuid, p_claim_token uuid, p_row_id uuid, p_house jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_batch public.import_batches%rowtype; v_row public.import_rows%rowtype; v_lot public.lots%rowtype;
  v_owner jsonb; v_project uuid; v_budget uuid; v_commitment uuid; v_buyer uuid; v_po jsonb; v_email text;
  v_lot_number text := p_house->>'lot_number';
begin
  v_batch := public.open_wip_commit_fence(p_org_id, p_batch_id, p_claim_token, true);
  select * into v_row from public.import_rows where org_id = p_org_id and batch_id = p_batch_id and id = p_row_id for update;
  if not found then raise exception 'Import row not found'; end if;
  if v_row.status = 'committed' then
    return jsonb_build_object('projectId', v_row.target_entity_id, 'action', 'already_committed');
  end if;
  if v_row.status not in ('valid', 'warning') then raise exception 'Import row % cannot be committed from %', v_row.row_number, v_row.status; end if;

  select * into v_lot from public.lots where org_id = p_org_id and id = (p_house->>'lot_id')::uuid and community_id = (p_house->>'community_id')::uuid for update;
  if not found then raise exception 'Unable to resolve the Open-WIP lot %', v_lot_number; end if;
  if v_lot.project_id is not null then
    select metadata->'wip_cutover' into v_owner from public.projects where org_id = p_org_id and id = v_lot.project_id;
    -- Built for this row by an earlier attempt that wrote no receipt with it: its lot was attached last, so the home is whole. Adopt it.
    if v_owner->>'batch_id' = p_batch_id::text and v_owner->>'row_id' = p_row_id::text then
      update public.import_rows set status = 'committed', target_entity_type = 'open_wip', target_entity_id = v_lot.project_id, action = 'created'
      where id = p_row_id;
      return jsonb_build_object('projectId', v_lot.project_id, 'action', 'adopted');
    end if;
    raise exception 'Lot % already has a project; reconcile it before importing', v_lot_number;
  end if;
  -- An attempt that died before attaching the lot left a home nobody can reach; one any lot holds is published and stays.
  delete from public.projects p where p.org_id = p_org_id
    and p.metadata->'wip_cutover'->>'batch_id' = p_batch_id::text and p.metadata->'wip_cutover'->>'row_id' = p_row_id::text
    and not exists (select 1 from public.lots l where l.org_id = p_org_id and l.project_id = p.id);

  insert into public.projects(org_id, name, status, property_type, division_id, created_by, metadata)
  values (p_org_id, p_house->>'name', 'active', 'production', (p_house->>'division_id')::uuid, v_batch.commit_actor_id,
    jsonb_build_object('imported_open_wip', true, 'wip_cutover', jsonb_build_object(
      'as_of_date', p_house->>'as_of_date', 'batch_id', p_batch_id, 'row_id', p_row_id,
      'claim_token', p_claim_token, 'attempt', v_batch.commit_attempts,
      -- What a rollback puts back on the lot, exactly as it was.
      'lot_before', jsonb_build_object('status', v_lot.status, 'delivered_at', v_lot.delivered_at,
        'house_plan_id', v_lot.house_plan_id, 'house_plan_version_id', v_lot.house_plan_version_id, 'house_plan_elevation_id', v_lot.house_plan_elevation_id))))
  returning id into v_project;

  insert into public.budgets(org_id, project_id, version, status, total_cents, metadata)
  values (p_org_id, v_project, 1, 'approved', (p_house->'budget'->>'total_cents')::integer, jsonb_build_object('imported_open_wip', true, 'as_of_date', p_house->>'as_of_date'))
  returning id into v_budget;
  insert into public.budget_lines(org_id, budget_id, cost_code_id, description, amount_cents, sort_order, metadata)
  select p_org_id, v_budget, line.cost_code_id, line.description, line.amount_cents, line.sort_order, jsonb_build_object('imported_open_wip', true)
  from jsonb_to_recordset(coalesce(p_house->'budget'->'lines', '[]'::jsonb)) as line(cost_code_id uuid, description text, amount_cents integer, sort_order integer);

  for v_po in select value from jsonb_array_elements(coalesce(p_house->'purchase_orders', '[]'::jsonb)) loop
    insert into public.commitments(org_id, project_id, company_id, commitment_type, title, status, total_cents, currency, contract_number, metadata)
    values (p_org_id, v_project, public.open_wip_vendor(p_org_id, p_batch_id, p_row_id, (v_po->>'company_id')::uuid, v_po->>'vendor'),
      'purchase_order', v_po->>'title', 'draft', (v_po->>'remaining_cents')::integer, 'usd', v_po->>'po_number',
      jsonb_build_object('imported_open_wip', true, 'original_cents', (v_po->>'original_cents')::bigint, 'as_of_date', p_house->>'as_of_date'))
    returning id into v_commitment;
    insert into public.commitment_lines(org_id, commitment_id, cost_code_id, description, quantity, unit, unit_cost_cents, metadata)
    values (p_org_id, v_commitment, (v_po->>'cost_code_id')::uuid, v_po->>'description', 1, 'remaining', (v_po->>'remaining_cents')::integer, jsonb_build_object('imported_open_wip', true));
    update public.commitments set status = 'approved' where id = v_commitment;
  end loop;

  insert into public.schedule_items(org_id, project_id, name, item_type, status, start_date, end_date, progress, sort_order, metadata)
  select p_org_id, v_project, item.name, item.item_type, item.status, item.start_date, item.end_date, item.progress, item.sort_order, item.metadata
  from jsonb_to_recordset(coalesce(p_house->'schedule', '[]'::jsonb)) as item(name text, item_type text, status text, start_date date, end_date date, progress integer, sort_order integer, metadata jsonb);

  if jsonb_typeof(p_house->'buyer') = 'object' then
    v_email := nullif(lower(btrim(p_house->'buyer'->>'email')), '');
    if v_email is null then raise exception 'Lot %: a sold home needs a buyer email', v_lot_number; end if;
    perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':contact:' || v_email, 0));
    select id into v_buyer from public.contacts where org_id = p_org_id and lower(btrim(email)) = v_email order by created_at, id limit 1;
    if v_buyer is null then
      insert into public.contacts(org_id, full_name, email, contact_type, metadata)
      values (p_org_id, p_house->'buyer'->>'name', p_house->'buyer'->>'email', 'client',
        jsonb_build_object('imported_open_wip', true, 'open_wip_batch_id', p_batch_id, 'open_wip_row_id', p_row_id))
      returning id into v_buyer;
    end if;
    update public.projects set client_id = v_buyer where id = v_project;
    insert into public.contracts(org_id, project_id, number, title, status, signed_at, contract_type, total_cents, currency, effective_date, snapshot)
    select p_org_id, v_project, c.number, c.title, 'active', c.signed_at, 'purchase_agreement', c.total_cents, 'usd', c.effective_date,
      jsonb_build_object('imported_open_wip', true, 'as_of_date', p_house->>'as_of_date', 'agreement_total_only', true)
    from jsonb_to_record(p_house->'contract') as c(number text, title text, signed_at timestamptz, total_cents integer, effective_date date);
  end if;

  if v_lot.delivered_at is null then
    update public.lots set status = 'developed' where id = v_lot.id;
  end if;
  update public.lots set project_id = v_project, status = 'started',
    house_plan_id = (p_house->>'house_plan_id')::uuid, house_plan_version_id = (p_house->>'house_plan_version_id')::uuid,
    house_plan_elevation_id = (p_house->>'house_plan_elevation_id')::uuid
  where id = v_lot.id;
  update public.import_rows set status = 'committed', target_entity_type = 'open_wip', target_entity_id = v_project, action = 'created'
  where id = p_row_id;
  return jsonb_build_object('projectId', v_project, 'action', 'created');
end $$;
revoke all on function public.commit_open_wip_house(uuid, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.commit_open_wip_house(uuid, uuid, uuid, uuid, jsonb) to service_role;

-- A row the source cannot build fails the batch. Only the homes this attempt
-- built go, and only when nothing but the import has touched them; otherwise
-- every home stays and the batch fails for an operator to resolve and retry.
create or replace function public.rollback_open_wip_commit(p_org_id uuid, p_batch_id uuid, p_claim_token uuid, p_error text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_homes uuid[]; v_xids text[]; v_activity text[] := '{}'; v_home record; v_before jsonb; v_party record;
  v_rolled integer := 0; v_parties integer := 0; v_kept integer; v_result jsonb;
begin
  perform public.open_wip_commit_fence(p_org_id, p_batch_id, p_claim_token, false);
  select coalesce(array_agg(p.id), '{}'), coalesce(array_agg(p.xmin::text), '{}') into v_homes, v_xids
  from public.import_rows r join public.projects p on p.org_id = r.org_id and p.id = r.target_entity_id
  where r.org_id = p_org_id and r.batch_id = p_batch_id and r.status = 'committed'
    and p.metadata->'wip_cutover'->>'batch_id' = p_batch_id::text and p.metadata->'wip_cutover'->>'row_id' = r.id::text
    and p.metadata->'wip_cutover'->>'claim_token' = p_claim_token::text;

  v_activity := public.open_wip_foreign_activity('public.projects'::regclass, v_homes, v_xids)
    || public.open_wip_foreign_activity('public.budgets'::regclass, array(select id from public.budgets where org_id = p_org_id and project_id = any(v_homes)), v_xids)
    || public.open_wip_foreign_activity('public.commitments'::regclass, array(select id from public.commitments where org_id = p_org_id and project_id = any(v_homes)), v_xids)
    || public.open_wip_foreign_activity('public.contracts'::regclass, array(select id from public.contracts where org_id = p_org_id and project_id = any(v_homes)), v_xids)
    || public.open_wip_foreign_activity('public.schedule_items'::regclass, array(select id from public.schedule_items where org_id = p_org_id and project_id = any(v_homes)), v_xids);

  if cardinality(v_activity) = 0 then
    for v_home in select p.id, p.metadata->'wip_cutover'->'lot_before' before from public.projects p where p.id = any(v_homes) loop
      v_before := v_home.before;
      update public.lots set project_id = null, status = coalesce(v_before->>'status', 'developed'),
        delivered_at = case when v_before ? 'delivered_at' then (v_before->>'delivered_at')::timestamptz else delivered_at end,
        house_plan_id = (v_before->>'house_plan_id')::uuid, house_plan_version_id = (v_before->>'house_plan_version_id')::uuid,
        house_plan_elevation_id = (v_before->>'house_plan_elevation_id')::uuid
      where org_id = p_org_id and project_id = v_home.id;
      delete from public.projects where org_id = p_org_id and id = v_home.id;
      v_rolled := v_rolled + 1;
    end loop;
    update public.import_rows set target_entity_type = null, target_entity_id = null, action = null,
      status = case when exists (select 1 from jsonb_array_elements(issues) issue where issue->>'level' = 'warning') then 'warning' else 'valid' end
    where org_id = p_org_id and batch_id = p_batch_id and status = 'committed' and not exists (
      select 1 from public.projects p where p.org_id = p_org_id and p.id = import_rows.target_entity_id);
    -- A party the import created goes only when nothing but its own creation refers to it.
    for v_party in
      select 'public.contacts'::regclass tbl, id, xmin::text x from public.contacts where org_id = p_org_id and metadata->>'open_wip_batch_id' = p_batch_id::text
      union all
      select 'public.companies'::regclass, id, xmin::text from public.companies where org_id = p_org_id and metadata->>'open_wip_batch_id' = p_batch_id::text
    loop
      if cardinality(public.open_wip_foreign_activity(v_party.tbl, array[v_party.id], array[v_party.x])) = 0
        and not exists (select 1 from public.projects where org_id = p_org_id and client_id = v_party.id)
        and not exists (select 1 from public.commitments where org_id = p_org_id and company_id = v_party.id) then
        execute format('delete from %s where id = $1', v_party.tbl) using v_party.id;
        v_parties := v_parties + 1;
      end if;
    end loop;
  end if;

  select count(*) into v_kept from public.import_rows where org_id = p_org_id and batch_id = p_batch_id and status = 'committed';
  v_result := jsonb_build_object('homes', v_rolled, 'parties', v_parties, 'kept_homes', v_kept, 'activity', to_jsonb(v_activity));
  update public.import_batches set status = 'failed', commit_claim_token = null, commit_lease_expires_at = null,
    report = report || jsonb_build_object('rolled_back', v_result, 'commit_error', case
      when cardinality(v_activity) > 0 then p_error || '. Its homes are kept: they are already in use. Resolve the row and commit the batch again.'
      when v_kept > 0 then p_error || '. Homes from earlier attempts are kept with their receipts. Resolve the row and commit the batch again.'
      else p_error end)
  where id = p_batch_id;
  return v_result;
end $$;
revoke all on function public.rollback_open_wip_commit(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.rollback_open_wip_commit(uuid, uuid, uuid, text) to service_role;

-- 5. An attempt interrupted by something other than the source (a lost
-- connection, a timeout) keeps everything it built and lets its claim lapse
-- now, so the reaper resumes it from its receipts. p_fail ends it instead,
-- homes kept, for an operator to commit again (an operator who lost access).
create or replace function public.release_open_wip_commit(p_org_id uuid, p_batch_id uuid, p_claim_token uuid, p_error text, p_fail boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.open_wip_commit_fence(p_org_id, p_batch_id, p_claim_token, false);
  update public.import_batches set
    status = case when p_fail then 'failed' else 'committing' end,
    commit_claim_token = null, commit_lease_expires_at = case when p_fail then null else clock_timestamp() end,
    report = report || case when p_fail then jsonb_build_object('commit_error', p_error)
      else jsonb_build_object('last_interruption', jsonb_build_object('at', clock_timestamp(), 'error', p_error)) end
  where id = p_batch_id;
end $$;
revoke all on function public.release_open_wip_commit(uuid, uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.release_open_wip_commit(uuid, uuid, uuid, text, boolean) to service_role;
