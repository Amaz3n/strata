-- WS-A5 — repair the migration ledger so repository versions and production
-- history agree exactly.
--
-- ⚠ A HUMAN RUNS THIS, ONCE, AFTER READING
--   docs/plans/migration-ledger-reconciliation.md.
-- Never run it from application code or a migration.
--
-- Supabase MCP always stamps a fresh version. Production therefore has hundreds
-- of correctly applied changes recorded under versions that do not exist in the
-- repository. This script records every known-applied repository migration under
-- its canonical version and removes only the superseded MCP-stamped rows.
--
-- The ten genuinely pending migrations are deliberately absent from the map.
-- Recording one of those here would lie about production state. The map holds
-- 349 known-applied repository migrations and was refreshed on 2026-09-05
-- against the live ledger: every row is either already named in
-- `supabase_migrations.schema_migrations` or was object-verified in production
-- that day. Regenerate it rather than editing it by hand — a stale map is how an
-- applied migration gets recorded as pending, or worse.
--
-- ONE statement on purpose. It was `begin; ... commit;` around a temp table
-- declared `on commit drop`, which is correct under psql and ambiguous under any
-- client that manages its own transaction — the temp table can vanish under the
-- script's feet, leaving the inserts applied and the deletes not. A single DO
-- block is atomic under every client.
--
-- Idempotent: exact-version rows survive, the insert is ON CONFLICT, and
-- superseded rows are selected by normalized migration name. Raises notices with
-- before/after counts and aborts the whole block if any expected applied version
-- or any duplicated name remains.

do $repair$
declare
  v_rows integer;
  v_exact integer;
  v_missing integer;
  v_duplicate_names integer;
  v_inserted integer;
  v_deleted integer;
  v_expected integer;
