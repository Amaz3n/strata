-- Arc Trade packaging and crew roles (Arc Trade readiness TR01-05, TR01-07).
--
-- 1. The Arc Trade plan. Its plan_feature_limits are what syncOrgEntitlementsFromPlan
--    copies into `entitlements`, and lib/services/workspace-surface.ts is the one
--    reader that turns those rows into what the workspace refuses. The price is a
--    placeholder below the builder plans; set the real price and Stripe price id in
--    Platform → Subscription plans before selling it.
-- 2. `time.approve`: approving crew time is a field lead's call, separate from
--    approving vendor bills. Every role that approves bills today (and so approves
--    time today, through bill.approve) receives it, so no one loses an approval.
-- 3. Two org roles a trade company needs and a builder can use too: Foreman and
--    Crew member. Neither holds project.read, so both see only the jobs they are
--    assigned to through project membership. Owners and office admins keep the
--    existing org_owner and org_office_admin roles.

begin;

-- The feature catalog mirrors BILLING_FEATURE_CATALOG (lib/billing-feature-catalog.ts).
-- syncBillingFeatureCatalog keeps it current at runtime; a database rebuilt from
-- migrations needs the rows before any plan can reference them.
insert into public.plan_features (feature_key, name, category, description) values
  ('projects', 'Projects', 'Core', 'Project workspaces, contacts, milestones, and overview tracking.'),
  ('schedule', 'Scheduling', 'Operations', 'Schedules, lookaheads, assignments, and schedule reporting.'),
  ('daily_logs', 'Daily Logs', 'Operations', 'Field daily logs, photos, weather, labor, and notes.'),
  ('files_drawings', 'Files & Drawings', 'Documents', 'Project files, drawing sets, versions, markups, and sharing.'),
  ('client_portal', 'Client Portal', 'Client Experience', 'Client-facing portal access for selections, invoices, files, and updates.'),
  ('rfis_submittals', 'RFIs & Submittals', 'Project Controls', 'RFI and submittal workflows with portal collaboration.'),
  ('bids_proposals', 'Bids & Proposals', 'Preconstruction', 'Bid packages, proposals, pipeline, and preconstruction workflows.'),
  ('financials_ar', 'Receivables', 'Financials', 'Client invoices, payments, draws, retainage, and AR reporting.'),
  ('financials_ap', 'Payables', 'Financials', 'Commitments, vendor bills, payments, lien waivers, and AP reporting.'),
  ('change_orders', 'Change Orders', 'Financials', 'Change order requests, approvals, pricing, and logs.'),
  ('selections', 'Selections', 'Client Experience', 'Selection sheets, client choices, allowances, and approvals.'),
  ('closeout_warranty', 'Closeout & Warranty', 'Client Experience', 'Closeout packets, punch lists, warranty requests, and handoff tracking.'),
  ('qbo', 'QuickBooks', 'Integrations', 'QuickBooks connection, sync, and accounting workflows.'),
  ('esign', 'E-signatures', 'Integrations', 'Document packets, signature envelopes, and executed-file tracking.'),
  ('ai_search', 'AI Search', 'AI', 'AI search, summaries, action assistance, and cross-record querying.'),
  ('cost_plus', 'Cost Plus', 'Financials', 'Cost-plus billing, markup rules, time, expenses, and client billing packages.')
on conflict (feature_key) do nothing;

insert into public.plans (code, name, pricing_model, interval, amount_cents, currency, is_active, metadata)
values (
  'trade', 'Arc Trade', 'subscription', 'monthly', 14900, 'usd', true,
  '{"public_name": "Arc Trade", "package_type": "trade", "business_kind": "trade", "description": "Jobs, crew time, billing and payables for specialty contractors."}'::jsonb
)
on conflict (code) do update
  set name = excluded.name,
      metadata = public.plans.metadata || excluded.metadata;

insert into public.plan_feature_limits (plan_code, feature_key, limit_type, limit_value, metadata)
select 'trade', feature_key, 'enabled', 1, '{}'::jsonb
from unnest(array[
  'projects', 'schedule', 'daily_logs', 'files_drawings', 'client_portal', 'rfis_submittals',
  'bids_proposals', 'financials_ar', 'financials_ap', 'change_orders', 'qbo', 'esign',
  'ai_search', 'cost_plus'
]) as feature(feature_key)
on conflict (plan_code, feature_key, limit_type) do nothing;

insert into public.permissions (key, description) values
  ('time.approve', 'Approve or reject crew time entries')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select rp.role_id, 'time.approve' from public.role_permissions rp where rp.permission_key = 'bill.approve'
on conflict (role_id, permission_key) do nothing;

insert into public.roles (key, label, scope, description) values
  ('org_foreman', 'Foreman', 'org', 'Runs crews on assigned jobs: schedules work, keeps logs and punch, and approves crew time. No billing, payables or directory changes.'),
  ('org_crew_member', 'Crew member', 'org', 'Works assigned jobs: logs own time, reads the schedule and drawings, and keeps daily logs and punch. No billing, payables or directory access.')
on conflict (key) do update set label = excluded.label, scope = excluded.scope, description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array[
  'org.member', 'time.read', 'time.write', 'schedule.read', 'daily_log.read', 'daily_log.write',
  'docs.read', 'docs.download', 'docs.upload', 'drawing.read', 'punch.read', 'punch.write',
  'message.read', 'message.write'
]) as p(permission_key)
where r.key in ('org_foreman', 'org_crew_member')
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array[
  'time.approve', 'schedule.edit', 'daily_log.approve', 'punch.close', 'drawing.markup',
  'change_order.read', 'directory.read'
]) as p(permission_key)
where r.key = 'org_foreman'
on conflict (role_id, permission_key) do nothing;

-- Project seats for trade crew. The project role `field` also holds schedule.edit,
-- rfi.write, correspondence and submittal writes, which a crew member on a job should
-- not have. `crew` is exactly what a crew member needs on an assigned job (their own
-- time, the schedule, drawings and files, daily logs and punch); `foreman` adds
-- crew time approval (time.manage follows from time.write in the next migration), schedule edits and log approval.
insert into public.roles (key, label, scope, description) values
  ('crew', 'Crew', 'project', 'Works the job: logs own time, reads the schedule and drawings, keeps daily logs and punch.'),
  ('foreman', 'Foreman', 'project', 'Runs the crew on the job: approves and manages crew time, edits the schedule, approves logs and closes punch.')
on conflict (key) do update set label = excluded.label, scope = excluded.scope, description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array[
  'project.read', 'time.read', 'time.write', 'schedule.read', 'daily_log.read', 'daily_log.write',
  'docs.read', 'docs.download', 'docs.upload', 'drawing.read', 'punch.read', 'punch.write'
]) as p(permission_key)
where r.key in ('crew', 'foreman') and r.scope = 'project'
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array[
  'time.approve', 'schedule.edit', 'daily_log.approve', 'punch.close', 'drawing.markup'
]) as p(permission_key)
where r.key = 'foreman' and r.scope = 'project'
on conflict (role_id, permission_key) do nothing;

commit;
