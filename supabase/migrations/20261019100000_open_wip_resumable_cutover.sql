-- EP12-02 / EP12-03: the Open-WIP cutover commits one house per transaction,
-- under a leased claim, with its receipt.
--
-- A house file used to be committed by one request writing each home's rows
-- one statement at a time and saving the row receipts only after every house
-- was built. A crash stranded the homes built so far with no receipt and the
-- batch in 'committing' forever; a failed house left behind the buyer contact
-- and vendor companies it had created. Now:
--
--   claim_open_wip_commit      takes (or resumes, or retries) the batch under a
--                              fresh claim token and a lease, and queues the
--                              outbox job that finishes it if this process dies.
--   commit_open_wip_house      writes one home — project, budget, POs and their
--                              vendors, schedule, buyer, agreement, lot — and the
--                              row's receipt in ONE transaction, fenced by the
--                              claim. A row already committed is returned as is;
--                              a home an earlier attempt built for this row
--                              without a receipt is adopted, never built twice.
--   rollback_open_wip_commit   a house that cannot be built fails the whole
--                              batch: every home it published, and every party
--                              only those homes used, is removed in one
--                              transaction and the rows are committable again.
--   finalize_open_wip_commit   the batch is 'committed' only when every row has
--                              a receipt and each receipt's home, lot, budget
--                              and POs match what the source said; otherwise it
--                              is 'failed' with the mismatches and keeps its homes.
--   reap_stale_open_wip_commits
--                              a batch whose lease lapsed is handed back to the
--                              outbox to resume; after too many interrupted
--                              attempts it is 'failed', keeping its homes and
--                              receipts for an operator retry to adopt.
--
-- The service computes every value a home is built from (names, dates, totals,
-- the schedule); this file only writes them together and checks ownership.

alter table public.import_batches
  add column if not exists commit_claim_token uuid,
  add column if not exists commit_lease_expires_at timestamptz,
  add column if not exists commit_attempts integer not null default 0 check (commit_attempts >= 0),
  add column if not exists commit_actor_id uuid references public.app_users(id) on delete set null;

create index if not exists import_batches_commit_lease_idx
  on public.import_batches (commit_lease_expires_at)
  where status = 'committing';
create index if not exists import_batches_commit_actor_idx
  on public.import_batches (commit_actor_id)
  where commit_actor_id is not null;

-- How long a claim lives without a house being written under it.
create or replace function public.open_wip_commit_lease() returns interval
language sql immutable set search_path = '' as $$ select interval '2 minutes' $$;
revoke all on function public.open_wip_commit_lease() from public, anon, authenticated;
grant execute on function public.open_wip_commit_lease() to service_role;

create or replace function public.claim_open_wip_commit(
  p_org_id uuid, p_batch_id uuid, p_actor_id uuid, p_allow_failed boolean, p_enqueue boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_batch public.import_batches%rowtype;
  v_token uuid := gen_random_uuid();
  v_committed integer;
  v_job bigint;
begin
  select * into v_batch from public.import_batches where org_id = p_org_id and id = p_batch_id and importer = 'open_wip' for update;
  if not found then raise exception 'Import batch not found'; end if;
  -- A fresh commit needs an operator; the worker only resumes a lapsed claim.
  if not ((v_batch.status = 'staged' and v_batch.error_count = 0 and p_actor_id is not null)
    or (v_batch.status = 'committing' and (v_batch.commit_lease_expires_at is null or v_batch.commit_lease_expires_at <= clock_timestamp()))
    or (v_batch.status = 'failed' and p_allow_failed and p_actor_id is not null)) then
    return null;
  end if;
  select count(*) into v_committed from public.import_rows where org_id = p_org_id and batch_id = p_batch_id and status = 'committed';
  update public.import_batches set
    status = 'committing', commit_claim_token = v_token, commit_lease_expires_at = clock_timestamp() + public.open_wip_commit_lease(),
    commit_attempts = commit_attempts + 1, commit_actor_id = coalesce(p_actor_id, commit_actor_id, created_by),
    report = report || jsonb_build_object('commit_attempts', coalesce(report->'commit_attempts', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'attempt', v_batch.commit_attempts + 1, 'claimed_at', clock_timestamp(), 'from_status', v_batch.status,
      'actor_id', coalesce(p_actor_id, v_batch.commit_actor_id, v_batch.created_by), 'rows_already_committed', v_committed)))
  where id = p_batch_id;
  -- The job that finishes the batch if this process dies; it runs only after the lease could have lapsed.
  if p_enqueue then
    insert into public.outbox(org_id, job_type, payload, run_at)
    values (p_org_id, 'import_open_wip_commit', jsonb_build_object('batch_id', p_batch_id), clock_timestamp() + public.open_wip_commit_lease() + interval '30 seconds')
    returning id into v_job;
  end if;
  return jsonb_build_object('token', v_token, 'attempt', v_batch.commit_attempts + 1, 'jobId', v_job, 'rowsAlreadyCommitted', v_committed,
    'actorId', coalesce(p_actor_id, v_batch.commit_actor_id, v_batch.created_by));