begin
  drop table if exists migration_ledger_expected;
  create temporary table migration_ledger_expected (
    version text primary key,
    name text not null unique
  );

  insert into migration_ledger_expected (version, name)
  values
  ('20260517092101', 'remote_schema'),
  ('20260519010000', 'fix_org_admin_member_rls_helper'),
  ('20260519012752', 'add_vendor_bill_qbo_account_columns'),
  ('20260522120000', 'add_email_notification_type_preferences'),
  ('20260524000000', 'esign_audit_hardening'),
  ('20260525120000', 'allow_internal_payables_without_commitments'),
  ('20260525155817', 'fix_get_user_sessions_timestamp'),
  ('20260525170000', 'authorization_audit_log_project_delete_set_null'),
  ('20260529123000', 'add_qbo_connection_client_id'),
  ('20260529182645', 'estimate_portal_comments_versioning'),
  ('20260530003304', 'estimates_version_group_default_trigger'),
  ('20260530120000', 'precon_phase_a_prospect_foundation'),
  ('20260530133000', 'precon_phase_b_backfill_prospects'),
  ('20260530150000', 'precon_phase_e_estimate_execution'),
  ('20260531120000', 'precon_prospect_follow_ups'),
  ('20260531130000', 'precon_prospect_follow_up_reminders'),
  ('20260531185915', 'daily_log_mentions_comments'),
  ('20260602120000', 'add_qbo_classes'),
  ('20260603140000', 'add_project_qbo_customer'),
  ('20260603190000', 'reconcile_approved_cost_invoice_rpc'),
  ('20260603200000', 'verify_approved_cost_invoice_preview'),
  ('20260603210000', 'add_job_cost_entries'),
  ('20260603220000', 'add_project_financial_settings'),
  ('20260603230000', 'add_project_billing_periods'),
  ('20260603231000', 'add_billing_period_fk_indexes'),
  ('20260603232000', 'add_owner_billing_packages'),
  ('20260603233000', 'add_owner_billing_package_fk_indexes'),
  ('20260604000000', 'add_project_fee_billing'),
  ('20260604001000', 'add_project_fee_billing_fk_indexes'),
  ('20260604002000', 'add_gmp_control'),
  ('20260604003000', 'add_project_cost_code_toggle'),
  ('20260604004000', 'add_bill_line_project_allocation'),
  ('20260604120000', 'add_company_qbo_vendor_link'),
  ('20260605011500', 'add_vendor_bill_company_link'),
  ('20260605023000', 'fix_submittals_constraints'),
  ('20260605030000', 'add_schedule_item_change_orders'),
  ('20260605120000', 'qbo_je_import_and_pushability'),
  ('20260607120000', 'receivables_hardening_and_autopilot'),
  ('20260607183000', 'qbo_invoice_opening_payment_ledger'),
  ('20260610120000', 'add_project_expense_lines'),
  ('20260610194621', 'backfill_job_cost_entries'),
  ('20260610210000', 'drawing_sheets_mv_revision_label'),
  ('20260610220000', 'drawing_revision_drafts'),
  ('20260610220500', 'drawing_revision_progress'),
  ('20260611120000', 'remove_qbo_bill_payment_placeholders'),
  ('20260611130000', 'prospect_fk_set_null_on_delete'),
  ('20260611140000', 'refresh_drawing_sheets_list_allow_authenticated'),
  ('20260611150000', 'drawing_register_snapshot_rpc'),
  ('20260616120000', 'drawing_issuance_maturity'),
  ('20260616121000', 'publish_drawing_revision_transaction'),
  ('20260616130000', 'search_overhaul'),
  ('20260616133000', 'ai_workflow_sessions'),
  ('20260616140000', 'budget_line_actuals_linkage'),
  ('20260617120000', 'commitment_budget_glow_up'),
  ('20260618120000', 'budget_baseline_lock'),
  ('20260618120001', 'payment_allocations'),
  ('20260624120000', 'project_excluded_from_reporting'),
  ('20260625120000', 'mobile_device_tokens'),
  ('20260628193930', 'compliance_requirement_waivers'),
  ('20260629120000', 'add_change_order_number'),
  ('20260629120001', 'release_notes'),
  ('20260701123000', 'platform_bugs'),
  ('20260701140000', 'platform_bugs_drop_unused_fields'),
  ('20260701150000', 'platform_bugs_drop_severity'),
  ('20260701160000', 'platform_bug_attachment_pdfs'),
  ('20260701170000', 'platform_bug_ai_reviews'),
  ('20260701180000', 'daily_reports'),
  ('20260702130000', 'platform_bug_ai_fixes'),
  ('20260703120000', 'invoice_lien_waivers'),
  ('20260703120001', 'add_qbo_import_cost_code_mappings'),
  ('20260703160000', 'budget_line_variance_alerts'),
  ('20260703190230', 'esign_atomic_signature_recording'),
  ('20260703190300', 'esign_templates_bulk_reminders'),
  ('20260703191000', 'financials_phase0_correctness'),
  ('20260703210000', 'financials_phase2_fee_presentation'),
  ('20260704033339', 'financials_phase1_data_model_hardening'),
  ('20260704044500', 'financials_phase2_rpc_grants'),
  ('20260704120000', 'financials_phase3_gmp_control'),
  ('20260704155846', 'drawings_pipeline_constraints'),
  ('20260704170000', 'financials_phase5_real_tm'),
  ('20260704182750', 'navigation_scope_time_permissions'),
  ('20260704193000', 'documents_page_correctness_and_search'),
  ('20260704203000', 'bid_management_workflow'),
  ('20260704210000', 'portal_security_and_sharing_fixes'),
  ('20260705035513', 'directory_intelligence_schema'),
  ('20260705090000', 'portal_signing_and_payable_waivers'),
  ('20260705120000', 'settings_hardening'),
  ('20260705143000', 'ai_search_sql_analytics'),
  ('20260705160000', 'commitment_spine_links'),
  ('20260705161000', 'bid_award_budget_line_conversion'),
  ('20260705170000', 'task_reminders'),
  ('20260705173000', 'task_reminder_time'),
  ('20260705180000', 'invoice_schedules'),
  ('20260706120000', 'bid_award_copies_submission_lines'),
  ('20260707120000', 'subscription_billing_activation'),
  ('20260707192900', 'cost_plus_integrity_hardening'),
  ('20260708120000', 'operational_features_upgrade'),
  ('20260708120500', 'rbac_catalog_seed'),
  ('20260708121000', 'membership_project_scope'),
  ('20260708122000', 'membership_rls_write_lockdown'),
  ('20260709120000', 'hot_path_indexes'),
  ('20260709120001', 'job_runs_and_platform_aggregates'),
  ('20260709120500', 'drawings_hardening'),
  ('20260709121000', 'rls_initplan_sweep'),
  ('20260710010600', 'drawing_pins_photo_entity_type'),
  ('20260710090000', 'dashboard_rollups'),
  ('20260710091000', 'retention_pruning'),
  ('20260710120000', 'lazy_project_folders'),
  ('20260710120001', 'drawing_sheet_text_search'),
  ('20260710130000', 'app_users_coworker_read'),
  ('20260710140000', 'prime_sov'),
  ('20260710140100', 'stepped_retainage'),
  ('20260710140200', 'progress_billing_permissions'),
  ('20260710140300', 'pay_application_rpcs'),
  ('20260710184245', 'org_product_tier'),
  ('20260710190509', 'project_module_overrides'),
  ('20260710215226', 'cost_type_dimension'),
  ('20260710220000', 'change_lifecycle'),
  ('20260710233000', 'reviewer_portal'),
  ('20260710234500', 'submittal_workflow'),
  ('20260710235500', 'distribution_lists'),
  ('20260711010000', 'project_document_suite'),
  ('20260711020000', 'punch_company_assignment'),
  ('20260711021000', 'inspections'),
  ('20260711022000', 'safety_records'),
  ('20260711120000', 'budget_transfers'),
  ('20260711120100', 'vendor_tax'),
  ('20260711120200', 'prequalification'),
  ('20260711120300', 'phase7_fk_indexes'),
  ('20260711140000', 'daily_report_commercial_sections'),
  ('20260711190000', 'safety_read_permission'),
  ('20260711190500', 'budget_transfer_lifecycle'),
  ('20260711191000', 'pay_application_void_corrections'),
  ('20260711193000', 'safety_incident_photo'),
  ('20260711193500', 'parallel_submittal_reviews'),
  ('20260711194000', 'commercial_claims_completion'),
  ('20260711213307', 'remove_progress_billing_feature_flag'),
  ('20260711220000', 'structured_project_locations'),
  ('20260711230000', 'specifications_module'),
  ('20260711231009', 'harden_project_location_permissions'),
  ('20260712013617', 'certified_payroll_prevailing_wage'),
  ('20260712015622', 'gc_compliance_subtier_waivers'),
  ('20260712021453', 'meetings_supercharged'),
  ('20260712033000', 'wave2_hot_path_hardening'),
  ('20260712034500', 'wave2_updated_at_completeness'),
  ('20260712035000', 'meeting_project_list_indexes'),
  ('20260712040000', 'wave2_fk_covering_indexes'),
  ('20260712040001', 'inspection_schedule_link'),
  ('20260712040500', 'location_parent_identity_index'),
  ('20260715100001', 'unify_invoice_status_engine'),
  ('20260715100002', 'invoice_source_columns'),
  ('20260715100003', 'create_invoice_atomic'),
  ('20260715200001', 'qbo_outbox_dedupe_and_claims'),
  ('20260715200002', 'qbo_inbound_reconcile_retry'),
  ('20260715200003', 'qbo_cdc_cursor_merge'),
  ('20260716090000', 'bid_scope_line_model'),
  ('20260716090001', 'bid_award_structured_items'),
  ('20260716090002', 'bid_submission_atomic_versioning'),
  ('20260718090000', 'bid_rpc_execute_lockdown'),
  ('20260718161407', 'project_property_type_production'),
  ('20260718161409', 'divisions'),
  ('20260718161413', 'communities_phases'),
  ('20260718161416', 'lots_and_takedowns'),
  ('20260718161419', 'membership_division_scope'),
  ('20260718161422', 'land_permissions'),
  ('20260718165343', 'production_foundation_fk_indexes'),
  ('20260718170332', 'budget_templates'),
  ('20260718170333', 'house_plans'),
  ('20260718170334', 'plan_rbac_catalog'),
  ('20260718170335', 'plan_fk_indexes'),
  ('20260718182717', 'option_catalog_design_studio'),
  ('20260718182718', 'rbac_selections_catalog'),
  ('20260718182719', 'option_catalog_fk_indexes'),
  ('20260718193936', 'vendor_price_agreements'),
  ('20260718193937', 'vpo_reason_codes_and_settings'),
  ('20260718193938', 'bid_packages_community_plan'),
  ('20260718193939', 'po_generation_pay_on_po'),
  ('20260718210340', 'workstream_04_fk_indexes'),
  ('20260718210909', 'start_gate_definitions'),
  ('20260718210910', 'start_packages'),
  ('20260718210911', 'community_release_slots'),
  ('20260718210912', 'superintendent_and_start_rbac'),
  ('20260718214835', 'workstream_05_fk_indexes'),
  ('20260718220318', 'lot_reservations_incentives'),
  ('20260718220321', 'closings'),
  ('20260718220323', 'sales_permissions'),
  ('20260718225625', 'workstream_06_fk_indexes'),
  ('20260718230810', 'warranty_coverage'),
  ('20260718230832', 'warranty_service_ops'),
  ('20260718230838', 'warranty_backcharges'),
  ('20260718230841', 'warranty_rbac_catalog_seed'),
  ('20260719000759', 'workstream_07_fk_indexes'),
  ('20260719011735', 'accounting_connections'),
  ('20260719011822', 'accounting_sync_records'),
  ('20260719011920', 'accounting_entity_map'),
  ('20260719012335', 'accounting_rbac_and_events'),
  ('20260719012456', 'accounting_coding_backfill'),
  ('20260719014231', 'accounting_security_hardening'),
  ('20260719014317', 'accounting_trigger_function_privileges'),
  ('20260719020641', 'accounting_counterparty_links'),
  ('20260719021055', 'accounting_fk_indexes_and_qbo_trigger_lockdown'),
  ('20260719021658', 'accounting_provider_fk_indexes'),
  ('20260719022535', 'onboarding_and_import_staging'),
  ('20260719022548', 'onboarding_permissions'),
  ('20260719112742', 'onboarding_fk_indexes'),
  ('20260719140000', 'prospect_community_bridge'),
  ('20260724005526', 'production_experience_scoped_rollups'),
  ('20260724010343', 'accounting_abstraction_hardening'),
  ('20260724010430', 'accounting_neutral_backfill_completion'),
  ('20260724010554', 'accounting_import_claims_explicit_client_denial'),
  ('20260724015507', 'accounting_drop_compat_views'),
  ('20260724021956', 'accounting_reconnect_identity_rebind'),
  ('20260724130000', 'trustable_device_sessions'),
  ('20260724140000', 'cost_codes_inherit_org_default'),
  ('20260725160004', 'release_notes_releases'),
  ('20260725174233', 'sales_deals_won_stage'),
  ('20260725174553', 'sales_deals_deal_id_filter'),
  ('20260725180000', 'sales_deals'),
  ('20260725190000', 'backlog_incentive_path_fix'),
  ('20260725210000', 'community_operating_unit'),
  ('20260726212804', 'lot_plat_coordinates'),
  ('20260728120000', 'report_runs'),
  ('20260728150000', 'takeoff_conditions'),
  ('20260728150100', 'takeoff_markup_measurements'),
  ('20260729013412', 'create_outreach_tracking_schema'),
  ('20260729023157', 'drop_unused_outreach_is_forward'),
  ('20260729120000', 'takeoff_hardening'),
  ('20260729190000', 'outbox_priority'),
  ('20260729210000', 'portal_tokens_scoped_rfi'),
  ('20260731120000', 'procore_parity_p0'),
  ('20260731130000', 'procore_parity_p1'),
  ('20260731140000', 'procore_parity_p2'),
  ('20260731150001', 'procore_parity_advisor_hardening'),
  ('20260731221030', 'fintech_payment_foundation'),
  ('20260731235000', 'global_external_identities'),
  ('20260801013000', 'payment_fee_policy_admin'),
  ('20260801020000', 'invoice_lines_budget_line_linkage'),
  ('20260801090000', 'portal_tokens_at_rest'),
  ('20260801093000', 'drop_plaintext_tokens'),
  ('20260801133239', 'align_vendor_claim_external_identity'),
  ('20260801143926', 'books_accounting_foundation'),
  ('20260801144429', 'floorplan_models'),
  ('20260801183810', 'floorplan_models_project_anchor'),
  ('20260801184034', 'floorplan_models_project_unique_constraint'),
  ('20260801184150', 'books_service_only_privileges'),
  ('20260801184601', 'bank_account_reconciliation_watermark'),
  ('20260801211117', 'books_workspace_opt_in'),
  ('20260801212527', 'disable_existing_arc_books_workspaces'),
  ('20260802120000', 'vendor_payment_invitations'),
  ('20260802140000', 'bid_access_on_portal_tokens'),
  ('20260803001216', 'vendor_workspace_access'),
  ('20260803001353', 'takeoff_factors_templates'),
  ('20260803120000', 'precon_phase_projects'),
  ('20260803193117', 'payment_run_approver_roster'),
  ('20260804001055', 'payment_run_approver_order'),
  ('20260804005756', 'ap_payment_execution_hardening'),
  ('20260804010200', 'payables_saved_views_and_atomic_approval'),
  ('20260804011500', 'bulk_payable_approval_timestamp_fix'),
  ('20260804090000', 'payment_run_scheduling'),
  ('20260804120000', 'outbox_lease_reaper'),
  ('20260804140000', 'ap_fee_accrual_accounts'),
  ('20260804160000', 'accounting_batch_export'),
  ('20260804180000', 'ap_per_run_fee_collection'),
  ('20260804200000', 'ap_payout_hold_and_loss_controls'),
  ('20260804220000', 'ap_construction_controls'),
  ('20260805090000', 'ap_fee_model_constraint_alignment'),
  ('20260805091000', 'vendor_bill_rejection_lifecycle'),
  ('20260805092000', 'bulk_approval_waiver_parity'),
  ('20260805093000', 'vendor_bill_total_cents_widening'),
  ('20260805094000', 'vendor_bill_company_backfill'),
  ('20260805122729', 'payment_approver_division_scope'),
  ('20260807100000', 'vendor_bill_duplicate_trigger_and_waiver_vocab_cleanup'),
  ('20260807120000', 'books_c1_correctness_core'),
  ('20260807140000', 'ai_usage_events'),
  ('20260807180000', 'job_cost_lifecycle_cleanup'),
  ('20260807190000', 'reconciliation_run_daily_idempotency'),
  ('20260808135139', 'ai_answer_cache_and_standing_questions'),
  ('20260808135256', 'ai_answer_cache_revoke_client_grants'),
  ('20260808150000', 'coding_rule_enum_cleanup'),
  ('20260808160000', 'compliance_documents_metadata'),
  ('20260808170000', 'books_balance_trigger_row_type_fix'),
  ('20260808180000', 'books_bank_rules'),
  ('20260809215830', 'ai_usage_events_error_message'),
  ('20260810134622', 'ap_reversal_run_status_rollup'),
  ('20260810134651', 'dashboard_invoice_rollup_billed_only'),
  ('20260810170000', 'owner_operated_payment_approval'),
  ('20260811120000', 'payment_operations_incident_alerting'),
  ('20260812120508', 'harden_payable_payment_lifecycle'),
  ('20260812120755', 'books_release_hardening'),
  ('20260812124629', 'normalize_payment_permission_domain'),
  ('20260812145420', 'books_reviewer_role'),
  ('20260812145621', 'finish_ap_launch_readiness'),
  ('20260812145624', 'receivables_foundation'),
  ('20260812150201', 'books_sole_ledger_operations'),
  ('20260812152631', 'receivables_books_tax_hardening'),
  ('20260812152902', 'receivables_atomic_revisions'),
  ('20260812160000', 'receivable_adjustments'),
  ('20260812160001', 'remove_speculative_payment_schema'),
  ('20260813000500', 'manual_ap_payment_reversal'),
  ('20260813011630', 'books_post_apply_advisor_hardening'),
  ('20260813011809', 'books_receivables_table_privilege_lockdown'),
  ('20260813011818', 'receivable_adjustments_rls_hardening'),
  ('20260813011917', 'receivable_adjustments_privilege_lockdown'),
  ('20260817090000', 'accounting_invoice_item_safety'),
  ('20260817120000', 'po_completion_line_overlap_guard'),
  ('20260817120100', 'po_generation_serialization'),
  ('20260817120200', 'price_agreement_import_key_unique'),
  ('20260817120300', 'validate_bid_package_award_target'),
  ('20260817150000', 'warranty_operations_hardening'),
  ('20260817170000', 'backlog_report_spec_and_closing_fix'),
  ('20260818120338', 'books_workflow_completeness'),
  ('20260818120515', 'books_workflow_fk_indexes'),
  ('20260818140000', 'prequalification_program'),
  ('20260819120000', 'compliance_system_hardening'),
  ('20260819215425', 'directory_party_roles'),
  ('20260819215549', 'directory_relationship_type_seed_repair'),
  ('20260819215644', 'directory_hygiene'),
  ('20260819215810', 'party_lifecycle_bindings'),
  ('20260819215821', 'compliance_live_document_uniqueness'),
  ('20260819220019', 'party_roles_trigger_not_callable'),
  ('20260820120000', 'directory_role_liveness'),
  ('20260820120100', 'directory_write_permission_grants'),
  ('20260820120200', 'directory_relationship_labels_by_tier'),
  ('20260821122229', 'payment_engine_overpayment_and_ordering'),
  ('20260821130000', 'accounting_sync_attempts'),
  ('20260823140000', 'correspondence_workbench'),
  ('20260824115218', 'lock_down_security_definer_execute'),
  ('20260824120000', 'project_correspondence_slug_is_intrinsic'),
  ('20260825120000', 'photo_records'),
  ('20260826143000', 'explicit_vendor_compliance'),
  ('20260827020317', 'company_compliance_monitoring'),
  ('20260827120000', 'generic_ap_vendor_role'),
  ('20260901120000', 'payment_run_submit_execute_lockdown'),
  ('20260902114730', 'phase_b_money_movement_correctness'),
  ('20260902144509', 'phase_c_run_lifecycle_recoverability'),
  ('20260902180623', 'phase_d_builder_bulk_outcomes'),
  ('20260902180818', 'phase_d_payment_run_outcomes'),
  ('20260902215848', 'phase_e_vendor_side'),
  ('20260902215948', 'remove_legacy_plural_payment_permissions'),
  ('20260903113609', 'phase_g_accounting_sync_truthfulness'),
  ('20260903113824', 'phase_g_accounting_sync_attempt_fk_index'),
  ('20260903120000', 'control_tower_rollup'),
  ('20260903120015', 'phase_f_notifications'),
  ('20260905004132', 'pay_application_integrity'),
  ('20260905004354', 'commercial_sov_atomic_save'),
  ('20260905004943', 'invoice_budget_mapping'),
  ('20260905005511', 'prime_sov_budget_links'),
  ('20260905005700', 'prime_sov_budget_link_policy_commands'),
  ('20260905005800', 'prime_sov_budget_link_fk_indexes');

  select count(*) into v_expected from migration_ledger_expected;
  select count(*) into v_rows from supabase_migrations.schema_migrations;
  select count(*) into v_exact
  from migration_ledger_expected expected
  join supabase_migrations.schema_migrations live
    on live.version = expected.version
   and regexp_replace(coalesce(live.name, ''), '^[0-9]{14}_', '') = expected.name;
  select count(*) into v_duplicate_names from (
    select 1
    from supabase_migrations.schema_migrations
    group by regexp_replace(coalesce(name, ''), '^[0-9]{14}_', '')
    having count(*) > 1
  ) duplicates;
  raise notice 'BEFORE: % ledger rows, %/% canonical versions, % duplicated names',
    v_rows, v_exact, v_expected, v_duplicate_names;

  insert into supabase_migrations.schema_migrations (version, name, statements)
  select expected.version, expected.name, array[]::text[]
  from migration_ledger_expected expected
  on conflict (version) do nothing;
  get diagnostics v_inserted = row_count;

  delete from supabase_migrations.schema_migrations live
  using migration_ledger_expected expected
  where regexp_replace(coalesce(live.name, ''), '^[0-9]{14}_', '') = expected.name
    and live.version <> expected.version;
  get diagnostics v_deleted = row_count;

  -- Historical alias for the canonical books_accounting_foundation migration.
  delete from supabase_migrations.schema_migrations
  where version = '20260801184014'
    and name = 'arc_books_accounting_foundation';

  select count(*) into v_rows from supabase_migrations.schema_migrations;
  select count(*) into v_exact
  from migration_ledger_expected expected
  join supabase_migrations.schema_migrations live
    on live.version = expected.version
   and regexp_replace(coalesce(live.name, ''), '^[0-9]{14}_', '') = expected.name;
  select count(*) into v_missing
  from migration_ledger_expected expected
  left join supabase_migrations.schema_migrations live
    on live.version = expected.version
   and regexp_replace(coalesce(live.name, ''), '^[0-9]{14}_', '') = expected.name
  where live.version is null;
  select count(*) into v_duplicate_names from (
    select 1
    from supabase_migrations.schema_migrations
    group by regexp_replace(coalesce(name, ''), '^[0-9]{14}_', '')
    having count(*) > 1
  ) duplicates;

  raise notice 'AFTER: % ledger rows, %/% canonical versions, % duplicated names (+% inserted, -% superseded)',
    v_rows, v_exact, v_expected, v_duplicate_names, v_inserted, v_deleted;

  if v_missing <> 0 then
    raise exception 'Migration ledger repair left % known-applied repository versions missing', v_missing;
  end if;
  if v_duplicate_names <> 0 then
    raise exception 'Migration ledger repair left % duplicated normalized names', v_duplicate_names;
  end if;

  drop table migration_ledger_expected;
end
$repair$;

-- `pnpm db:ledger:check` reads production through this, so it has to exist
-- before CI can see drift at all.
create or replace function public.list_migration_ledger()
returns table (version text, name text, statements text[])
language sql
security definer
set search_path = ''
as $fn$
  select migration.version, migration.name, migration.statements
  from supabase_migrations.schema_migrations migration
  order by migration.version
$fn$;

revoke all on function public.list_migration_ledger() from public, anon, authenticated;
grant execute on function public.list_migration_ledger() to service_role;

-- After this runs:
--   1. Apply only the ten pending migrations listed in the reconciliation doc,
--      using the Supabase CLI so their repository versions are preserved.
--   2. Run pnpm db:ledger:check with production credentials.
--   3. Run supabase migration list and confirm nothing is local-only or remote-only.
