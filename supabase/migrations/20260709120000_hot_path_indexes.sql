-- Hot-path indexes surfaced by the July 2026 DB access review.
--
-- 1. Queue/feed tables that only had an org_id index despite being the app's
--    highest-churn tables (outbox poller, activity feed, audit views,
--    notification bell) — each was seq-scanning + sorting its full history.
-- 2. project_members lookup used by the is_project_member() RLS helper, which
--    had no index leading with project_id.
-- 3. Unindexed foreign keys on hot tables (advisor findings): entity references
--    used by joins and cascade deletes. Person-reference FKs (created_by,
--    approved_by, ...) are deliberately skipped — users are effectively never
--    deleted and those columns are not join paths.
-- 4. Duplicate index cleanup.

-- 1. Queue / feed / log tables ------------------------------------------------

-- claim_jobs(): WHERE status = 'pending' AND job_type = ANY(..) AND run_at <= now()
-- ORDER BY created_at LIMIT n FOR UPDATE SKIP LOCKED
create index if not exists outbox_pending_claim_idx
  on public.outbox (created_at)
  where status = 'pending';

create index if not exists events_org_channel_created_idx
  on public.events (org_id, channel, created_at desc);
create index if not exists events_org_created_idx
  on public.events (org_id, created_at desc);

create index if not exists audit_log_org_created_idx
  on public.audit_log (org_id, created_at desc);
create index if not exists audit_log_org_entity_idx
  on public.audit_log (org_id, entity_type, entity_id);

create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc);
create index if not exists notifications_user_unread_idx
  on public.notifications (user_id, created_at desc)
  where read_at is null;

-- 2. RLS helper lookup ---------------------------------------------------------

create index if not exists project_members_project_user_idx
  on public.project_members (project_id, user_id);

-- 3. Unindexed foreign keys on hot tables --------------------------------------

