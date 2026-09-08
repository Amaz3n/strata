-- Provider-neutral replacements derived from the production definitions captured 2026-09-08.
-- Financial guards, grants (CREATE OR REPLACE), and trigger signatures are preserved.
set lock_timeout = '5s';
set statement_timeout = '120s';

CREATE OR REPLACE FUNCTION public.approve_vendor_bills_atomic(p_org_id uuid, p_actor_id uuid, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_requested integer;
  v_locked integer;
  v_now timestamptz := now();
  v_bill record;
  v_require_waiver boolean;
begin
  if jsonb_typeof(p_items) <> 'array' then raise exception 'Approval items must be an array'; end if;
  v_requested := jsonb_array_length(p_items);
  if v_requested < 1 or v_requested > 500 then raise exception 'Bulk approval requires between 1 and 500 bills'; end if;
  if (select count(distinct item->>'id') from jsonb_array_elements(p_items) item) <> v_requested then raise exception 'Bulk approval contains duplicate bills'; end if;

  select coalesce((compliance_rules->>'require_lien_waiver')::boolean, false)
    into v_require_waiver from public.orgs where id = p_org_id;

  perform b.id from public.vendor_bills b
  join jsonb_array_elements(p_items) item on item->>'id' = b.id::text
  where b.org_id = p_org_id order by b.id for update;
  get diagnostics v_locked = row_count;
  if v_locked <> v_requested then raise exception 'One or more payables no longer exist'; end if;

  for v_bill in
    select b.*, item->>'expected_updated_at' as expected_updated_at
    from public.vendor_bills b
    join jsonb_array_elements(p_items) item on item->>'id' = b.id::text
    where b.org_id = p_org_id order by b.id
  loop
    if v_bill.status = 'rejected' then raise exception 'Payable % was rejected; reopen it before approving', coalesce(v_bill.bill_number, v_bill.id::text); end if;
    if v_bill.status <> 'pending' then raise exception 'Payable % is no longer pending', coalesce(v_bill.bill_number, v_bill.id::text); end if;
    if v_bill.expected_updated_at is not null and v_bill.updated_at <> v_bill.expected_updated_at::timestamptz then
      raise exception 'Payable % changed since it was selected', coalesce(v_bill.bill_number, v_bill.id::text);
    end if;
    if coalesce(v_bill.metadata->>'source', '') = 'vendor_credit' then raise exception 'Vendor credits cannot be approved for payment'; end if;
    if not exists (select 1 from public.bill_lines l where l.org_id = p_org_id and l.bill_id = v_bill.id) then raise exception 'Payable % has no coding lines', coalesce(v_bill.bill_number, v_bill.id::text); end if;
    if exists (
      select 1 from public.bill_lines l
      left join public.project_financial_settings s on s.org_id = p_org_id and s.project_id = coalesce(l.project_id, v_bill.project_id)
      left join public.org_settings os on os.org_id = p_org_id
      where l.org_id = p_org_id and l.bill_id = v_bill.id
        and coalesce(s.cost_codes_enabled, nullif(os.settings->>'cost_codes_enabled', '')::boolean, true)
        and l.cost_code_id is null
    ) then raise exception 'Payable % is missing required cost-code coding', coalesce(v_bill.bill_number, v_bill.id::text); end if;
    if (select coalesce(sum(round(coalesce(l.quantity, 1) * coalesce(l.unit_cost_cents, 0))), 0) from public.bill_lines l where l.org_id = p_org_id and l.bill_id = v_bill.id) <> coalesce(v_bill.total_cents, 0) then
      raise exception 'Payable % coding does not equal its total', coalesce(v_bill.bill_number, v_bill.id::text);
    end if;
  end loop;

  update public.vendor_bills b
  set status = 'approved', approved_at = coalesce(b.approved_at, v_now), approved_by = p_actor_id,
      -- Mirrors updateVendorBillStatus exactly: a waiver already received is
      -- never downgraded to requested, and an org that does not require waivers
      -- gets an explicit 'not_required' rather than a silent NULL.
      lien_waiver_status = case
        when v_require_waiver and coalesce(b.lien_waiver_status, '') <> 'received' then 'requested'
        when not v_require_waiver and b.lien_waiver_status is null then 'not_required'
        else b.lien_waiver_status
      end,
      lien_waiver_received_at = case
        when v_require_waiver and coalesce(b.lien_waiver_status, '') <> 'received' then null
        when not v_require_waiver and b.lien_waiver_status is null then null
        else b.lien_waiver_received_at
      end
  from jsonb_array_elements(p_items) item
  where b.org_id = p_org_id and b.id::text = item->>'id';

  update public.accounting_sync_records s
  set status = 'pending', error_message = null, updated_at = v_now
  where s.org_id = p_org_id and s.entity_type = 'bill' and s.status = 'synced'
    and exists (select 1 from jsonb_array_elements(p_items) item where item->>'id' = s.entity_id::text);

  insert into public.audit_log (org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
  select p_org_id, p_actor_id, 'update', 'vendor_bill', b.id, jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'approved', 'bulk', true, 'lien_waiver_status', b.lien_waiver_status), 'bulk_payables_approval'
  from public.vendor_bills b join jsonb_array_elements(p_items) item on item->>'id' = b.id::text where b.org_id = p_org_id;

  -- No `insert into public.events` here. `approveVendorBillsAtomic` raises
  -- `vendor_bill_approved` per approved bill once the transaction returns, with
  -- the submitter, project, vendor and amount the single-bill path carries — the
  -- payload the notification router needs to reach the person who submitted it.

  insert into public.outbox (org_id, job_type, payload, dedupe_key, priority)
  select p_org_id, 'project_vendor_bill_approval', jsonb_build_object('bill_id', b.id), 'vendor-bill-approval:' || b.id::text, 80
  from public.vendor_bills b join jsonb_array_elements(p_items) item on item->>'id' = b.id::text where b.org_id = p_org_id
  on conflict (org_id, dedupe_key) where status = 'pending' and dedupe_key is not null do update
    set status = 'pending', run_at = now(), last_error = null, updated_at = now(), priority = greatest(public.outbox.priority, excluded.priority);

  return jsonb_build_object('approved_count', v_requested, 'approved_at', v_now);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.create_receivable_adjustment_atomic(p_org_id uuid, p_invoice_id uuid, p_adjustment_type text, p_amount_cents integer, p_tax_cents integer, p_effective_date date, p_reason text, p_actor_id uuid, p_idempotency_key text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_invoice public.invoices%rowtype;
  v_adjustment public.receivable_adjustments%rowtype;
  v_open_cents integer;
  v_prior_tax_cents integer;
begin
  if p_adjustment_type not in ('credit_memo', 'write_off') then
    raise exception 'Unsupported receivable adjustment type';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Adjustment amount must be positive';
  end if;
  if coalesce(p_tax_cents, 0) < 0 or coalesce(p_tax_cents, 0) > p_amount_cents then
    raise exception 'Adjustment tax amount is invalid';
  end if;
  if p_adjustment_type = 'write_off' and coalesce(p_tax_cents, 0) <> 0 then
    raise exception 'A write-off cannot reverse sales tax';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'Adjustment reason is required';
  end if;

  if p_idempotency_key is not null then
    select * into v_adjustment
    from public.receivable_adjustments
    where org_id = p_org_id and idempotency_key = p_idempotency_key;
    if v_adjustment.id is not null then return to_jsonb(v_adjustment); end if;
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id and org_id = p_org_id
  for update;
  if v_invoice.id is null then raise exception 'Invoice not found'; end if;
  if v_invoice.status in ('draft', 'saved', 'void') or v_invoice.client_visible is not true then
    raise exception 'Only an issued, active invoice can be adjusted';
  end if;
  if (v_invoice.metadata ->> 'invoice_kind') = 'earnest_deposit' then
    raise exception 'Deposit refunds must use the customer deposit workflow';
  end if;

  select coalesce(sum(tax_cents), 0) into v_prior_tax_cents
  from public.receivable_adjustments
  where org_id = p_org_id and invoice_id = p_invoice_id
    and adjustment_type = 'credit_memo' and status = 'posted';
  if p_adjustment_type = 'credit_memo'
    and v_prior_tax_cents + coalesce(p_tax_cents, 0) > coalesce(v_invoice.tax_cents, 0) then
    raise exception 'Credit memo reverses more sales tax than the invoice charged';
  end if;

  v_open_cents := greatest(coalesce(v_invoice.total_cents, 0) - public.invoice_paid_cents(p_org_id, p_invoice_id), 0);
  if p_amount_cents > v_open_cents then
    raise exception 'Adjustment exceeds the open invoice balance';
  end if;

  insert into public.receivable_adjustments (
    org_id, project_id, invoice_id, adjustment_type, status, amount_cents,
    tax_cents, effective_date, reason, idempotency_key, created_by, metadata
  ) values (
    p_org_id, v_invoice.project_id, p_invoice_id, p_adjustment_type, 'posted',
    p_amount_cents, coalesce(p_tax_cents, 0), coalesce(p_effective_date, current_date),
    trim(p_reason), p_idempotency_key, p_actor_id, coalesce(p_metadata, '{}'::jsonb)
  ) returning * into v_adjustment;

  perform public.recalc_invoice_balance_atomic(p_org_id, p_invoice_id);
  update public.accounting_sync_records
  set status = 'needs_review', status_reason = 'receivable_adjustment', updated_at = now()
  where entity_id = p_invoice_id and org_id = p_org_id and entity_type = 'invoice' and nullif(external_id, '') is not null;
  return to_jsonb(v_adjustment);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.detect_directory_merge_candidates(p_org_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company_count integer := 0;
  v_contact_count integer := 0;
begin
  with company_pairs as (
    select
      a.org_id,
      a.id as primary_company_id,
      b.id as duplicate_company_id,
      case
        when exists (select 1 from public.accounting_counterparty_links la join public.accounting_counterparty_links lb on lb.org_id = la.org_id and lb.connection_id = la.connection_id and lb.role = la.role and lb.external_id = la.external_id where la.org_id = a.org_id and la.entity_type = 'company' and lb.entity_type = 'company' and la.role = 'vendor' and la.entity_id = a.id and lb.entity_id = b.id and nullif(la.external_id, '') is not null) then 0.98
        when lower(coalesce(a.email, '')) <> '' and lower(a.email) = lower(b.email) then 0.92
        else 0.86
      end::numeric(4,3) as confidence,
      array_remove(array[
        case when public.directory_normalize_name(a.name) = public.directory_normalize_name(b.name) then 'same_name' end,
        case when lower(coalesce(a.email, '')) <> '' and lower(a.email) = lower(b.email) then 'same_email' end,
        case when exists (select 1 from public.accounting_counterparty_links la join public.accounting_counterparty_links lb on lb.org_id = la.org_id and lb.connection_id = la.connection_id and lb.role = la.role and lb.external_id = la.external_id where la.org_id = a.org_id and la.entity_type = 'company' and lb.entity_type = 'company' and la.role = 'vendor' and la.entity_id = a.id and lb.entity_id = b.id and nullif(la.external_id, '') is not null) then 'same_accounting_vendor' end
      ], null)::text[] as reason_codes,
      jsonb_build_object(
        'primary_name', a.name,
        'duplicate_name', b.name,
        'primary_email', a.email,
        'duplicate_email', b.email,
        'same_accounting_vendor', exists (select 1 from public.accounting_counterparty_links la join public.accounting_counterparty_links lb on lb.org_id = la.org_id and lb.connection_id = la.connection_id and lb.role = la.role and lb.external_id = la.external_id where la.org_id = a.org_id and la.entity_type = 'company' and lb.entity_type = 'company' and la.role = 'vendor' and la.entity_id = a.id and lb.entity_id = b.id and nullif(la.external_id, '') is not null)
      ) as evidence
    from public.companies a
    join public.companies b
      on b.org_id = a.org_id
      and a.id < b.id
      and b.metadata->>'archived_at' is null
    where (p_org_id is null or a.org_id = p_org_id)
      and a.metadata->>'archived_at' is null
      and (
        public.directory_normalize_name(a.name) = public.directory_normalize_name(b.name)
        or (
          lower(coalesce(a.email, '')) <> ''
          and lower(a.email) = lower(coalesce(b.email, ''))
        )
        or (
          exists (select 1 from public.accounting_counterparty_links la join public.accounting_counterparty_links lb on lb.org_id = la.org_id and lb.connection_id = la.connection_id and lb.role = la.role and lb.external_id = la.external_id where la.org_id = a.org_id and la.entity_type = 'company' and lb.entity_type = 'company' and la.role = 'vendor' and la.entity_id = a.id and lb.entity_id = b.id and nullif(la.external_id, '') is not null)
        )
      )
  ),
  inserted as (
    insert into public.directory_merge_candidates (
      org_id,
      entity_type,
      primary_company_id,
      duplicate_company_id,
      confidence,
      reason_codes,
      evidence
    )
    select
      company_pairs.org_id,
      'company',
      company_pairs.primary_company_id,
      company_pairs.duplicate_company_id,
      company_pairs.confidence,
      company_pairs.reason_codes,
      company_pairs.evidence
    from company_pairs
    on conflict (org_id, primary_company_id, duplicate_company_id)
      where entity_type = 'company' and status = 'open'
    do update
    set
      confidence = excluded.confidence,
      reason_codes = excluded.reason_codes,
      evidence = excluded.evidence,
      detected_at = now(),
      updated_at = now()
    returning 1
  )
  select count(*) into v_company_count from inserted;

  with contact_pairs as (
    select
      a.org_id,
      a.id as primary_contact_id,
      b.id as duplicate_contact_id,
      case
        when lower(coalesce(a.email, '')) <> '' and lower(a.email) = lower(b.email) then 0.96
        else 0.82
      end::numeric(4,3) as confidence,
      array_remove(array[
        case when lower(coalesce(a.email, '')) <> '' and lower(a.email) = lower(b.email) then 'same_email' end,
        case when public.directory_normalize_name(a.full_name) = public.directory_normalize_name(b.full_name) then 'same_name' end,
        case when a.primary_company_id is not null and a.primary_company_id = b.primary_company_id then 'same_company' end
      ], null)::text[] as reason_codes,
      jsonb_build_object(
        'primary_name', a.full_name,
        'duplicate_name', b.full_name,
        'primary_email', a.email,
        'duplicate_email', b.email,
        'primary_company_id', a.primary_company_id,
        'duplicate_company_id', b.primary_company_id
      ) as evidence
    from public.contacts a
    join public.contacts b
      on b.org_id = a.org_id
      and a.id < b.id
      and b.metadata->>'archived_at' is null
    where (p_org_id is null or a.org_id = p_org_id)
      and a.metadata->>'archived_at' is null
      and (
        (
          lower(coalesce(a.email, '')) <> ''
          and lower(a.email) = lower(coalesce(b.email, ''))
        )
        or (
          public.directory_normalize_name(a.full_name) = public.directory_normalize_name(b.full_name)
          and a.primary_company_id is not null
          and a.primary_company_id = b.primary_company_id
        )
      )
  ),
  inserted as (
    insert into public.directory_merge_candidates (
      org_id,
      entity_type,
      primary_contact_id,
      duplicate_contact_id,
      confidence,
      reason_codes,
      evidence
    )
    select
      contact_pairs.org_id,
      'contact',
      contact_pairs.primary_contact_id,
      contact_pairs.duplicate_contact_id,
      contact_pairs.confidence,
      contact_pairs.reason_codes,
      contact_pairs.evidence
    from contact_pairs
    on conflict (org_id, primary_contact_id, duplicate_contact_id)
      where entity_type = 'contact' and status = 'open'
    do update
    set
      confidence = excluded.confidence,
      reason_codes = excluded.reason_codes,
      evidence = excluded.evidence,
      detected_at = now(),
      updated_at = now()
    returning 1
  )
  select count(*) into v_contact_count from inserted;

  return coalesce(v_company_count, 0) + coalesce(v_contact_count, 0);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.prevent_active_payment_run_payable_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_has_active_run boolean;
begin
  select exists (
    select 1
    from public.payment_run_items item
    join public.payment_runs run on run.id = item.run_id and run.org_id = item.org_id
    where item.org_id = old.org_id
      and item.bill_id = old.id
      and item.status in ('draft','pending_approval','approved','processing','partially_paid')
      and run.status in ('draft','pending_approval','approved','processing','partially_paid')
  ) into v_has_active_run;

  if not v_has_active_run then return new; end if;

  if new.org_id is distinct from old.org_id
     or new.project_id is distinct from old.project_id
     or new.commitment_id is distinct from old.commitment_id
     or new.company_id is distinct from old.company_id
     or new.bill_number is distinct from old.bill_number
     or new.bill_date is distinct from old.bill_date
     or new.due_date is distinct from old.due_date
     or new.total_cents is distinct from old.total_cents
     or new.currency is distinct from old.currency
     or new.retainage_percent is distinct from old.retainage_percent
     or new.retainage_cents is distinct from old.retainage_cents
     or new.file_id is distinct from old.file_id
     or new.accounting_coding is distinct from old.accounting_coding
     or (new.status in ('pending','rejected') and new.status is distinct from old.status) then
    raise exception 'This payable belongs to an active payment run; cancel the run before changing the approved obligation';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.prevent_concurrent_vendor_bill_duplicate()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_invoice text := public.normalize_vendor_invoice_number(new.bill_number);
  v_vendor_name text := public.normalize_vendor_name(coalesce(new.metadata ->> 'vendor_name', new.accounting_coding #>> '{counterparty,name}', new.accounting_coding #>> '{vendor,name}'));
begin
  if v_invoice is null or (new.company_id is null and v_vendor_name is null) then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    new.org_id::text || ':' || coalesce(new.company_id::text, v_vendor_name) || ':' || v_invoice, 0
  ));
  if exists (
    select 1
    from public.vendor_bills bill
    where bill.org_id = new.org_id
      and bill.id is distinct from new.id
      and bill.invoice_number_normalized = v_invoice
      and (
        (new.company_id is not null and bill.company_id = new.company_id)
        or (new.company_id is null and bill.company_id is null and bill.vendor_name_normalized = v_vendor_name)
      )
      -- Historic paid duplicates may move through unrelated status maintenance;
      -- a still-unpaid twin remains a hard stop.
      and bill.status <> 'paid'
  ) then
    raise exception 'Duplicate vendor invoice number for this vendor';
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.refresh_vendor_scorecards(p_org_id uuid DEFAULT NULL::uuid, p_period_start date DEFAULT ((CURRENT_DATE - '365 days'::interval))::date, p_period_end date DEFAULT CURRENT_DATE)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_count integer := 0;
begin
  with vendor_companies as (
    select
      companies.id,
      companies.org_id,
      companies.name,
      companies.company_type
    from public.companies
    left join public.directory_relationship_types as relationship_types
      on relationship_types.id = companies.relationship_type_id
    where (p_org_id is null or companies.org_id = p_org_id)
      and companies.metadata->>'archived_at' is null
      and (
        companies.company_type in ('subcontractor', 'supplier')
        or relationship_types.canonical_category = 'vendor'
      )
  ),
  bill_metrics as (
    select
      vendor_bills.org_id,
      vendor_bills.company_id,
      count(*) filter (where vendor_bills.paid_at is not null and vendor_bills.due_date is not null)::integer as paid_bill_count,
      count(*) filter (
        where vendor_bills.paid_at is not null
          and vendor_bills.due_date is not null
          and vendor_bills.paid_at::date <= vendor_bills.due_date
      )::integer as on_time_bill_count,
      count(*) filter (
        where vendor_bills.status in ('rejected', 'disputed')
          or exists (select 1 from public.accounting_sync_records s where s.org_id = vendor_bills.org_id and s.entity_type = 'bill' and s.entity_id = vendor_bills.id and s.status = 'error')
      )::integer as invoice_issue_count,
      coalesce(sum(vendor_bills.total_cents), 0)::bigint as billed_cents,
      coalesce(sum(coalesce(vendor_bills.paid_cents, 0)), 0)::bigint as paid_cents
    from public.vendor_bills
    where vendor_bills.company_id is not null
      and (p_org_id is null or vendor_bills.org_id = p_org_id)
      and coalesce(vendor_bills.bill_date, vendor_bills.created_at::date) between p_period_start and p_period_end
    group by vendor_bills.org_id, vendor_bills.company_id
  ),
  commitment_metrics as (
    select
      commitments.org_id,
      commitments.company_id,
      count(*)::integer as commitment_count,
      coalesce(sum(commitments.total_cents), 0)::bigint as committed_cents
    from public.commitments
    where commitments.company_id is not null
      and (p_org_id is null or commitments.org_id = p_org_id)
      and commitments.created_at::date between p_period_start and p_period_end
    group by commitments.org_id, commitments.company_id
  ),
  change_order_metrics as (
    select
      vendor_companies.org_id,
      vendor_companies.id as company_id,
      count(change_orders.id)::integer as change_order_count
    from vendor_companies
    left join public.change_orders
      on change_orders.org_id = vendor_companies.org_id
      and change_orders.created_at::date between p_period_start and p_period_end
      and (
        change_orders.metadata->>'company_id' = vendor_companies.id::text
        or change_orders.metadata->>'vendor_company_id' = vendor_companies.id::text
        or change_orders.metadata->>'commitment_company_id' = vendor_companies.id::text
      )
    group by vendor_companies.org_id, vendor_companies.id
  ),
  bid_metrics as (
    select
      bid_invites.org_id,
      bid_invites.company_id,
      count(distinct bid_invites.id)::integer as invite_count,
      count(distinct bid_submissions.bid_invite_id)::integer as response_count,
      count(distinct bid_awards.id)::integer as award_count
    from public.bid_invites
    left join public.bid_submissions
      on bid_submissions.org_id = bid_invites.org_id
      and bid_submissions.bid_invite_id = bid_invites.id
    left join public.bid_awards
      on bid_awards.org_id = bid_invites.org_id
      and bid_awards.awarded_submission_id = bid_submissions.id
    where (p_org_id is null or bid_invites.org_id = p_org_id)
      and bid_invites.created_at::date between p_period_start and p_period_end
    group by bid_invites.org_id, bid_invites.company_id
  ),
  daily_log_metrics as (
    select
      vendor_companies.org_id,
      vendor_companies.id as company_id,
      count(daily_log_entries.id)::integer as daily_log_mention_count
    from vendor_companies
    left join public.daily_log_entries
      on daily_log_entries.org_id = vendor_companies.org_id
      and daily_log_entries.created_at::date between p_period_start and p_period_end
      and (
        daily_log_entries.metadata->>'company_id' = vendor_companies.id::text
        or daily_log_entries.description ilike ('%' || vendor_companies.name || '%')
      )
    group by vendor_companies.org_id, vendor_companies.id
  ),
  scored as (
    select
      vendor_companies.org_id,
      vendor_companies.id as company_id,
      coalesce(commitment_metrics.committed_cents, 0) as committed_cents,
      coalesce(bill_metrics.billed_cents, 0) as billed_cents,
      coalesce(bill_metrics.paid_cents, 0) as paid_cents,
      coalesce(bill_metrics.invoice_issue_count, 0) as invoice_issue_count,
      coalesce(daily_log_metrics.daily_log_mention_count, 0) as daily_log_mention_count,
      coalesce(change_order_metrics.change_order_count, 0) as change_order_count,
      coalesce(commitment_metrics.commitment_count, 0) as commitment_count,
      coalesce(bid_metrics.invite_count, 0) as invite_count,
      coalesce(bid_metrics.response_count, 0) as response_count,
      coalesce(bid_metrics.award_count, 0) as award_count,
      case
        when coalesce(bill_metrics.paid_bill_count, 0) = 0 then null
        else bill_metrics.on_time_bill_count::numeric / nullif(bill_metrics.paid_bill_count, 0)
      end as on_time_bill_rate,
      case
        when coalesce(bid_metrics.invite_count, 0) = 0 then null
        else bid_metrics.response_count::numeric / nullif(bid_metrics.invite_count, 0)
      end as bid_response_rate,
      case
        when coalesce(bid_metrics.invite_count, 0) = 0 then null
        else bid_metrics.award_count::numeric / nullif(bid_metrics.invite_count, 0)
      end as bid_win_rate,
      case
        when coalesce(commitment_metrics.commitment_count, 0) = 0 then null
        else change_order_metrics.change_order_count::numeric / nullif(commitment_metrics.commitment_count, 0)
      end as change_order_rate
    from vendor_companies
    left join bill_metrics
      on bill_metrics.org_id = vendor_companies.org_id
      and bill_metrics.company_id = vendor_companies.id
    left join commitment_metrics
      on commitment_metrics.org_id = vendor_companies.org_id
      and commitment_metrics.company_id = vendor_companies.id
    left join change_order_metrics
      on change_order_metrics.org_id = vendor_companies.org_id
      and change_order_metrics.company_id = vendor_companies.id
    left join bid_metrics
      on bid_metrics.org_id = vendor_companies.org_id
      and bid_metrics.company_id = vendor_companies.id
    left join daily_log_metrics
      on daily_log_metrics.org_id = vendor_companies.org_id
      and daily_log_metrics.company_id = vendor_companies.id
  ),
  final_scores as (
    select
      scored.*,
      least(
        100::numeric,
        greatest(
          0::numeric,
          round(
            55::numeric
            + (coalesce(scored.on_time_bill_rate, 0.75) * 20)
            + (coalesce(scored.bid_response_rate, 0.50) * 12)
            + (coalesce(scored.bid_win_rate, 0.15) * 8)
            - least(coalesce(scored.invoice_issue_count, 0) * 4, 16)
            - least(coalesce(scored.change_order_rate, 0) * 12, 12)
          )
        )
      ) as score
    from scored
  ),
  upserted as (
    insert into public.vendor_scorecards (
      org_id,
      company_id,
      period_start,
      period_end,
      score,
      rating_label,
      on_time_bill_rate,
      bid_response_rate,
      bid_win_rate,
      change_order_rate,
      daily_log_mention_count,
      warranty_callback_count,
      invoice_issue_count,
      committed_cents,
      billed_cents,
      paid_cents,
      metrics,
      computed_at,
      updated_at
    )
    select
      final_scores.org_id,
      final_scores.company_id,
      p_period_start,
      p_period_end,
      final_scores.score,
      case
        when final_scores.committed_cents = 0
          and final_scores.billed_cents = 0
          and final_scores.invite_count = 0 then 'Needs data'
        when final_scores.score >= 85 then 'Strong'
        when final_scores.score >= 70 then 'Solid'
        when final_scores.score >= 55 then 'Watch'
        else 'Risk'
      end,
      final_scores.on_time_bill_rate,
      final_scores.bid_response_rate,
      final_scores.bid_win_rate,
      final_scores.change_order_rate,
      final_scores.daily_log_mention_count,
      0,
      final_scores.invoice_issue_count,
      final_scores.committed_cents,
      final_scores.billed_cents,
      final_scores.paid_cents,
      jsonb_build_object(
        'invite_count', final_scores.invite_count,
        'response_count', final_scores.response_count,
        'award_count', final_scores.award_count,
        'commitment_count', final_scores.commitment_count,
        'change_order_count', final_scores.change_order_count,
        'period_start', p_period_start,
        'period_end', p_period_end
      ),
      now(),
      now()
    from final_scores
    on conflict (org_id, company_id, period_start, period_end) do update
    set
      score = excluded.score,
      rating_label = excluded.rating_label,
      on_time_bill_rate = excluded.on_time_bill_rate,
      bid_response_rate = excluded.bid_response_rate,
      bid_win_rate = excluded.bid_win_rate,
      change_order_rate = excluded.change_order_rate,
      daily_log_mention_count = excluded.daily_log_mention_count,
      warranty_callback_count = excluded.warranty_callback_count,
      invoice_issue_count = excluded.invoice_issue_count,
      committed_cents = excluded.committed_cents,
      billed_cents = excluded.billed_cents,
      paid_cents = excluded.paid_cents,
      metrics = excluded.metrics,
      computed_at = excluded.computed_at,
      updated_at = now()
    returning 1
  )
  select count(*) into v_count from upserted;

  return coalesce(v_count, 0);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.refresh_vendor_tax_readiness(p_org_id uuid DEFAULT NULL::uuid, p_tax_year integer DEFAULT (EXTRACT(year FROM CURRENT_DATE))::integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_count integer := 0;
  v_threshold_cents integer := case when p_tax_year >= 2026 then 200000 else 60000 end;
begin
  insert into public.compliance_document_types
    (org_id, name, code, description, has_expiry, expiry_warning_days, is_system, is_active)
  select
    orgs.id,
    'W-9',
    'w9',
    'Request for Taxpayer Identification Number and Certification for year-end 1099 readiness.',
    false,
    0,
    true,
    true
  from public.orgs
  where p_org_id is null or orgs.id = p_org_id
  on conflict (org_id, code) do update
  set
    name = excluded.name,
    description = excluded.description,
    has_expiry = excluded.has_expiry,
    expiry_warning_days = excluded.expiry_warning_days,
    is_system = true,
    is_active = true;

  with vendor_companies as (
    select
      companies.id,
      companies.org_id,
      companies.name,
      companies.company_type,
      (select min(l.external_id) from public.accounting_counterparty_links l where l.org_id = companies.org_id and l.entity_type = 'company' and l.entity_id = companies.id and l.role = 'vendor' and l.provider = 'qbo' having count(*) = 1) as qbo_vendor_id,
      (select min(l.external_name) from public.accounting_counterparty_links l where l.org_id = companies.org_id and l.entity_type = 'company' and l.entity_id = companies.id and l.role = 'vendor' and l.provider = 'qbo' having count(*) = 1) as qbo_vendor_name
    from public.companies
    left join public.directory_relationship_types as relationship_types
      on relationship_types.id = companies.relationship_type_id
    where (p_org_id is null or companies.org_id = p_org_id)
      and companies.metadata->>'archived_at' is null
      and (
        companies.company_type in ('subcontractor', 'supplier')
        or relationship_types.canonical_category = 'vendor'
      )
  ),
  w9_types as (
    select id, org_id
    from public.compliance_document_types
    where code = 'w9'
  ),
  paid as (
    select
      vendor_bills.org_id,
      vendor_bills.company_id,
      count(*)::integer as bill_count,
      coalesce(
        sum(
          coalesce(
            vendor_bills.paid_cents,
            case when vendor_bills.status = 'paid' then vendor_bills.total_cents::bigint else 0 end
          )
        ),
        0
      )::bigint as paid_cents,
      max(coalesce(vendor_bills.bill_date, vendor_bills.created_at::date)) as last_bill_date
    from public.vendor_bills
    where vendor_bills.company_id is not null
      and (p_org_id is null or vendor_bills.org_id = p_org_id)
      and coalesce(vendor_bills.paid_at::date, vendor_bills.bill_date, vendor_bills.created_at::date)
        between make_date(p_tax_year, 1, 1) and make_date(p_tax_year, 12, 31)
    group by vendor_bills.org_id, vendor_bills.company_id
  ),
  upserted as (
    insert into public.vendor_tax_readiness (
      org_id,
      company_id,
      tax_year,
      requires_1099,
      w9_document_type_id,
      w9_document_id,
      w9_status,
      qbo_vendor_id,
      qbo_vendor_name,
      paid_cents,
      bill_count,
      last_bill_date,
      last_checked_at,
      metadata,
      updated_at
    )
    select
      vendor_companies.org_id,
      vendor_companies.id,
      p_tax_year,
      coalesce(paid.paid_cents, 0) >= v_threshold_cents,
      w9_types.id,
      latest_w9.id,
      case
        when coalesce(paid.paid_cents, 0) < v_threshold_cents then 'not_required'
        when latest_w9.status = 'approved' then 'ready'
        when latest_w9.status in ('pending_review', 'submitted') then 'pending_review'
        when latest_w9.status = 'rejected' then 'rejected'
        else 'missing'
      end,
      vendor_companies.qbo_vendor_id,
      vendor_companies.qbo_vendor_name,
      coalesce(paid.paid_cents, 0),
      coalesce(paid.bill_count, 0),
      paid.last_bill_date,
      now(),
      jsonb_build_object('threshold_cents', v_threshold_cents, 'source', 'vendor_bills'),
      now()
    from vendor_companies
    join w9_types
      on w9_types.org_id = vendor_companies.org_id
    left join paid
      on paid.org_id = vendor_companies.org_id
      and paid.company_id = vendor_companies.id
    left join lateral (
      select compliance_documents.id, compliance_documents.status
      from public.compliance_documents
      where compliance_documents.org_id = vendor_companies.org_id
        and compliance_documents.company_id = vendor_companies.id
        and compliance_documents.document_type_id = w9_types.id
      order by
        case compliance_documents.status
          when 'approved' then 1
          when 'pending_review' then 2
          when 'submitted' then 3
          when 'rejected' then 4
          else 5
        end,
        compliance_documents.created_at desc
      limit 1
    ) as latest_w9 on true
    on conflict (org_id, company_id, tax_year) do update
    set
      requires_1099 = excluded.requires_1099,
      w9_document_type_id = excluded.w9_document_type_id,
      w9_document_id = excluded.w9_document_id,
      w9_status = excluded.w9_status,
      qbo_vendor_id = excluded.qbo_vendor_id,
      qbo_vendor_name = excluded.qbo_vendor_name,
      paid_cents = excluded.paid_cents,
      bill_count = excluded.bill_count,
      last_bill_date = excluded.last_bill_date,
      last_checked_at = excluded.last_checked_at,
      metadata = excluded.metadata,
      updated_at = now()
    returning 1
  )
  select count(*) into v_count from upserted;

  return coalesce(v_count, 0);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.replace_invoice_lines_atomic(p_org_id uuid, p_invoice_id uuid, p_invoice_update jsonb, p_lines jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  update public.invoices
  set
    invoice_number = coalesce(p_invoice_update->>'invoice_number', invoice_number),
    issue_date = coalesce((p_invoice_update->>'issue_date')::date, issue_date),
    due_date = coalesce((p_invoice_update->>'due_date')::date, due_date),
    notes = coalesce(p_invoice_update->>'notes', notes),
    status = coalesce(p_invoice_update->>'status', status),
    subtotal_cents = coalesce((p_invoice_update->>'subtotal_cents')::integer, subtotal_cents),
    tax_cents = coalesce((p_invoice_update->>'tax_cents')::integer, tax_cents),
    total_cents = coalesce((p_invoice_update->>'total_cents')::integer, total_cents),
    balance_due_cents = coalesce((p_invoice_update->>'balance_due_cents')::integer, balance_due_cents),
    updated_at = now()
  where org_id = p_org_id
    and id = p_invoice_id;

  if not found then
    raise exception 'Invoice not found';
  end if;

  delete from public.invoice_lines
  where org_id = p_org_id
    and invoice_id = p_invoice_id;

  insert into public.invoice_lines (
    org_id,
    invoice_id,
    description,
    quantity,
    unit,
    unit_price_cents,
    metadata
  )
  select
    p_org_id,
    p_invoice_id,
    coalesce(line->>'description', ''),
    coalesce((line->>'quantity')::numeric, 1),
    line->>'unit',
    coalesce((line->>'unit_price_cents')::integer, 0),
    coalesce(line->'metadata', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as line;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_qbo_invoice_opening_payment()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_other_paid bigint; v_reversed bigint; v_opening_cents integer; v_existing_id uuid;
  v_external_id text; v_synced_at timestamptz;
begin
  if new.status='void' then return new; end if;
  select external_id, last_synced_at into v_external_id, v_synced_at
  from public.accounting_sync_records where org_id = new.org_id and entity_type = 'invoice' and entity_id = new.id
    and nullif(external_id, '') is not null order by updated_at desc limit 1;
  if v_external_id is null then return new; end if;
  select coalesce(sum(amount_cents),0) into v_other_paid from public.payments
    where org_id=new.org_id and invoice_id=new.id and provider is distinct from 'qbo_opening_balance'
      and status in ('processing','succeeded','completed','refunded');
  select coalesce(sum(amount_cents),0) into v_reversed from public.payment_reversals
    where org_id=new.org_id and invoice_id=new.id and status in ('pending','succeeded');
  v_opening_cents:=greatest(coalesce(new.total_cents,0)-coalesce(new.balance_due_cents,new.total_cents,0)-greatest(v_other_paid-v_reversed,0),0);
  select id into v_existing_id from public.payments
    where org_id=new.org_id and invoice_id=new.id and provider='qbo_opening_balance' limit 1 for update;
  if v_opening_cents>0 and v_existing_id is null then
    insert into public.payments (org_id,project_id,invoice_id,amount_cents,gross_cents,currency,method,provider,status,reference,fee_cents,net_cents,idempotency_key,metadata,received_at)
    values (new.org_id,new.project_id,new.id,v_opening_cents,v_opening_cents,coalesce(new.currency,'usd'),'opening_balance','qbo_opening_balance','completed','Imported paid balance from QuickBooks',0,v_opening_cents,'qbo-opening-balance:'||new.id::text,
      jsonb_build_object('system_generated',true,'source','qbo_invoice_balance','qbo_invoice_id',v_external_id),coalesce(v_synced_at,new.updated_at,now()));
  elsif v_opening_cents>0 then
    update public.payments set amount_cents=v_opening_cents,gross_cents=v_opening_cents,net_cents=v_opening_cents,
      currency=coalesce(new.currency,currency,'usd'),metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('qbo_invoice_id',v_external_id,'last_reconciled_at',now())
    where id=v_existing_id;
  elsif v_existing_id is not null then
    delete from public.payments where id=v_existing_id;
  end if;
  return new;
end; $function$
;

CREATE OR REPLACE FUNCTION public.void_receivable_adjustment_atomic(p_org_id uuid, p_adjustment_id uuid, p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  v_adjustment public.receivable_adjustments%rowtype;
begin
  select * into v_adjustment
  from public.receivable_adjustments
  where id = p_adjustment_id and org_id = p_org_id
  for update;
  if v_adjustment.id is null then raise exception 'Receivable adjustment not found'; end if;
  if v_adjustment.status = 'void' then return to_jsonb(v_adjustment); end if;

  update public.receivable_adjustments
  set status = 'void', voided_by = p_actor_id, voided_at = now(), updated_at = now()
  where id = p_adjustment_id and org_id = p_org_id
  returning * into v_adjustment;

  perform public.recalc_invoice_balance_atomic(p_org_id, v_adjustment.invoice_id);
  update public.accounting_sync_records
  set status = 'needs_review', status_reason = 'receivable_adjustment', updated_at = now()
  where entity_id = v_adjustment.invoice_id and org_id = p_org_id and entity_type = 'invoice' and nullif(external_id, '') is not null;
  return to_jsonb(v_adjustment);
end;
$function$
;

-- Import inserts the invoice before its neutral mapping. Call after the mapping is durable
-- within the same transaction; the invoice trigger owns opening-balance arithmetic.
create or replace function public.reconcile_accounting_invoice_opening_payment(p_org_id uuid, p_invoice_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.invoices set balance_due_cents = balance_due_cents where org_id = p_org_id and id = p_invoice_id;
  if not found then raise exception 'Invoice not found'; end if;
end;
$$;
revoke all on function public.reconcile_accounting_invoice_opening_payment(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reconcile_accounting_invoice_opening_payment(uuid, uuid) to service_role;

-- Recreate the trigger without a column-level dependency on the retired cache.
drop trigger if exists invoices_sync_qbo_opening_payment on public.invoices;
create trigger invoices_sync_qbo_opening_payment
  after insert or update of total_cents, balance_due_cents, status on public.invoices
  for each row execute function public.sync_qbo_invoice_opening_payment();

-- PostgreSQL 17 can replace the generated expression in place, preserving its
-- index and dependent duplicate protections while removing the legacy dependency.
alter table public.vendor_bills alter column vendor_name_normalized
  set expression as (public.normalize_vendor_name(coalesce(metadata ->> 'vendor_name', accounting_coding #>> '{counterparty,name}', accounting_coding #>> '{vendor,name}')));

-- release_retainage_atomic is already provider-neutral in the applied waiver
-- lifecycle migration 20260908015053. Preserve its cost-code distribution and
-- revision safeguards instead of replacing it from an older pending definition.
