-- Enable RLS on all tenant tables
alter table app_users enable row level security;
alter table orgs enable row level security;
alter table org_settings enable row level security;
alter table roles enable row level security;
alter table permissions enable row level security;
alter table role_permissions enable row level security;
alter table memberships enable row level security;
alter table projects enable row level security;
alter table project_members enable row level security;
alter table project_settings enable row level security;
alter table feature_flags enable row level security;
alter table plans enable row level security;
alter table plan_features enable row level security;
alter table plan_feature_limits enable row level security;
alter table subscriptions enable row level security;
alter table entitlements enable row level security;
alter table licenses enable row level security;
alter table support_contracts enable row level security;
alter table change_requests enable row level security;
alter table companies enable row level security;
alter table contacts enable row level security;
alter table contact_company_links enable row level security;
alter table files enable row level security;
alter table file_links enable row level security;
alter table doc_versions enable row level security;
alter table tasks enable row level security;
alter table task_assignments enable row level security;
alter table schedule_items enable row level security;
alter table schedule_dependencies enable row level security;
alter table daily_logs enable row level security;
alter table daily_log_entries enable row level security;
alter table photos enable row level security;
alter table punch_items enable row level security;
alter table approvals enable row level security;
alter table cost_codes enable row level security;
alter table estimates enable row level security;
alter table estimate_items enable row level security;
alter table proposals enable row level security;
alter table contracts enable row level security;
alter table change_orders enable row level security;
alter table change_order_lines enable row level security;
alter table budgets enable row level security;
alter table budget_lines enable row level security;
alter table commitments enable row level security;
alter table commitment_lines enable row level security;
alter table vendor_bills enable row level security;
alter table bill_lines enable row level security;
alter table invoices enable row level security;
alter table invoice_lines enable row level security;
alter table payments enable row level security;
alter table receipts enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table mentions enable row level security;
alter table notifications enable row level security;
alter table notification_deliveries enable row level security;
alter table custom_fields enable row level security;
alter table custom_field_values enable row level security;
alter table form_templates enable row level security;
alter table form_instances enable row level security;
alter table form_responses enable row level security;
alter table workflows enable row level security;
alter table workflow_runs enable row level security;
alter table audit_log enable row level security;
alter table events enable row level security;
alter table outbox enable row level security;

-- Policies
create policy "app_users_owner_access" on app_users for select using (auth.role() = 'service_role' or id = auth.uid());
create policy "app_users_self_update" on app_users for update using (auth.role() = 'service_role' or id = auth.uid());

create policy "orgs_access" on orgs for all using (auth.role() = 'service_role' or is_org_member(id)) with check (auth.role() = 'service_role' or auth.uid() is not null);
create policy "org_settings_access" on org_settings for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "roles_access" on roles for all using (auth.role() = 'service_role');
create policy "permissions_access" on permissions for select using (true);
create policy "role_permissions_access" on role_permissions for all using (auth.role() = 'service_role');

create policy "memberships_access" on memberships for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "projects_access" on projects for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "project_members_access" on project_members for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "project_settings_access" on project_settings for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "feature_flags_access" on feature_flags for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "plans_read" on plans for select using (true);
create policy "plan_features_read" on plan_features for select using (true);
create policy "plan_feature_limits_read" on plan_feature_limits for select using (true);
create policy "subscriptions_access" on subscriptions for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "entitlements_access" on entitlements for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "licenses_access" on licenses for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "support_contracts_access" on support_contracts for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "change_requests_access" on change_requests for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "companies_access" on companies for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "contacts_access" on contacts for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "contact_company_links_access" on contact_company_links for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "files_access" on files for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "file_links_access" on file_links for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "doc_versions_access" on doc_versions for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "tasks_access" on tasks for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "task_assignments_access" on task_assignments for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "schedule_items_access" on schedule_items for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "schedule_dependencies_access" on schedule_dependencies for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "daily_logs_access" on daily_logs for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "daily_log_entries_access" on daily_log_entries for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "photos_access" on photos for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "punch_items_access" on punch_items for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "approvals_access" on approvals for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "cost_codes_access" on cost_codes for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "estimates_access" on estimates for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "estimate_items_access" on estimate_items for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "proposals_access" on proposals for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "contracts_access" on contracts for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "change_orders_access" on change_orders for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "change_order_lines_access" on change_order_lines for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "budgets_access" on budgets for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "budget_lines_access" on budget_lines for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "commitments_access" on commitments for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "commitment_lines_access" on commitment_lines for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "vendor_bills_access" on vendor_bills for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "bill_lines_access" on bill_lines for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "invoices_access" on invoices for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "invoice_lines_access" on invoice_lines for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "payments_access" on payments for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "receipts_access" on receipts for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "conversations_access" on conversations for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "messages_access" on messages for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "mentions_access" on mentions for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "notifications_access" on notifications for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "notification_deliveries_access" on notification_deliveries for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "custom_fields_access" on custom_fields for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "custom_field_values_access" on custom_field_values for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "form_templates_access" on form_templates for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "form_instances_access" on form_instances for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "form_responses_access" on form_responses for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "workflows_access" on workflows for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "workflow_runs_access" on workflow_runs for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy "audit_log_read" on audit_log for select using (auth.role() = 'service_role' or is_org_member(org_id));
create policy "events_access" on events for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
create policy "outbox_access" on outbox for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));

-- Seed permissions/roles and mappings
insert into permissions (key, description) values
  ('org.admin','Full org administration'),
  ('org.member','Standard org access'),
  ('org.read','Read-only org access'),
  ('project.manage','Create and manage projects'),
  ('project.read','Read projects'),
  ('billing.manage','Manage billing and subscriptions'),
  ('audit.read','Read audit logs'),
  ('features.manage','Manage feature flags'),
  ('members.manage','Manage org memberships')
on conflict do nothing;

insert into roles (key,label,scope,description) values
  ('owner','Owner','org','Org owner with full permissions'),
  ('admin','Admin','org','Org admin'),
  ('staff','Staff','org','Standard staff role'),
  ('readonly','Read-only','org','Read-only org member'),
  ('pm','Project Manager','project','Project-level manager'),
  ('field','Field','project','Field user'),
  ('client','Client','project','Client portal role')
on conflict (key) do nothing;

insert into role_permissions (role_id, permission_key)
select r.id, perms.permission_key
from roles r
join lateral (
  select unnest(
    case r.key
      when 'owner' then array['org.admin','org.member','org.read','project.manage','project.read','billing.manage','audit.read','features.manage','members.manage']::text[]
      when 'admin' then array['org.member','org.read','project.manage','project.read','billing.manage','features.manage','members.manage']::text[]
      when 'staff' then array['org.member','org.read','project.read']::text[]
      when 'readonly' then array['org.read','project.read']::text[]
      else array[]::text[]
    end
  ) as permission_key
) perms on true
where r.scope='org' and perms.permission_key is not null
on conflict do nothing;;