create index if not exists bill_lines_project_id_idx on public.bill_lines (project_id);
create index if not exists budget_lines_cost_code_id_idx on public.budget_lines (cost_code_id);
create index if not exists change_orders_contract_id_idx on public.change_orders (contract_id);
create index if not exists commitment_change_orders_commitment_id_idx on public.commitment_change_orders (commitment_id);
create index if not exists commitment_change_orders_company_id_idx on public.commitment_change_orders (company_id);
create index if not exists commitment_change_orders_executed_file_id_idx on public.commitment_change_orders (executed_file_id);
create index if not exists commitment_change_orders_project_id_idx on public.commitment_change_orders (project_id);
create index if not exists commitment_change_orders_signature_envelope_id_idx on public.commitment_change_orders (signature_envelope_id);
create index if not exists commitment_change_orders_source_document_id_idx on public.commitment_change_orders (source_document_id);
create index if not exists commitments_company_id_idx on public.commitments (company_id);
create index if not exists commitments_executed_file_id_idx on public.commitments (executed_file_id);
create index if not exists commitments_signature_envelope_id_idx on public.commitments (signature_envelope_id);
create index if not exists commitments_source_document_id_idx on public.commitments (source_document_id);
create index if not exists companies_relationship_type_id_idx on public.companies (relationship_type_id);
create index if not exists companies_trade_id_idx on public.companies (trade_id);
create index if not exists contacts_primary_company_id_idx on public.contacts (primary_company_id);
create index if not exists contacts_relationship_type_id_idx on public.contacts (relationship_type_id);
create index if not exists decisions_decided_by_contact_id_idx on public.decisions (decided_by_contact_id);
create index if not exists decisions_decision_portal_token_id_idx on public.decisions (decision_portal_token_id);
create index if not exists decisions_notify_contact_id_idx on public.decisions (notify_contact_id);
create index if not exists decisions_project_id_idx on public.decisions (project_id);
create index if not exists estimates_prospect_id_idx on public.estimates (prospect_id);
create index if not exists estimates_recipient_contact_id_idx on public.estimates (recipient_contact_id);
create index if not exists estimates_signature_envelope_id_idx on public.estimates (signature_envelope_id);
create index if not exists files_current_version_id_idx on public.files (current_version_id);
create index if not exists files_prospect_id_idx on public.files (prospect_id);
create index if not exists invoices_file_id_idx on public.invoices (file_id);
create index if not exists invoices_recipient_contact_id_idx on public.invoices (recipient_contact_id);
create index if not exists job_cost_entries_billable_cost_id_idx on public.job_cost_entries (billable_cost_id);
create index if not exists job_cost_entries_budget_line_id_idx on public.job_cost_entries (budget_line_id);
create index if not exists job_cost_entries_cost_code_id_idx on public.job_cost_entries (cost_code_id);
create index if not exists job_cost_entries_invoice_id_idx on public.job_cost_entries (invoice_id);
create index if not exists job_cost_entries_project_id_idx on public.job_cost_entries (project_id);
create index if not exists lien_waivers_bill_id_idx on public.lien_waivers (bill_id);
create index if not exists lien_waivers_company_id_idx on public.lien_waivers (company_id);
create index if not exists lien_waivers_contact_id_idx on public.lien_waivers (contact_id);
create index if not exists lien_waivers_document_file_id_idx on public.lien_waivers (document_file_id);
create index if not exists lien_waivers_signed_file_id_idx on public.lien_waivers (signed_file_id);
create index if not exists memberships_role_id_idx on public.memberships (role_id);
create index if not exists payments_bill_id_idx on public.payments (bill_id);
create index if not exists payments_invoice_id_idx on public.payments (invoice_id);
create index if not exists photos_daily_log_id_idx on public.photos (daily_log_id);
create index if not exists photos_file_id_idx on public.photos (file_id);
create index if not exists photos_task_id_idx on public.photos (task_id);
create index if not exists project_billing_periods_project_id_idx on public.project_billing_periods (project_id);
create index if not exists project_expenses_billable_cost_id_idx on public.project_expenses (billable_cost_id);
create index if not exists project_expenses_cost_code_id_idx on public.project_expenses (cost_code_id);
create index if not exists project_expenses_receipt_file_id_idx on public.project_expenses (receipt_file_id);
create index if not exists project_expenses_vendor_company_id_idx on public.project_expenses (vendor_company_id);
create index if not exists proposals_estimate_id_idx on public.proposals (estimate_id);
create index if not exists proposals_prospect_id_idx on public.proposals (prospect_id);
create index if not exists proposals_recipient_contact_id_idx on public.proposals (recipient_contact_id);
create index if not exists punch_items_file_id_idx on public.punch_items (file_id);
create index if not exists punch_items_portal_token_id_idx on public.punch_items (portal_token_id);
create index if not exists punch_items_schedule_item_id_idx on public.punch_items (schedule_item_id);
create index if not exists rfi_responses_file_id_idx on public.rfi_responses (file_id);
create index if not exists rfi_responses_org_id_idx on public.rfi_responses (org_id);
create index if not exists rfi_responses_portal_token_id_idx on public.rfi_responses (portal_token_id);
create index if not exists rfi_responses_responder_contact_id_idx on public.rfi_responses (responder_contact_id);
create index if not exists rfis_attachment_file_id_idx on public.rfis (attachment_file_id);
create index if not exists rfis_bid_package_id_idx on public.rfis (bid_package_id);
create index if not exists rfis_decided_by_contact_id_idx on public.rfis (decided_by_contact_id);
create index if not exists rfis_decision_portal_token_id_idx on public.rfis (decision_portal_token_id);
create index if not exists rfis_submitted_by_company_id_idx on public.rfis (submitted_by_company_id);
create index if not exists submittal_items_file_id_idx on public.submittal_items (file_id);
create index if not exists submittal_items_org_id_idx on public.submittal_items (org_id);
create index if not exists submittal_items_portal_token_id_idx on public.submittal_items (portal_token_id);
create index if not exists submittal_items_responder_contact_id_idx on public.submittal_items (responder_contact_id);
create index if not exists submittals_attachment_file_id_idx on public.submittals (attachment_file_id);
create index if not exists submittals_decision_by_contact_id_idx on public.submittals (decision_by_contact_id);
create index if not exists submittals_decision_portal_token_id_idx on public.submittals (decision_portal_token_id);
create index if not exists submittals_submitted_by_company_id_idx on public.submittals (submitted_by_company_id);
create index if not exists submittals_submitted_by_contact_id_idx on public.submittals (submitted_by_contact_id);
create index if not exists submittals_superseded_by_id_idx on public.submittals (superseded_by_id);
create index if not exists submittals_supersedes_submittal_id_idx on public.submittals (supersedes_submittal_id);
create index if not exists time_entries_billable_cost_id_idx on public.time_entries (billable_cost_id);
create index if not exists time_entries_cost_code_id_idx on public.time_entries (cost_code_id);
create index if not exists time_entries_worker_company_id_idx on public.time_entries (worker_company_id);
create index if not exists tm_tickets_backup_file_id_idx on public.tm_tickets (backup_file_id);
create index if not exists tm_tickets_contract_id_idx on public.tm_tickets (contract_id);
create index if not exists tm_tickets_invoice_id_idx on public.tm_tickets (invoice_id);
create index if not exists tm_tickets_project_id_idx on public.tm_tickets (project_id);
create index if not exists vendor_bills_commitment_id_idx on public.vendor_bills (commitment_id);
create index if not exists vendor_bills_company_id_idx on public.vendor_bills (company_id);
create index if not exists vendor_bills_file_id_idx on public.vendor_bills (file_id);
create index if not exists vendor_bills_submitted_by_contact_id_idx on public.vendor_bills (submitted_by_contact_id);

-- 4. Duplicate index cleanup ---------------------------------------------------

-- invoices_token_key and invoices_token_uq are identical; keep _key.
drop index if exists public.invoices_token_uq;
