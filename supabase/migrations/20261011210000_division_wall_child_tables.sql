-- The division wall, on the rows that hang off a walled record.
--
-- 20261011200000 walled every table carrying a project_id, prospect_id, lot_id
-- or community_id. The rows under those records -- pay application lines,
-- estimate items, proposal lines, commitment and invoice lines, bid invites
-- and submissions, meeting attendees, closing checklist items, warranty
-- photos, RFI responses, ... -- name their parent only by its id, and most
-- answered only is_org_member(org_id). A division-limited member read,
-- updated and deleted another division's lines straight through PostgREST.
--
-- This adds ONE restrictive policy, <table>_division_scope, to each table
-- below, for all commands, to authenticated. For each listed reference:
--
--   <fk> is null or exists (select 1 from public.<parent> p where p.id = <fk>)
--
-- The subquery runs as the caller, so it is answered by the parent's own RLS:
-- the org check and the parent's division wall. A child is reachable exactly
-- when its parent is, and an insert or re-parent under an unreachable parent
-- is refused. Grandchildren (bid submissions under invites under packages,
-- mentions under messages under conversations, ...) name their immediate
-- parent, whose new policy then applies in turn. Several references on one
-- table are ANDed. ON DELETE CASCADE is unaffected: referential actions run
-- without row security.
--
-- The list is explicit so it can be reviewed against the schema it is applied
-- to; each table is skipped if it does not exist there. It was built from
-- every public table with RLS enabled, no division policy, and a foreign key to
-- a table that has one, then reviewed by hand. Only the OWNING reference is
-- walled: a child also pointing at a budget line, an attachment file, a portal
-- token, a takeoff condition or an awarded commitment of the same home gains
-- nothing from a second check, and an attachment the caller cannot open (a
-- restricted folder) must not hide the row that cites it.
--
-- No parent's policies read the child back, so no pair recurses; the whole set
-- is planned as authenticated by tests/division-scope-db.test.js.
--
-- Excluded, with the reason:
--   Org books and payment rails, which reconcile as a whole and are written by
--   the service role: bank_receipts, bank_reconciliations, books_tax_filings
--   (statement or evidence file), bank_reconciliation_items,
--   bank_transaction_matches, books_bank_offset_lines (a matched journal line),
--   books_deposit_batch_items (a deposited payment), payment_ledger_transactions,
--   payment_ledger_entries, payment_provider_events,
--   payment_provider_event_attempts, payment_reconciliation_items,
--   platform_fee_events (a disbursement's ledger and provider log).
--   Org-wide records that merely cite a project's row: companies (W9 file),
--   house_plans, house_plan_elevations, house_plan_versions and their lines
--   (cover or source file), import_batches and import_rows (source file),
--   prequalifications and vendor_company_claims (the portal token that
--   delivered them), vendor_tax_readiness (W9 document), payroll_worker_profiles
--   (default classification), qbo_invoice_reservations (the invoice that used
--   a number from the org's pool), and the directory tables reached only
--   through companies and contacts.
--   vendor_document_shares  a cross-org share between a vendor's orgs.
--   onboarding_runs, platform_bugs and its children  as in 20261011200000.
--   project_division_history  its read policy deliberately lets a division
--   read the rows it held after a home moved away.
--
-- Search documents filed on a lead with no home (section 3) now carry the
-- lead's division, as prospect documents do.

set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. Indexes for the owning references that had none (the cascade from the
--    parent, and the parent-scoped reads, use them).
-- ---------------------------------------------------------------------------

create index if not exists coding_rules_budget_line_idx
  on public.coding_rules (budget_line_id) where budget_line_id is not null;
create index if not exists compliance_autopilot_deliveries_document_idx
  on public.compliance_autopilot_deliveries (document_id) where document_id is not null;
create index if not exists esign_delivery_messages_signing_request_idx
  on public.esign_delivery_messages (signing_request_id);
create index if not exists mentions_message_idx
  on public.mentions (message_id);
create index if not exists payment_risk_reviews_disbursement_idx
  on public.payment_risk_reviews (disbursement_id) where disbursement_id is not null;

-- ---------------------------------------------------------------------------
-- 2. The wall.
-- ---------------------------------------------------------------------------

do $$
declare
  scoped record;
begin
  for scoped in
    select t.table_name,
           string_agg(
             format(
               '(%1$I is null or exists (select 1 from public.%2$I p where p.id = %3$I.%1$I))',
               t.fk_column,
               t.parent_table,
               t.table_name
             ),
             ' and ' order by t.fk_column
           ) as predicate
    from (
      values
        -- table, owning reference, parent
        ('accounting_invoice_line_links',         'invoice_id',                  'invoices'),
        ('bid_addenda',                           'bid_package_id',              'bid_packages'),
        ('bid_awards',                            'bid_package_id',              'bid_packages'),
        ('bid_invites',                           'bid_package_id',              'bid_packages'),
        ('bid_pricing_decisions',                 'bid_package_id',              'bid_packages'),
        ('bid_scope_items',                       'bid_package_id',              'bid_packages'),
        ('bid_scope_revisions',                   'bid_package_id',              'bid_packages'),
        ('bid_access_tokens',                     'bid_invite_id',               'bid_invites'),
        ('bid_addendum_acknowledgements',         'bid_invite_id',               'bid_invites'),
        ('bid_portal_drafts',                     'bid_invite_id',               'bid_invites'),
        ('bid_submissions',                       'bid_invite_id',               'bid_invites'),
        ('bid_submission_items',                  'bid_submission_id',           'bid_submissions'),
        ('books_fixed_asset_events',              'asset_id',                    'books_fixed_assets'),
        ('budget_revision_lines',                 'budget_revision_id',          'budget_revisions'),
        ('budget_transfer_lines',                 'transfer_id',                 'budget_transfers'),
        ('catalog_group_publication_receipts',    'group_id',                    'selection_groups'),
        ('catalog_package_publication_receipts',  'package_id',                  'selection_packages'),
        ('catalog_publication_reconciliations',   'group_receipt_id',            'catalog_group_publication_receipts'),
        ('catalog_publication_reconciliations',   'package_receipt_id',          'catalog_package_publication_receipts'),
        ('certified_payroll_lines',               'report_id',                   'certified_payroll_reports'),
        ('change_order_lines',                    'change_order_id',             'change_orders'),
        ('closing_checklist_items',               'closing_id',                  'closings'),
        ('coding_rules',                          'budget_line_id',              'budget_lines'),
        ('commitment_change_order_lines',         'commitment_change_order_id',  'commitment_change_orders'),
        ('commitment_lines',                      'commitment_id',               'commitments'),
        ('commitment_sov_lines',                  'commitment_id',               'commitments'),
        ('compliance_autopilot_deliveries',       'document_id',                 'compliance_documents'),
        ('conversation_read_states',              'conversation_id',             'conversations'),
        ('conversion_run_steps',                  'conversion_run_id',           'conversion_runs'),
        ('doc_versions',                          'file_id',                     'files'),
        ('document_fields',                       'document_id',                 'documents'),
        ('document_packet_items',                 'packet_id',                   'document_packets'),
        ('document_signatures',                   'document_id',                 'documents'),
        ('document_signing_requests',             'document_id',                 'documents'),
        ('document_signing_requests',             'envelope_id',                 'envelopes'),
        ('document_upload_commits',               'file_id',                     'files'),
        ('drawing_markups',                       'drawing_sheet_id',            'drawing_sheets'),
        ('drawing_sheet_versions',                'drawing_sheet_id',            'drawing_sheets'),
        ('envelope_events',                       'envelope_id',                 'envelopes'),
        ('envelope_recipients',                   'envelope_id',                 'envelopes'),
        ('esign_delivery_messages',               'signing_request_id',          'document_signing_requests'),
        ('esign_executions',                      'document_id',                 'documents'),
        ('esign_reminder_deliveries',             'envelope_id',                 'envelopes'),
        ('estimate_comments',                     'estimate_id',                 'estimates'),
        ('estimate_items',                        'estimate_id',                 'estimates'),
        ('estimate_review_links',                 'estimate_id',                 'estimates'),
        ('file_access_events',                    'file_id',                     'files'),
        ('file_share_visits',                     'share_link_id',               'file_share_links'),
        ('floorplan_model_revisions',             'model_id',                    'floorplan_models'),
        ('inspection_attempts',                   'inspection_id',               'inspections'),
        ('inspection_items',                      'inspection_id',               'inspections'),
        ('invoice_approval_requests',             'invoice_id',                  'invoices'),
        ('invoice_deliveries',                    'invoice_id',                  'invoices'),
        ('invoice_lines',                         'invoice_id',                  'invoices'),
        ('invoice_views',                         'invoice_id',                  'invoices'),
        ('late_fee_applications',                 'invoice_id',                  'invoices'),
        ('markup_rules',                          'contract_id',                 'contracts'),
        ('meeting_attendees',                     'meeting_id',                  'meetings'),
        ('messages',                              'conversation_id',             'conversations'),
        ('mentions',                              'message_id',                  'messages'),
        ('pay_application_lines',                 'pay_application_id',          'pay_applications'),
        ('payment_links',                         'invoice_id',                  'invoices'),
        ('payment_risk_reviews',                  'disbursement_id',             'disbursements'),
        ('payment_run_item_payees',               'run_item_id',                 'payment_run_items'),
        ('reminder_deliveries',                   'invoice_id',                  'invoices'),
        ('reminders',                             'invoice_id',                  'invoices'),
        ('report_schedules',                      'saved_config_id',             'saved_report_configs'),
        ('rfi_responses',                         'rfi_id',                      'rfis'),
        ('schedule_item_change_orders',           'change_order_id',             'change_orders'),
        ('schedule_item_change_orders',           'schedule_item_id',            'schedule_items'),
        ('search_embeddings',                     'document_id',                 'search_documents'),
        ('selection_configuration_rules',         'source_option_id',            'selection_options'),
        ('selection_configuration_rules',         'target_option_id',            'selection_options'),
        ('selection_group_categories',            'group_id',                    'selection_groups'),
        ('selection_group_categories',            'category_id',                 'selection_categories'),
        ('selection_package_items',               'package_id',                  'selection_packages'),
        ('selection_package_items',               'option_id',                   'selection_options'),
        ('start_package_gates',                   'start_package_id',            'start_packages'),
        ('start_release_steps',                   'start_package_id',            'start_packages'),
        ('structured_form_responses',             'run_id',                      'structured_form_runs'),
        ('submittal_items',                       'submittal_id',                'submittals'),
        ('submittal_review_steps',                'submittal_id',                'submittals'),
        ('task_assignments',                      'task_id',                     'tasks'),
        ('transmittal_items',                     'transmittal_id',              'transmittals'),
        ('transmittal_recipients',                'transmittal_id',              'transmittals'),
        ('vendor_bill_sov_allocations',           'bill_id',                     'vendor_bills'),
        ('wage_classifications',                  'determination_id',            'wage_determinations'),
        ('warranty_request_photos',               'request_id',                  'warranty_requests'),
        ('warranty_visit_photos',                 'visit_id',                    'warranty_service_visits')
    ) as t(table_name, fk_column, parent_table)
    where to_regclass(format('public.%I', t.table_name)) is not null
      and to_regclass(format('public.%I', t.parent_table)) is not null
    group by t.table_name
  loop
    execute format('drop policy if exists %I on public.%I', scoped.table_name || '_division_scope', scoped.table_name);
    execute format(
      'create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)',
      scoped.table_name || '_division_scope',
      scoped.table_name,
      scoped.predicate,
      scoped.predicate
    );
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 3. Search documents for records filed on a lead.
--
-- An estimate, proposal, file or bid package filed on a lead before there is a
-- home has a prospect_id and no project_id, so its document carried neither a
-- project nor a division and every division found it. It now takes its lead's
-- division exactly as the lead's own document does: the community's division,
-- and null (org-wide) for a lead with no community or a community in no
-- division. Once the record has a home the project scopes it and the division
-- is null again. bid_package joins the project lookup it was missing.
-- ---------------------------------------------------------------------------

comment on column public.search_documents.division_id is
  'Division of a community, lot, prospect or start package document, or of a lead-filed estimate, proposal, file or bid package with no project (its lead''s community''s division), stamped by tg_search_documents_stamp_division and kept current by the follow triggers. Null for every other document, and for a lead with no community or a community in no division.';

create or replace function public.tg_search_documents_stamp_division()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
  v_found boolean;
  v_project_id uuid;
  v_prospect_id uuid;
begin
  new.division_id := case new.entity_type
    when 'community' then (
      select c.division_id from public.communities c where c.org_id = new.org_id and c.id = new.entity_id
    )
    when 'lot' then (
      select l.division_id from public.lots l where l.org_id = new.org_id and l.id = new.entity_id
    )
    when 'prospect' then (
      select c.division_id
      from public.prospects p
      join public.communities c on c.org_id = p.org_id and c.id = p.community_id
      where p.org_id = new.org_id and p.id = new.entity_id
    )
    when 'start_package' then (
      select l.division_id
      from public.start_packages sp
      join public.lots l on l.org_id = sp.org_id and l.id = sp.lot_id
      where sp.org_id = new.org_id and sp.id = new.entity_id
    )
  end;

  v_table := case new.entity_type
    when 'project' then 'projects'
    when 'bid_package' then 'bid_packages'
    when 'budget' then 'budgets'
    when 'budget_transfer' then 'budget_transfers'
    when 'certified_payroll_report' then 'certified_payroll_reports'
    when 'change_event' then 'change_events'
    when 'change_order' then 'change_orders'
    when 'closing' then 'closings'
    when 'commitment' then 'commitments'
    when 'commitment_change_order' then 'commitment_change_orders'
    when 'contract' then 'contracts'
    when 'daily_log' then 'daily_logs'
    when 'design_studio_appointment' then 'design_studio_appointments'
    when 'drawing_set' then 'drawing_sets'
    when 'drawing_sheet' then 'drawing_sheets'
    when 'estimate' then 'estimates'
    when 'expense' then 'project_expenses'
    when 'file' then 'files'
    when 'inspection' then 'inspections'
    when 'invoice' then 'invoices'
    when 'meeting' then 'meetings'
    when 'meeting_transcript' then 'meeting_transcripts'
    when 'observation' then 'observations'
    when 'pay_application' then 'pay_applications'
    when 'payable' then 'vendor_bills'
    when 'photo' then 'photos'
    when 'portal_access' then 'portal_access_tokens'
    when 'project_email' then 'project_emails'
    when 'project_location' then 'project_locations'
    when 'proposal' then 'proposals'
    when 'punch_item' then 'punch_items'
    when 'rfi' then 'rfis'
    when 'safety_incident' then 'safety_incidents'
    when 'schedule_item' then 'schedule_items'
    when 'spec_section' then 'spec_sections'
    when 'start_package' then 'start_packages'
    when 'submittal' then 'submittals'
    when 'takeoff_condition' then 'takeoff_conditions'
    when 'task' then 'tasks'
    when 'transmittal' then 'transmittals'
    when 'warranty_backcharge' then 'warranty_backcharges'
    when 'warranty_request' then 'warranty_requests'
  end;

  if v_table in ('estimates', 'proposals', 'files', 'bid_packages') then
    execute format('select true, t.project_id, t.prospect_id from public.%I t where t.org_id = $1 and t.id = $2', v_table)
    into v_found, v_project_id, v_prospect_id
    using new.org_id, new.entity_id;
    if v_found then
      new.project_id := v_project_id;
      if v_project_id is null and v_prospect_id is not null then
        new.division_id := (
          select c.division_id
          from public.prospects p
          join public.communities c on c.org_id = p.org_id and c.id = p.community_id
          where p.org_id = new.org_id and p.id = v_prospect_id
        );
      elsif v_project_id is null and v_table = 'bid_packages' then
        -- A package bid for a community (no home, no lead) belongs to that
        -- community's division.
        new.division_id := (
          select c.division_id
          from public.bid_packages b
          join public.communities c on c.org_id = b.org_id and c.id = b.community_id
          where b.org_id = new.org_id and b.id = new.entity_id
        );
      end if;
    end if;
  elsif v_table is not null then
    execute format(
      'select true, t.%I from public.%I t where t.org_id = $1 and t.id = $2',
      case when v_table = 'projects' then 'id' else 'project_id' end,
      v_table
    )
    into v_found, v_project_id
    using new.org_id, new.entity_id;
    if v_found then
      new.project_id := v_project_id;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.tg_search_documents_stamp_division() from public, anon, authenticated;

-- The documents of the records filed on the leads in a community: tg_argv is
-- the document type and the record's table.
create or replace function public.tg_search_documents_restamp_lead_records()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  execute format(
    'update public.search_documents d
        set division_id = null
      where d.org_id = $1
        and d.entity_type = $2
        and d.entity_id in (
          select t.id
          from public.%I t
          join public.prospects p on p.org_id = t.org_id and p.id = t.prospect_id
          where t.org_id = $1 and t.project_id is null and p.community_id = $3
        )',
    tg_argv[1]
  )
  using new.org_id, tg_argv[0], new.id;
  return null;
end;
$$;

revoke all on function public.tg_search_documents_restamp_lead_records() from public, anon, authenticated;

do $$
declare
  filed record;
begin
  for filed in
    select *
    from (
      values
        ('estimate', 'estimates'),
        ('proposal', 'proposals'),
        ('file', 'files'),
        ('bid_package', 'bid_packages')
    ) as t(entity_type, table_name)
    where to_regclass(format('public.%I', t.table_name)) is not null
  loop
    -- The record gains a home, or moves to another lead.
    execute format('drop trigger if exists %I on public.%I', filed.table_name || '_search_follow_lead', filed.table_name);
    execute format(
      'create trigger %I
         after update of project_id, prospect_id on public.%I
         for each row
         when (old.project_id is distinct from new.project_id or old.prospect_id is distinct from new.prospect_id)
         execute function public.tg_search_documents_restamp(%L)',
      filed.table_name || '_search_follow_lead',
      filed.table_name,
      filed.entity_type
    );

    -- The lead moves to another community.
    execute format('drop trigger if exists %I on public.prospects', 'prospects_search_follow_community_' || filed.table_name);
    execute format(
      'create trigger %I
         after update of community_id on public.prospects
         for each row
         when (old.community_id is distinct from new.community_id)
         execute function public.tg_search_documents_restamp_children(%L, %L, %L)',
      'prospects_search_follow_community_' || filed.table_name,
      filed.entity_type,
      filed.table_name,
      'prospect_id'
    );

    -- The lead's community moves to another division.
    execute format('drop trigger if exists %I on public.communities', 'communities_search_follow_division_' || filed.table_name);
    execute format(
      'create trigger %I
         after update on public.communities
         for each row
         when (old.division_id is distinct from new.division_id)
         execute function public.tg_search_documents_restamp_lead_records(%L, %L)',
      'communities_search_follow_division_' || filed.table_name,
      filed.entity_type,
      filed.table_name
    );
  end loop;
end
$$;

-- A community-only bid package follows its community: when the package moves to
-- another community, and when that community moves to another division.
create or replace function public.tg_search_documents_restamp_community_packages()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.search_documents d
     set division_id = null
   where d.org_id = new.org_id
     and d.entity_type = 'bid_package'
     and d.entity_id in (
       select b.id from public.bid_packages b
        where b.org_id = new.org_id and b.project_id is null and b.prospect_id is null and b.community_id = new.id
     );
  return null;
end;
$$;

revoke all on function public.tg_search_documents_restamp_community_packages() from public, anon, authenticated;

do $$
begin
  if to_regclass('public.bid_packages') is not null then
    drop trigger if exists communities_search_follow_division_community_packages on public.communities;
    create trigger communities_search_follow_division_community_packages
      after update on public.communities
      for each row
      when (old.division_id is distinct from new.division_id)
      execute function public.tg_search_documents_restamp_community_packages();

    drop trigger if exists bid_packages_search_follow_community on public.bid_packages;
    create trigger bid_packages_search_follow_community
      after update of community_id on public.bid_packages
      for each row
      when (old.community_id is distinct from new.community_id)
      execute function public.tg_search_documents_restamp('bid_package');
  end if;
end
$$;

-- A lead-filed document is scoped like the lead's own: a null division is
-- org-wide, anything else must be a reachable division. Every other document
-- type outside community, lot and start package has a null division.
drop policy if exists search_documents_division_scope on public.search_documents;
create policy search_documents_division_scope on public.search_documents
  as restrictive
  for all
  to authenticated
  using (
    (
      project_id is null
      or org_id = any ((select public.member_unscoped_org_ids())::uuid[])
      or project_id in (select public.member_reachable_project_ids())
    )
    and (
      entity_type not in ('community', 'lot', 'start_package', 'prospect', 'estimate', 'proposal', 'file', 'bid_package')
      or (entity_type in ('prospect', 'estimate', 'proposal', 'file', 'bid_package') and division_id is null)
      or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
      or division_id in (select public.member_reachable_division_ids())
    )
  )
  with check (
    (
      project_id is null
      or org_id = any ((select public.member_unscoped_org_ids())::uuid[])
      or project_id in (select public.member_reachable_project_ids())
    )
    and (
      entity_type not in ('community', 'lot', 'start_package', 'prospect', 'estimate', 'proposal', 'file', 'bid_package')
      or (entity_type in ('prospect', 'estimate', 'proposal', 'file', 'bid_package') and division_id is null)
      or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
      or division_id in (select public.member_reachable_division_ids())
    )
  );

-- Backfill: the stamp trigger fills both columns from the record.
update public.search_documents
   set division_id = null
 where entity_type = 'bid_package'
    or (entity_type in ('estimate', 'proposal', 'file') and project_id is null);