end $$;
revoke all on function public.claim_open_wip_commit(uuid, uuid, uuid, boolean, boolean) from public, anon, authenticated;
grant execute on function public.claim_open_wip_commit(uuid, uuid, uuid, boolean, boolean) to service_role;

-- The claim is checked, locked and renewed by every write made under it.
create or replace function public.open_wip_commit_fence(p_org_id uuid, p_batch_id uuid, p_claim_token uuid, p_require_live boolean)
returns public.import_batches language plpgsql security definer set search_path = '' as $$
declare v_batch public.import_batches%rowtype;
begin
  select * into v_batch from public.import_batches where org_id = p_org_id and id = p_batch_id and importer = 'open_wip' for update;
  if not found or v_batch.status <> 'committing' or v_batch.commit_claim_token is distinct from p_claim_token
    or (p_require_live and v_batch.commit_lease_expires_at <= clock_timestamp()) then
    raise exception 'Open-WIP commit claim is no longer owned' using errcode = '55006';
  end if;
  update public.import_batches set commit_lease_expires_at = clock_timestamp() + public.open_wip_commit_lease() where id = p_batch_id;
  return v_batch;
end $$;
revoke all on function public.open_wip_commit_fence(uuid, uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.open_wip_commit_fence(uuid, uuid, uuid, boolean) to service_role;

-- A vendor or buyer is found by name or email inside the org, else created
-- with the row that needed it, so a failed row takes it away with everything else.
create or replace function public.open_wip_vendor(p_org_id uuid, p_batch_id uuid, p_row_id uuid, p_company_id uuid, p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_name text := nullif(btrim(p_name), '');
begin
  if p_company_id is not null then
    select id into v_id from public.companies where org_id = p_org_id and id = p_company_id;
    if not found then raise exception 'Vendor % is not in this organization', coalesce(v_name, p_company_id::text); end if;
    return v_id;
  end if;
  if v_name is null then raise exception 'Vendor is required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':company:' || lower(v_name), 0));
  select id into v_id from public.companies where org_id = p_org_id and lower(btrim(name)) = lower(v_name) order by created_at, id limit 1;
  if v_id is null then
    insert into public.companies(org_id, name, company_type, metadata)
    values (p_org_id, v_name, 'subcontractor', jsonb_build_object('created_by_import_batch', true, 'open_wip_batch_id', p_batch_id, 'open_wip_row_id', p_row_id))
    returning id into v_id;
  end if;
  return v_id;
end $$;
revoke all on function public.open_wip_vendor(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.open_wip_vendor(uuid, uuid, uuid, uuid, text) to service_role;

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
    -- Built for this row by an attempt that wrote no receipt with it (a commit from before receipts were
    -- written with the home): its lot was attached last, so the home is whole. Adopt it.
    if v_owner->>'batch_id' = p_batch_id::text and v_owner->>'row_id' = p_row_id::text then
      update public.import_rows set status = 'committed', target_entity_type = 'open_wip', target_entity_id = v_lot.project_id, action = 'created'
      where id = p_row_id;
      return jsonb_build_object('projectId', v_lot.project_id, 'action', 'adopted');
    end if;
    raise exception 'Lot % already has a project; reconcile it before importing', v_lot_number;
  end if;
  -- The same attempt may have died before attaching the lot: that half-built home was never published.
  delete from public.projects where org_id = p_org_id
    and metadata->'wip_cutover'->>'batch_id' = p_batch_id::text and metadata->'wip_cutover'->>'row_id' = p_row_id::text;

  insert into public.projects(org_id, name, status, property_type, division_id, created_by, metadata)
  values (p_org_id, p_house->>'name', 'active', 'production', (p_house->>'division_id')::uuid, v_batch.commit_actor_id,
    jsonb_build_object('imported_open_wip', true, 'wip_cutover', jsonb_build_object(
      'as_of_date', p_house->>'as_of_date', 'batch_id', p_batch_id, 'row_id', p_row_id,
      -- What a rollback puts back on the lot. A house under construction proves its land was delivered, so that stays.
      'lot_before', jsonb_build_object('status', case when v_lot.delivered_at is null then 'developed' else v_lot.status end,
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
    -- Approved once its line is on it; open WIP, so its issue version is a backfill and no vendor is emailed.
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

create or replace function public.rollback_open_wip_commit(p_org_id uuid, p_batch_id uuid, p_claim_token uuid, p_error text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_receipt record; v_before jsonb; v_party uuid; v_homes integer := 0; v_parties integer := 0;
begin
  perform public.open_wip_commit_fence(p_org_id, p_batch_id, p_claim_token, false);
  for v_receipt in
    select r.id, r.target_entity_id project_id, p.metadata->'wip_cutover'->'lot_before' before
    from public.import_rows r join public.projects p on p.org_id = r.org_id and p.id = r.target_entity_id
    where r.org_id = p_org_id and r.batch_id = p_batch_id and r.status = 'committed'
      and p.metadata->'wip_cutover'->>'batch_id' = p_batch_id::text and p.metadata->'wip_cutover'->>'row_id' = r.id::text
    order by r.row_number desc
  loop
    v_before := v_receipt.before;
    update public.lots set project_id = null, status = coalesce(v_before->>'status', 'developed'),
      house_plan_id = (v_before->>'house_plan_id')::uuid, house_plan_version_id = (v_before->>'house_plan_version_id')::uuid,
      house_plan_elevation_id = (v_before->>'house_plan_elevation_id')::uuid
    where org_id = p_org_id and project_id = v_receipt.project_id;
    delete from public.projects where org_id = p_org_id and id = v_receipt.project_id;
    v_homes := v_homes + 1;
  end loop;
  -- Parties those homes created go with them, unless something else has come to use them.
  for v_party in select id from public.contacts where org_id = p_org_id and metadata->>'open_wip_batch_id' = p_batch_id::text loop
    if not exists (select 1 from public.projects where org_id = p_org_id and client_id = v_party) then
      begin
        delete from public.contacts where id = v_party; v_parties := v_parties + 1;
      exception when foreign_key_violation then null;
      end;
    end if;
  end loop;
  for v_party in select id from public.companies where org_id = p_org_id and metadata->>'open_wip_batch_id' = p_batch_id::text loop
    if not exists (select 1 from public.commitments where org_id = p_org_id and company_id = v_party) then
      begin
        delete from public.companies where id = v_party; v_parties := v_parties + 1;
      exception when foreign_key_violation then null;
      end;
    end if;
  end loop;
  update public.import_rows set target_entity_type = null, target_entity_id = null, action = null,
    status = case when exists (select 1 from jsonb_array_elements(issues) issue where issue->>'level' = 'warning') then 'warning' else 'valid' end
  where org_id = p_org_id and batch_id = p_batch_id and status = 'committed';
  update public.import_batches set status = 'failed', commit_claim_token = null, commit_lease_expires_at = null,
    report = report || jsonb_build_object('commit_error', p_error, 'rolled_back', jsonb_build_object('homes', v_homes, 'parties', v_parties))
  where id = p_batch_id;
  return jsonb_build_object('homes', v_homes, 'parties', v_parties);
end $$;
revoke all on function public.rollback_open_wip_commit(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.rollback_open_wip_commit(uuid, uuid, uuid, text) to service_role;

-- p_expected (house files): one entry per committable row, from the source files:
-- [{row_id, lot_number, budget_cents, budget_lines, purchase_orders, po_cents}].
create or replace function public.finalize_open_wip_commit(p_org_id uuid, p_batch_id uuid, p_claim_token uuid, p_expected jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_batch public.import_batches%rowtype; v_mismatches jsonb := '[]'::jsonb; v_homes integer; v_receipts integer; v_pending integer;
  v_budgets integer; v_orders integer; v_orphans integer; v_saved public.import_batches%rowtype;
begin
  v_batch := public.open_wip_commit_fence(p_org_id, p_batch_id, p_claim_token, true);
  -- A budget or PO file builds nothing itself: it is the source the house file reads, so each row is its own receipt.
  if coalesce(v_batch.context->>'file_kind', '') <> 'houses' then
    update public.import_rows set status = 'committed', target_entity_type = 'open_wip', target_entity_id = id, action = 'created'
    where org_id = p_org_id and batch_id = p_batch_id and status in ('valid', 'warning');
    select count(*) into v_receipts from public.import_rows where org_id = p_org_id and batch_id = p_batch_id and status = 'committed';
    update public.import_batches set status = 'committed', committed_count = v_receipts, committed_at = clock_timestamp(),
      commit_claim_token = null, commit_lease_expires_at = null, report = (report - 'commit_error') || jsonb_build_object('actions', jsonb_build_object('created', v_receipts))
    where id = p_batch_id returning * into v_saved;
    return to_jsonb(v_saved);
  end if;
  select count(*) filter (where status in ('valid', 'warning')), count(*) filter (where status = 'committed')
    into v_pending, v_receipts from public.import_rows where org_id = p_org_id and batch_id = p_batch_id;
  if v_pending > 0 then raise exception 'Open-WIP batch still has % uncommitted rows', v_pending; end if;

  with expected as (
    select e.* from jsonb_to_recordset(p_expected) as e(row_id uuid, lot_number text, budget_cents bigint, budget_lines integer, purchase_orders integer, po_cents bigint)
  ), actual as (
    select r.id row_id, r.target_entity_id project_id,
      (p.metadata->'wip_cutover'->>'batch_id' = p_batch_id::text and p.metadata->'wip_cutover'->>'row_id' = r.id::text) owned,
      exists (select 1 from public.lots l where l.org_id = p_org_id and l.project_id = r.target_entity_id and l.status = 'started') on_lot,
      (select count(*) from public.budgets b where b.org_id = p_org_id and b.project_id = r.target_entity_id and b.status = 'approved') budgets,
      (select coalesce(sum(b.total_cents), 0) from public.budgets b where b.org_id = p_org_id and b.project_id = r.target_entity_id and b.status = 'approved') budget_cents,
      (select count(*) from public.budget_lines bl join public.budgets b on b.id = bl.budget_id where b.org_id = p_org_id and b.project_id = r.target_entity_id) budget_lines,
      (select coalesce(sum(bl.amount_cents), 0) from public.budget_lines bl join public.budgets b on b.id = bl.budget_id where b.org_id = p_org_id and b.project_id = r.target_entity_id) line_cents,
      (select count(*) from public.commitments c where c.org_id = p_org_id and c.project_id = r.target_entity_id and c.commitment_type = 'purchase_order' and c.status = 'approved') purchase_orders,
      (select coalesce(sum(c.total_cents), 0) from public.commitments c where c.org_id = p_org_id and c.project_id = r.target_entity_id and c.commitment_type = 'purchase_order' and c.status = 'approved') po_cents
    from public.import_rows r left join public.projects p on p.org_id = r.org_id and p.id = r.target_entity_id
    where r.org_id = p_org_id and r.batch_id = p_batch_id and r.status = 'committed'
  ), compared as (
    select coalesce(e.lot_number, a.row_id::text) lot, e.row_id is not null expected_row, a.row_id is not null committed_row, a.*,
      e.budget_cents e_budget_cents, e.budget_lines e_budget_lines, e.purchase_orders e_purchase_orders, e.po_cents e_po_cents
    from expected e full join actual a on a.row_id = e.row_id
  )
  select coalesce(jsonb_agg(m order by m->>'lot', m->>'check'), '[]'::jsonb) into v_mismatches from (
    select jsonb_build_object('lot', lot, 'check', 'receipt', 'expected', expected_row, 'actual', committed_row) m from compared where expected_row is distinct from committed_row
    union all select jsonb_build_object('lot', lot, 'check', 'home', 'expected', true, 'actual', coalesce(owned, false) and on_lot) from compared where expected_row and committed_row and not (coalesce(owned, false) and on_lot)
    union all select jsonb_build_object('lot', lot, 'check', 'budget', 'expected', jsonb_build_object('budgets', 1, 'cents', e_budget_cents, 'lines', e_budget_lines),
        'actual', jsonb_build_object('budgets', budgets, 'cents', budget_cents, 'lines', budget_lines))
      from compared where expected_row and committed_row and (budgets <> 1 or budget_cents <> e_budget_cents or line_cents <> e_budget_cents or budget_lines <> e_budget_lines)
    union all select jsonb_build_object('lot', lot, 'check', 'purchase_orders', 'expected', jsonb_build_object('count', e_purchase_orders, 'cents', e_po_cents),
        'actual', jsonb_build_object('count', purchase_orders, 'cents', po_cents))
      from compared where expected_row and committed_row and (purchase_orders <> e_purchase_orders or po_cents <> e_po_cents)
  ) mismatch_rows;

  select count(*) into v_homes from public.projects p where p.org_id = p_org_id and p.metadata->'wip_cutover'->>'batch_id' = p_batch_id::text;
  select count(*) into v_orphans from public.projects p where p.org_id = p_org_id and p.metadata->'wip_cutover'->>'batch_id' = p_batch_id::text
    and not exists (select 1 from public.import_rows r where r.org_id = p_org_id and r.batch_id = p_batch_id and r.status = 'committed' and r.target_entity_id = p.id);
  if v_orphans > 0 then v_mismatches := v_mismatches || jsonb_build_array(jsonb_build_object('lot', null, 'check', 'homes_without_receipt', 'expected', 0, 'actual', v_orphans)); end if;
  select count(*) into v_budgets from public.budgets b join public.import_rows r on r.target_entity_id = b.project_id
    where r.org_id = p_org_id and r.batch_id = p_batch_id and r.status = 'committed' and b.org_id = p_org_id;
  select count(*) into v_orders from public.commitments c join public.import_rows r on r.target_entity_id = c.project_id
    where r.org_id = p_org_id and r.batch_id = p_batch_id and r.status = 'committed' and c.org_id = p_org_id and c.commitment_type = 'purchase_order';

  update public.import_batches set
    status = case when jsonb_array_length(v_mismatches) = 0 then 'committed' else 'failed' end,
    committed_count = case when jsonb_array_length(v_mismatches) = 0 then v_receipts else committed_count end,
    committed_at = case when jsonb_array_length(v_mismatches) = 0 then clock_timestamp() else null end,
    commit_claim_token = null, commit_lease_expires_at = null,
    report = (report - 'commit_error') || jsonb_build_object(
      'actions', jsonb_build_object('created', v_receipts),
      'reconciliation', jsonb_build_object('rows', jsonb_array_length(p_expected), 'receipts', v_receipts, 'homes', v_homes, 'budgets', v_budgets,
        'purchase_orders', v_orders, 'clean', jsonb_array_length(v_mismatches) = 0, 'mismatches', v_mismatches))
      || case when jsonb_array_length(v_mismatches) = 0 then '{}'::jsonb
        else jsonb_build_object('commit_error', 'The imported homes do not reconcile to the source files; the batch keeps its homes and is not complete') end
  where id = p_batch_id returning * into v_saved;
  return to_jsonb(v_saved);
end $$;
revoke all on function public.finalize_open_wip_commit(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.finalize_open_wip_commit(uuid, uuid, uuid, jsonb) to service_role;

-- Run before the outbox claims work. A lapsed claim gets a job to resume it: the
-- pending one is pulled forward, a running one is left alone, none is queued.
create or replace function public.reap_stale_open_wip_commits(p_max_attempts integer)
returns table(resumed bigint, exhausted bigint) language plpgsql security definer set search_path = '' as $$
declare v_batch record; v_resumed bigint := 0; v_exhausted bigint := 0;
begin
  if p_max_attempts is null or p_max_attempts < 1 then raise exception 'Open-WIP commit attempts must be at least 1'; end if;
  for v_batch in
    select id, org_id, commit_attempts from public.import_batches
    where importer = 'open_wip' and status = 'committing' and (commit_lease_expires_at is null or commit_lease_expires_at <= clock_timestamp())
    order by commit_lease_expires_at nulls first limit 100 for update skip locked
  loop
    if v_batch.commit_attempts >= p_max_attempts then
      update public.import_batches set status = 'failed', commit_claim_token = null, commit_lease_expires_at = null,
        report = report || jsonb_build_object('commit_error', format('The commit was interrupted %s times; its homes are kept with their receipts. Commit the batch again to resume.', v_batch.commit_attempts))
      where id = v_batch.id;
      v_exhausted := v_exhausted + 1;
      continue;
    end if;
    update public.outbox set run_at = least(run_at, now()), updated_at = now()
    where org_id = v_batch.org_id and job_type = 'import_open_wip_commit' and status = 'pending' and payload->>'batch_id' = v_batch.id::text;
    if not found and not exists (select 1 from public.outbox where org_id = v_batch.org_id and job_type = 'import_open_wip_commit'
      and status = 'processing' and payload->>'batch_id' = v_batch.id::text) then
      insert into public.outbox(org_id, job_type, payload) values (v_batch.org_id, 'import_open_wip_commit', jsonb_build_object('batch_id', v_batch.id));
    end if;
    v_resumed := v_resumed + 1;
  end loop;
  resumed := v_resumed; exhausted := v_exhausted;
  return next;
end $$;
revoke all on function public.reap_stale_open_wip_commits(integer) from public, anon, authenticated;
grant execute on function public.reap_stale_open_wip_commits(integer) to service_role;
