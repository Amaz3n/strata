-- The division wall, on every table that holds a division's records.
--
-- 20261011010000, 20261011140000 and 20261011190000 put the restrictive
-- division backstop on the core project tables, communities, lots, the search
-- index, prospects and start packages. Every other table that hangs off a home,
-- a lead, a lot or a community still answered only "is this an org member", so
-- a division- or project-limited member's own JWT read (and wrote) another
-- division's meetings, inspections, warranty requests, pay applications,
-- estimates, reservations and community setup straight through PostgREST.
--
-- This adds ONE restrictive policy, <table>_division_scope, to each table
-- below. As before it is ANDed with the table's permissive policies, only ever
-- removes rows, and applies to `authenticated` (the service role, platform
-- operators and the token portals bypass it). A table holds a division's data
-- through one or more of these references; each one it carries must pass:
--
--   project    project_id is null, or the caller reaches every project in the
--              org, or the project is in member_reachable_project_ids() --
--              division AND project scope, as on the core tables;
--   prospect   prospect_id is null, or the caller reaches every division, or
--              the lead is not in a community of a foreign division -- as on
--              prospects (an unattributed lead stays visible to the org);
--   lot        lot_id is null, or the caller reaches every division, or the lot
--              is in a reachable division -- as on lots and start_packages;
--   community  community_id is null, or the caller reaches every division, or
--              the community is in a reachable division -- as on communities.
--              A null community on a catalog, incentive or rule row means
--              "org-wide" and stays visible.
--
-- The list is explicit so it can be reviewed against the schema it is applied
-- to; each table is skipped if it does not exist there. It was built from every
-- public table with a project_id, prospect_id, lot_id or community_id foreign
-- key to projects, prospects, lots or communities.
--
-- Included, with the references enforced:
--   project only     every table in the first block below. Service-role-only
--                    internals (receipts, reservations, upload/deletion
--                    operations, authorization_audit_log, portal_access_tokens,
--                    external_identity_grants, ai_search_answer_cache, ...) are
--                    included on purpose: they grant authenticated nothing
--                    today, and a permissive policy added later inherits the
--                    wall instead of opening a hole.
--   project+prospect documents, envelopes, estimates, file_links, proposals,
--                    project_precon_handoffs (precon work is filed on the lead
--                    before there is a home).
--   project+prospect+community  bid_packages.
--   project+community  accounting_entity_map, design_studio_appointments,
--                    report_runs, saved_report_configs (a report run over a
--                    community holds that community's numbers).
--   project+lot      po_generation_runs, purchase_agreement_creation_receipts,
--                    quick_capture_drafts, structured_form_runs.
--   prospect only    precon_workspaces, precon_decisions, prospect_contacts.
--   lot only         lot_reservations, reservation_conversion_requests,
--                    books_intercompany_sales (the lot settles the community
--                    and prospect a reservation also names).
--   community only   community_assignments, community_phases,
--                    community_plan_availability, community_release_slots,
--                    community_traffic, lot_takedowns, incentives,
--                    agreement_incentive_capacity, selection_categories,
--                    selection_groups, selection_options, selection_packages,
--                    selection_catalog_prices, vendor_price_agreements,
--                    warranty_routing_rules (community config belongs to the
--                    community's division).
--   files            already walled by project; gains files_prospect_division_scope
--                    for precon files filed on a lead with no home yet.
--
-- Excluded:
--   projects, budgets, budget_lines, contracts, files (project), photos,
--   invoices, vendor_bills, commitments, change_orders, project_selections,
--   schedule_items, tasks, rfis, submittals, daily_logs, punch_items, closings,
--   communities, lots, search_documents, prospects, start_packages
--                    already carry a *_division_scope policy.
--   project_division_history  its own read policy deliberately lets a division
--                    read the history rows it held after a home moved away.
--   arc_bid_benchmark_facts  anonymised cross-org benchmark facts: the project
--                    is the contributing org's, not the reader's.
--   platform_bugs    platform staff data (no authenticated policy); the project
--                    is context on a report, not tenant data.
--   onboarding_runs  pilot_community_id is an onboarding choice, not ownership.
--   closings, start_packages lot/community columns: already walled by project
--                    or lot.
--
-- Cost: as in the backstop, the unscoped-org arrays are initplans and every
-- reachable/foreign set is an uncorrelated IN built once per statement as a
-- hashed subplan. An org-wide member pays one array test per row.

set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. The two sets the earlier helpers do not already give.
-- ---------------------------------------------------------------------------

create or replace function public.member_reachable_community_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id
  from public.communities c
  where c.division_id in (select public.member_reachable_division_ids());
$$;

comment on function public.member_reachable_community_ids() is
  'Communities in the divisions a division-restricted caller is assigned to. Policies use it as an uncorrelated IN so it is built once per statement.';

-- Definer: the caller cannot see a foreign division's prospects, so an invoker
-- subquery would return none of them and NOT IN would let every row through.
create or replace function public.member_foreign_division_prospect_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.prospects p
  where p.community_id in (select public.member_foreign_division_community_ids());
$$;

comment on function public.member_foreign_division_prospect_ids() is
  'Leads in the caller''s orgs whose community is filed under a division the caller is not assigned to. Policies use it as an uncorrelated NOT IN so it is built once per statement.';

revoke all on function public.member_reachable_community_ids() from public, anon;
revoke all on function public.member_foreign_division_prospect_ids() from public, anon;
grant execute on function public.member_reachable_community_ids() to authenticated, service_role;
grant execute on function public.member_foreign_division_prospect_ids() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The wall.
-- ---------------------------------------------------------------------------

do $$
declare
  scoped record;
  clauses text[];
  predicate text;
begin
  for scoped in
    select *
    from (
      values
        -- table, project, prospect, lot, community
        ('accounting_batch_lines', true, false, false, false),
        ('ai_search_answer_cache', true, false, false, false),
        ('ai_standing_questions', true, false, false, false),
        ('allowances', true, false, false, false),
        ('authorization_audit_log', true, false, false, false),
        ('bank_rules', true, false, false, false),
        ('bill_lines', true, false, false, false),
        ('billable_costs', true, false, false, false),
        ('billing_autopilot_items', true, false, false, false),
        ('billing_autopilot_runs', true, false, false, false),
        ('billing_rate_overrides', true, false, false, false),
        ('books_development_allocations', true, false, false, false),
        ('books_fixed_assets', true, false, false, false),
        ('books_inventory_impairments', true, false, false, false),
        ('books_payroll_labor_ownership', true, false, false, false),
        ('books_revenue_policies', true, false, false, false),
        ('books_wip_cost_allocations', true, false, false, false),
        ('budget_revisions', true, false, false, false),
        ('budget_snapshots', true, false, false, false),
        ('budget_transfers', true, false, false, false),
        ('certified_payroll_reports', true, false, false, false),
        ('change_event_lines', true, false, false, false),
        ('change_event_rfqs', true, false, false, false),
        ('change_events', true, false, false, false),
        ('closeout_items', true, false, false, false),
        ('closeout_packages', true, false, false, false),
        ('commitment_change_orders', true, false, false, false),
        ('compliance_documents', true, false, false, false),
        ('conversations', true, false, false, false),
        ('conversion_runs', true, false, false, false),
        ('cost_approval_batches', true, false, false, false),
        ('custom_field_values', true, false, false, false),
        ('daily_log_comments', true, false, false, false),
        ('daily_log_entries', true, false, false, false),
        ('daily_log_mentions', true, false, false, false),
        ('daily_report_delays', true, false, false, false),
        ('daily_report_deliveries', true, false, false, false),
        ('daily_report_equipment', true, false, false, false),
        ('daily_report_manpower', true, false, false, false),
        ('daily_report_visitors', true, false, false, false),
        ('daily_reports', true, false, false, false),
        ('decisions', true, false, false, false),
        ('desk_rollup_counts', true, false, false, false),
        ('disbursements', true, false, false, false),
        ('document_packets', true, false, false, false),
        ('document_upload_transfers', true, false, false, false),
        ('draw_schedules', true, false, false, false),
        ('drawing_deletion_operations', true, false, false, false),
        ('drawing_pins', true, false, false, false),
        ('drawing_revisions', true, false, false, false),
        ('drawing_sets', true, false, false, false),
        ('drawing_sheets', true, false, false, false),
        ('drawing_upload_operations', true, false, false, false),
        ('esign_bulk_reservations', true, false, false, false),
        ('esign_templates', true, false, false, false),
        ('external_identity_grants', true, false, false, false),
        ('file_share_links', true, false, false, false),
        ('floorplan_models', true, false, false, false),
        ('gmp_contingency_entries', true, false, false, false),
        ('inspection_completion_receipts', true, false, false, false),
        ('inspection_lifecycle_receipts', true, false, false, false),
        ('inspection_obligations', true, false, false, false),
        ('inspections', true, false, false, false),
        ('invoice_auto_approval_rules', true, false, false, false),
        ('invoice_backup_packages', true, false, false, false),
        ('invoice_lien_waivers', true, false, false, false),
        ('invoice_payment_reservations', true, false, false, false),
        ('invoice_schedules', true, false, false, false),
        ('job_cost_entries', true, false, false, false),
        ('journal_lines', true, false, false, false),
        ('late_fees', true, false, false, false),
        ('lien_waivers', true, false, false, false),
        ('meeting_distribution_recipients', true, false, false, false),
        ('meeting_items', true, false, false, false),
        ('meeting_transcripts', true, false, false, false),
        ('meetings', true, false, false, false),
        ('observations', true, false, false, false),
        ('opening_balance_lines', true, false, false, false),
        ('pay_applications', true, false, false, false),
        ('payment_allocations', true, false, false, false),
        ('payment_hold_overrides', true, false, false, false),
        ('payment_hold_policies', true, false, false, false),
        ('payment_intents', true, false, false, false),
        ('payment_reversals', true, false, false, false),
        ('payment_run_items', true, false, false, false),
        ('payment_schedules', true, false, false, false),
        ('payments', true, false, false, false),
        ('photo_albums', true, false, false, false),
        ('po_completions', true, false, false, false),
        ('po_generation_exceptions', true, false, false, false),
        ('poc_snapshots', true, false, false, false),
        ('portal_access_tokens', true, false, false, false),
        ('prime_sov_budget_links', true, false, false, false),
        ('prime_sov_lines', true, false, false, false),
        ('project_billing_periods', true, false, false, false),
        ('project_compliance_requirements', true, false, false, false),
        ('project_cost_code_progress', true, false, false, false),
        ('project_distribution_members', true, false, false, false),
        ('project_email_links', true, false, false, false),
        ('project_emails', true, false, false, false),
        ('project_expense_lines', true, false, false, false),
        ('project_expenses', true, false, false, false),
        ('project_fee_billings', true, false, false, false),
        ('project_fee_schedule_lines', true, false, false, false),
        ('project_fee_schedules', true, false, false, false),
        ('project_file_folder_permissions', true, false, false, false),
        ('project_file_folders', true, false, false, false),
        ('project_financial_settings', true, false, false, false),
        ('project_gmp_snapshots', true, false, false, false),
        ('project_locations', true, false, false, false),
        ('project_members', true, false, false, false),
        ('project_module_overrides', true, false, false, false),
        ('project_selection_groups', true, false, false, false),
        ('project_settings', true, false, false, false),
        ('project_vendors', true, false, false, false),
        ('project_warranty_coverage', true, false, false, false),
        ('project_weather_cache', true, false, false, false),
        ('receipts', true, false, false, false),
        ('receivable_adjustments', true, false, false, false),
        ('receivable_payment_group_items', true, false, false, false),
        ('recurring_posting_lines', true, false, false, false),
        ('reservation_conversion_receipts', true, false, false, false),
        ('retainage', true, false, false, false),
        ('rfi_external_participants', true, false, false, false),
        ('safety_incidents', true, false, false, false),
        ('saved_payable_views', true, false, false, false),
        ('schedule_assignments', true, false, false, false),
        ('schedule_baselines', true, false, false, false),
        ('schedule_dependencies', true, false, false, false),
        ('sheet_building_records', true, false, false, false),
        ('spec_revisions', true, false, false, false),
        ('spec_sections', true, false, false, false),
        ('spec_uploads', true, false, false, false),
        ('submittal_register_drafts', true, false, false, false),
        ('submittal_revisions', true, false, false, false),
        ('subtier_waiver_requirements', true, false, false, false),
        ('takeoff_conditions', true, false, false, false),
        ('takeoff_sheet_status', true, false, false, false),
        ('time_entries', true, false, false, false),
        ('tm_ticket_items', true, false, false, false),
        ('tm_tickets', true, false, false, false),
        ('toolbox_talks', true, false, false, false),
        ('transmittals', true, false, false, false),
        ('variance_alerts', true, false, false, false),
        ('wage_determinations', true, false, false, false),
        ('warranty_backcharges', true, false, false, false),
        ('warranty_courtesy_reservations', true, false, false, false),
        ('warranty_requests', true, false, false, false),
        ('warranty_service_visits', true, false, false, false),
        ('warranty_visit_completion_receipts', true, false, false, false),

        ('documents', true, true, false, false),
        ('envelopes', true, true, false, false),
        ('estimates', true, true, false, false),
        ('file_links', true, true, false, false),
        ('proposals', true, true, false, false),
        ('project_precon_handoffs', true, true, false, false),
        ('bid_packages', true, true, false, true),
        ('accounting_entity_map', true, false, false, true),
        ('design_studio_appointments', true, false, false, true),
        ('report_runs', true, false, false, true),
        ('saved_report_configs', true, false, false, true),
        ('po_generation_runs', true, false, true, false),
        ('purchase_agreement_creation_receipts', true, false, true, false),
        ('quick_capture_drafts', true, false, true, false),
        ('structured_form_runs', true, false, true, false),

        ('precon_workspaces', false, true, false, false),
        ('precon_decisions', false, true, false, false),
        ('prospect_contacts', false, true, false, false),

        ('lot_reservations', false, false, true, false),
        ('reservation_conversion_requests', false, false, true, false),
        ('books_intercompany_sales', false, false, true, false),

        ('community_assignments', false, false, false, true),
        ('community_phases', false, false, false, true),
        ('community_plan_availability', false, false, false, true),
        ('community_release_slots', false, false, false, true),
        ('community_traffic', false, false, false, true),
        ('lot_takedowns', false, false, false, true),
        ('incentives', false, false, false, true),
        ('agreement_incentive_capacity', false, false, false, true),
        ('selection_categories', false, false, false, true),
        ('selection_groups', false, false, false, true),
        ('selection_options', false, false, false, true),
        ('selection_packages', false, false, false, true),
        ('selection_catalog_prices', false, false, false, true),
        ('vendor_price_agreements', false, false, false, true),
        ('warranty_routing_rules', false, false, false, true)
    ) as t(table_name, by_project, by_prospect, by_lot, by_community)
  loop
    continue when to_regclass(format('public.%I', scoped.table_name)) is null;

    clauses := '{}';
    if scoped.by_project then
      clauses := array_append(clauses, $clause$(
        project_id is null
        or org_id = any ((select public.member_unscoped_org_ids())::uuid[])
        or project_id in (select public.member_reachable_project_ids())
      )$clause$);
    end if;
    if scoped.by_prospect then
      clauses := array_append(clauses, $clause$(
        prospect_id is null
        or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
        or prospect_id not in (select public.member_foreign_division_prospect_ids())
      )$clause$);
    end if;
    if scoped.by_lot then
      clauses := array_append(clauses, $clause$(
        lot_id is null
        or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
        or lot_id in (select public.member_reachable_lot_ids())
      )$clause$);
    end if;
    if scoped.by_community then
      clauses := array_append(clauses, $clause$(
        community_id is null
        or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
        or community_id in (select public.member_reachable_community_ids())
      )$clause$);
    end if;
    predicate := array_to_string(clauses, ' and ');

    execute format('drop policy if exists %I on public.%I', scoped.table_name || '_division_scope', scoped.table_name);
    execute format(
      'create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)',
      scoped.table_name || '_division_scope',
      scoped.table_name,
      predicate,
      predicate
    );
  end loop;
end
$$;

-- files already carries files_division_scope on its project; a precon file is
-- filed on the lead before there is a home.
do $$
begin
  if to_regclass('public.files') is not null then
    drop policy if exists files_prospect_division_scope on public.files;
    create policy files_prospect_division_scope on public.files
      as restrictive
      for all
      to authenticated
      using (
        prospect_id is null
        or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
        or prospect_id not in (select public.member_foreign_division_prospect_ids())
      )
      with check (
        prospect_id is null
        or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
        or prospect_id not in (select public.member_foreign_division_prospect_ids())
      );
  end if;
end
$$;
