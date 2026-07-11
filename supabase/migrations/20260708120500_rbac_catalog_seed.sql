-- RBAC catalog seed  SOURCE OF TRUTH for roles, permissions, and role_permissions.
-- Generated from the production catalog; idempotent (safe to re-run). Any change to
-- who-can-do-what belongs HERE, not applied ad hoc against the database.
-- Rebuilding a DB from migrations now yields a correct, complete RBAC catalog.

begin;

-- 1. Permission catalog
insert into permissions (key, description) values
  ('audit.export', 'Export audit logs'),
  ('audit.read', 'Read audit logs'),
  ('authz.policy.manage', 'Manage authorization policies and overrides'),
  ('bid.read', 'View bid packages'),
  ('bid.write', 'Create and manage bid packages'),
  ('bill.approve', 'Approve vendor bills'),
  ('bill.read', 'View vendor bills'),
  ('bill.write', 'Create and edit vendor bills'),
  ('billing.manage', 'Manage billing and subscriptions'),
  ('budget.lock', 'Lock budget versions'),
  ('budget.approve', 'Approve and post budget transfers'),
  ('budget.read', 'View project budgets'),
  ('budget.write', 'Create and edit project budgets'),
  ('change_order.approve', 'Approve change orders'),
  ('change_order.read', 'View change orders'),
  ('change_order.write', 'Create and edit change orders'),
  ('closeout.read', 'View closeout items'),
  ('closeout.write', 'Create and update closeout items'),
  ('commitment.approve', 'Approve commitments'),
  ('commitment.read', 'View commitments'),
  ('commitment.write', 'Create and edit commitments'),
  ('daily_log.approve', 'Approve daily logs'),
  ('daily_log.read', 'View daily logs'),
  ('daily_log.write', 'Create and edit daily logs'),
  ('decision.read', 'View decisions'),
  ('decision.write', 'Create and update decisions'),
  ('directory.read', 'View directory companies and contacts'),
  ('directory.write', 'Create and update directory companies and contacts'),
  ('docs.delete', 'Delete or archive project documents'),
  ('docs.download', 'Download project documents'),
  ('docs.read', 'View project documents'),
  ('docs.share', 'Manage sharing on project documents'),
  ('docs.upload', 'Upload project documents'),
  ('draw.approve', 'Approve draw requests'),
  ('draw.read', 'View draw schedules and requests'),
  ('drawing.markup', 'Create drawing markups and linked field items'),
  ('drawing.read', 'View drawing sets and sheets'),
  ('drawing.upload', 'Upload drawing sets and sheets'),
  ('features.manage', 'Manage feature flags'),
  ('financials.margin.read', 'View project and company profit margins'),
  ('impersonation.end', 'End or revoke impersonation sessions'),
  ('impersonation.start', 'Start user impersonation sessions'),
  ('invoice.approve', 'Approve invoices'),
  ('invoice.read', 'View invoices'),
  ('invoice.send', 'Send invoices to recipients'),
  ('invoice.write', 'Create and edit invoices'),
  ('members.manage', 'Manage org memberships'),
  ('meeting.write', 'Create, edit, and finalize project meeting minutes'),
  ('message.read', 'View internal project and workspace messages'),
  ('message.write', 'Send internal project and workspace messages'),
  ('org.admin', 'Full org administration'),
  ('org.member', 'Standard org access'),
  ('org.read', 'Read-only org access'),
  ('org.settings.read', 'View organization settings'),
  ('org.settings.update', 'Update organization settings'),
  ('payment.read', 'View payment records'),
  ('payment.release', 'Release payments'),
  ('pipeline.read', 'View pipeline and CRM records'),
  ('pipeline.write', 'Create and update pipeline and CRM records'),
  ('platform.billing.manage', 'Manage billing across organizations from platform context'),
  ('platform.feature_flags.manage', 'Manage feature flags from platform context'),
  ('platform.org.access', 'Enter tenant org context from platform console'),
  ('platform.org.read', 'View tenant organizations from platform context'),
  ('platform.support.read', 'Read support diagnostics across organizations'),
  ('platform.support.write', 'Run support write operations across organizations'),
  ('portal.access.manage', 'Manage portal access and tokens'),
  ('project.archive', 'Archive or unarchive projects'),
  ('project.create', 'Create projects'),
  ('project.manage', 'Create and manage projects'),
  ('project.read', 'Read projects'),
  ('project.settings.read', 'View project settings'),
  ('project.settings.update', 'Update project settings'),
  ('proposal.read', 'View proposals'),
  ('proposal.write', 'Create and manage proposals'),
  ('prequal.review', 'Review and approve subcontractor prequalifications'),
  ('punch.close', 'Close punch items'),
  ('punch.read', 'View punch items'),
  ('punch.write', 'Create and update punch items'),
  ('report.read', 'View reports'),
  ('retainage.manage', 'Manage retainage configuration and release'),
  ('rfi.close', 'Close RFIs'),
  ('rfi.read', 'View RFIs'),
  ('rfi.respond', 'Respond to RFIs'),
  ('rfi.write', 'Create and edit RFIs'),
  ('safety.read', 'View safety incidents and investigation details'),
  ('safety.write', 'Record safety incidents, toolbox talks, and observations'),
  ('schedule.baseline.manage', 'Manage schedule baselines'),
  ('schedule.edit', 'Edit project schedule'),
  ('schedule.publish', 'Publish schedule updates'),
  ('schedule.read', 'View project schedule'),
  ('signature.read', 'View signature documents and envelopes'),
  ('signature.send', 'Prepare and send signature requests'),
  ('submittal.approve', 'Approve submittals'),
  ('submittal.read', 'View submittals'),
  ('submittal.review', 'Review submittals'),
  ('submittal.write', 'Create and edit submittals'),
  ('team.invite', 'Invite organization members'),
  ('team.mfa.reset', 'Reset member MFA factors'),
  ('team.remove', 'Remove organization members'),
  ('team.role.assign', 'Assign org or project roles'),
  ('time.read', 'View project time entries'),
  ('time.write', 'Create and edit project time entries'),
  ('transmittal.write', 'Create and send project transmittals'),
  ('warranty.read', 'View warranty items'),
  ('warranty.write', 'Create and update warranty items')
on conflict (key) do update set description = excluded.description;

-- 2. Roles
insert into roles (key, label, scope, description) values
  ('org_admin', 'Admin', 'org', 'Full company access, including settings, billing, team, all projects, approvals, and financial workflows.'),
  ('org_bookkeeper', 'Bookkeeper', 'org', 'Accounts payable/receivable. Enters bills and invoices and runs reports, but cannot approve payments or release funds (separation of duties).'),
  ('org_estimator', 'Estimator', 'org', 'Preconstruction. Owns bids, proposals, and the sales pipeline. No access to active-job financials.'),
  ('org_office_admin', 'Office Admin', 'org', 'Administrative control across projects, members, and business operations.'),
  ('org_owner', 'Org Owner', 'org', 'Organization owner with full tenant control'),
  ('org_project_lead', 'Project Lead', 'org', 'Execution-focused role for project delivery, field workflows, and day-to-day coordination.'),
  ('org_user', 'User', 'org', 'Internal team member. Access is scoped by project assignments and optional permission overrides.'),
  ('org_viewer', 'Viewer', 'org', 'Read-only visibility role for stakeholders and observers.'),
  ('platform_admin', 'Platform Admin', 'platform', 'Platform operations and support administrator'),
  ('platform_billing_ops', 'Platform Billing Ops', 'platform', 'Platform billing operations'),
  ('platform_security_auditor', 'Platform Security Auditor', 'platform', 'Platform security and audit role'),
  ('platform_super_admin', 'Platform Super Admin', 'platform', 'Break-glass platform administrator'),
  ('platform_support_readonly', 'Platform Support Readonly', 'platform', 'Read-only platform support role'),
  ('field', 'Field', 'project', 'Field user'),
  ('pm', 'Project Manager', 'project', 'Project-level manager')
on conflict (key) do update set label = excluded.label, scope = excluded.scope, description = excluded.description;

-- 3. Role -> permission grants (declarative desired set)
insert into role_permissions (role_id, permission_key)
  select id, 'daily_log.read' from roles where key = 'field'
union all
  select id, 'daily_log.write' from roles where key = 'field'
union all
  select id, 'docs.download' from roles where key = 'field'
union all
  select id, 'docs.read' from roles where key = 'field'
union all
  select id, 'docs.upload' from roles where key = 'field'
union all
  select id, 'project.read' from roles where key = 'field'
union all
  select id, 'report.read' from roles where key = 'field'
union all
  select id, 'rfi.read' from roles where key = 'field'
union all
  select id, 'rfi.respond' from roles where key = 'field'
union all
  select id, 'rfi.write' from roles where key = 'field'
union all
  select id, 'schedule.edit' from roles where key = 'field'
union all
  select id, 'schedule.read' from roles where key = 'field'
union all
  select id, 'submittal.read' from roles where key = 'field'
union all
  select id, 'submittal.write' from roles where key = 'field'
union all
  select id, 'time.read' from roles where key = 'field'
union all
  select id, 'time.write' from roles where key = 'field'
union all
  select id, 'audit.read' from roles where key = 'org_admin'
union all
  select id, 'bid.read' from roles where key = 'org_admin'
union all
  select id, 'bid.write' from roles where key = 'org_admin'
union all
  select id, 'bill.approve' from roles where key = 'org_admin'
union all
  select id, 'bill.read' from roles where key = 'org_admin'
union all
  select id, 'bill.write' from roles where key = 'org_admin'
union all
  select id, 'billing.manage' from roles where key = 'org_admin'
union all
  select id, 'budget.lock' from roles where key = 'org_admin'
union all
  select id, 'budget.read' from roles where key = 'org_admin'
union all
  select id, 'budget.write' from roles where key = 'org_admin'
union all
  select id, 'change_order.approve' from roles where key = 'org_admin'
union all
  select id, 'change_order.read' from roles where key = 'org_admin'
union all
  select id, 'change_order.write' from roles where key = 'org_admin'
union all
  select id, 'closeout.read' from roles where key = 'org_admin'
union all
  select id, 'closeout.write' from roles where key = 'org_admin'
union all
  select id, 'commitment.approve' from roles where key = 'org_admin'
union all
  select id, 'commitment.read' from roles where key = 'org_admin'
union all
  select id, 'commitment.write' from roles where key = 'org_admin'
union all
  select id, 'daily_log.approve' from roles where key = 'org_admin'
union all
  select id, 'daily_log.read' from roles where key = 'org_admin'
union all
  select id, 'daily_log.write' from roles where key = 'org_admin'
union all
  select id, 'decision.read' from roles where key = 'org_admin'
union all
  select id, 'decision.write' from roles where key = 'org_admin'
union all
  select id, 'directory.read' from roles where key = 'org_admin'
union all
  select id, 'directory.write' from roles where key = 'org_admin'
union all
  select id, 'docs.delete' from roles where key = 'org_admin'
union all
  select id, 'docs.download' from roles where key = 'org_admin'
union all
  select id, 'docs.read' from roles where key = 'org_admin'
union all
  select id, 'docs.share' from roles where key = 'org_admin'
union all
  select id, 'docs.upload' from roles where key = 'org_admin'
union all
  select id, 'draw.approve' from roles where key = 'org_admin'
union all
  select id, 'draw.read' from roles where key = 'org_admin'
union all
  select id, 'drawing.markup' from roles where key = 'org_admin'
union all
  select id, 'drawing.read' from roles where key = 'org_admin'
union all
  select id, 'drawing.upload' from roles where key = 'org_admin'
union all
  select id, 'features.manage' from roles where key = 'org_admin'
union all
  select id, 'financials.margin.read' from roles where key = 'org_admin'
union all
  select id, 'invoice.approve' from roles where key = 'org_admin'
union all
  select id, 'invoice.read' from roles where key = 'org_admin'
union all
  select id, 'invoice.send' from roles where key = 'org_admin'
union all
  select id, 'invoice.write' from roles where key = 'org_admin'
union all
  select id, 'members.manage' from roles where key = 'org_admin'
union all
  select id, 'message.read' from roles where key = 'org_admin'
union all
  select id, 'message.write' from roles where key = 'org_admin'
union all
  select id, 'org.admin' from roles where key = 'org_admin'
union all
  select id, 'org.member' from roles where key = 'org_admin'
union all
  select id, 'org.read' from roles where key = 'org_admin'
union all
  select id, 'payment.read' from roles where key = 'org_admin'
union all
  select id, 'payment.release' from roles where key = 'org_admin'
union all
  select id, 'pipeline.read' from roles where key = 'org_admin'
union all
  select id, 'pipeline.write' from roles where key = 'org_admin'
union all
  select id, 'portal.access.manage' from roles where key = 'org_admin'
union all
  select id, 'project.archive' from roles where key = 'org_admin'
union all
  select id, 'project.create' from roles where key = 'org_admin'
union all
  select id, 'project.manage' from roles where key = 'org_admin'
union all
  select id, 'project.read' from roles where key = 'org_admin'
union all
  select id, 'project.settings.read' from roles where key = 'org_admin'
union all
  select id, 'project.settings.update' from roles where key = 'org_admin'
union all
  select id, 'proposal.read' from roles where key = 'org_admin'
union all
  select id, 'proposal.write' from roles where key = 'org_admin'
union all
  select id, 'punch.close' from roles where key = 'org_admin'
union all
  select id, 'punch.read' from roles where key = 'org_admin'
union all
  select id, 'punch.write' from roles where key = 'org_admin'
union all
  select id, 'report.read' from roles where key = 'org_admin'
union all
  select id, 'retainage.manage' from roles where key = 'org_admin'
union all
  select id, 'rfi.close' from roles where key = 'org_admin'
union all
  select id, 'rfi.read' from roles where key = 'org_admin'
union all
  select id, 'rfi.respond' from roles where key = 'org_admin'
union all
  select id, 'rfi.write' from roles where key = 'org_admin'
union all
  select id, 'schedule.baseline.manage' from roles where key = 'org_admin'
union all
  select id, 'schedule.edit' from roles where key = 'org_admin'
union all
  select id, 'schedule.publish' from roles where key = 'org_admin'
union all
  select id, 'schedule.read' from roles where key = 'org_admin'
union all
  select id, 'signature.read' from roles where key = 'org_admin'
union all
  select id, 'signature.send' from roles where key = 'org_admin'
union all
  select id, 'submittal.approve' from roles where key = 'org_admin'
union all
  select id, 'submittal.read' from roles where key = 'org_admin'
union all
  select id, 'submittal.review' from roles where key = 'org_admin'
union all
  select id, 'submittal.write' from roles where key = 'org_admin'
union all
  select id, 'time.read' from roles where key = 'org_admin'
union all
  select id, 'time.write' from roles where key = 'org_admin'
union all
  select id, 'warranty.read' from roles where key = 'org_admin'
union all
  select id, 'warranty.write' from roles where key = 'org_admin'
union all
  select id, 'bill.read' from roles where key = 'org_bookkeeper'
union all
  select id, 'bill.write' from roles where key = 'org_bookkeeper'
union all
  select id, 'budget.read' from roles where key = 'org_bookkeeper'
union all
  select id, 'commitment.read' from roles where key = 'org_bookkeeper'
union all
  select id, 'directory.read' from roles where key = 'org_bookkeeper'
union all
  select id, 'directory.write' from roles where key = 'org_bookkeeper'
union all
  select id, 'docs.download' from roles where key = 'org_bookkeeper'
union all
  select id, 'docs.read' from roles where key = 'org_bookkeeper'
union all
  select id, 'draw.read' from roles where key = 'org_bookkeeper'
union all
  select id, 'invoice.read' from roles where key = 'org_bookkeeper'
union all
  select id, 'invoice.send' from roles where key = 'org_bookkeeper'
union all
  select id, 'invoice.write' from roles where key = 'org_bookkeeper'
union all
  select id, 'org.member' from roles where key = 'org_bookkeeper'
union all
  select id, 'org.read' from roles where key = 'org_bookkeeper'
union all
  select id, 'payment.read' from roles where key = 'org_bookkeeper'
union all
  select id, 'project.read' from roles where key = 'org_bookkeeper'
union all
  select id, 'report.read' from roles where key = 'org_bookkeeper'
union all
  select id, 'bid.read' from roles where key = 'org_estimator'
union all
  select id, 'bid.write' from roles where key = 'org_estimator'
union all
  select id, 'directory.read' from roles where key = 'org_estimator'
union all
  select id, 'directory.write' from roles where key = 'org_estimator'
union all
  select id, 'docs.download' from roles where key = 'org_estimator'
union all
  select id, 'docs.read' from roles where key = 'org_estimator'
union all
  select id, 'docs.upload' from roles where key = 'org_estimator'
union all
  select id, 'org.member' from roles where key = 'org_estimator'
union all
  select id, 'org.read' from roles where key = 'org_estimator'
union all
  select id, 'pipeline.read' from roles where key = 'org_estimator'
union all
  select id, 'pipeline.write' from roles where key = 'org_estimator'
union all
  select id, 'project.read' from roles where key = 'org_estimator'
union all
  select id, 'proposal.read' from roles where key = 'org_estimator'
union all
  select id, 'proposal.write' from roles where key = 'org_estimator'
union all
  select id, 'report.read' from roles where key = 'org_estimator'
union all
  select id, 'signature.read' from roles where key = 'org_estimator'
union all
  select id, 'signature.send' from roles where key = 'org_estimator'
union all
  select id, 'audit.read' from roles where key = 'org_office_admin'
union all
  select id, 'bill.approve' from roles where key = 'org_office_admin'
union all
  select id, 'bill.read' from roles where key = 'org_office_admin'
union all
  select id, 'bill.write' from roles where key = 'org_office_admin'
union all
  select id, 'billing.manage' from roles where key = 'org_office_admin'
union all
  select id, 'budget.read' from roles where key = 'org_office_admin'
union all
  select id, 'budget.write' from roles where key = 'org_office_admin'
union all
  select id, 'change_order.approve' from roles where key = 'org_office_admin'
union all
  select id, 'change_order.read' from roles where key = 'org_office_admin'
union all
  select id, 'change_order.write' from roles where key = 'org_office_admin'
union all
  select id, 'commitment.approve' from roles where key = 'org_office_admin'
union all
  select id, 'commitment.read' from roles where key = 'org_office_admin'
union all
  select id, 'commitment.write' from roles where key = 'org_office_admin'
union all
  select id, 'daily_log.approve' from roles where key = 'org_office_admin'
union all
  select id, 'daily_log.read' from roles where key = 'org_office_admin'
union all
  select id, 'daily_log.write' from roles where key = 'org_office_admin'
union all
  select id, 'docs.delete' from roles where key = 'org_office_admin'
union all
  select id, 'docs.download' from roles where key = 'org_office_admin'
union all
  select id, 'docs.read' from roles where key = 'org_office_admin'
union all
  select id, 'docs.share' from roles where key = 'org_office_admin'
union all
  select id, 'docs.upload' from roles where key = 'org_office_admin'
union all
  select id, 'draw.approve' from roles where key = 'org_office_admin'
union all
  select id, 'draw.read' from roles where key = 'org_office_admin'
union all
  select id, 'financials.margin.read' from roles where key = 'org_office_admin'
union all
  select id, 'invoice.approve' from roles where key = 'org_office_admin'
union all
  select id, 'invoice.read' from roles where key = 'org_office_admin'
union all
  select id, 'invoice.send' from roles where key = 'org_office_admin'
union all
  select id, 'invoice.write' from roles where key = 'org_office_admin'
union all
  select id, 'members.manage' from roles where key = 'org_office_admin'
union all
  select id, 'org.admin' from roles where key = 'org_office_admin'
union all
  select id, 'org.member' from roles where key = 'org_office_admin'
union all
  select id, 'org.read' from roles where key = 'org_office_admin'
union all
  select id, 'payment.read' from roles where key = 'org_office_admin'
union all
  select id, 'payment.release' from roles where key = 'org_office_admin'
union all
  select id, 'portal.access.manage' from roles where key = 'org_office_admin'
union all
  select id, 'project.archive' from roles where key = 'org_office_admin'
union all
  select id, 'project.create' from roles where key = 'org_office_admin'
union all
  select id, 'project.manage' from roles where key = 'org_office_admin'
union all
  select id, 'project.read' from roles where key = 'org_office_admin'
union all
  select id, 'project.settings.read' from roles where key = 'org_office_admin'
union all
  select id, 'project.settings.update' from roles where key = 'org_office_admin'
union all
  select id, 'report.read' from roles where key = 'org_office_admin'
union all
  select id, 'retainage.manage' from roles where key = 'org_office_admin'
union all
  select id, 'rfi.close' from roles where key = 'org_office_admin'
union all
  select id, 'rfi.read' from roles where key = 'org_office_admin'
union all
  select id, 'rfi.respond' from roles where key = 'org_office_admin'
union all
  select id, 'rfi.write' from roles where key = 'org_office_admin'
union all
  select id, 'schedule.baseline.manage' from roles where key = 'org_office_admin'
union all
  select id, 'schedule.edit' from roles where key = 'org_office_admin'
union all
  select id, 'schedule.publish' from roles where key = 'org_office_admin'
union all
  select id, 'schedule.read' from roles where key = 'org_office_admin'
union all
  select id, 'submittal.approve' from roles where key = 'org_office_admin'
union all
  select id, 'submittal.read' from roles where key = 'org_office_admin'
union all
  select id, 'submittal.review' from roles where key = 'org_office_admin'
union all
  select id, 'submittal.write' from roles where key = 'org_office_admin'
union all
  select id, 'audit.read' from roles where key = 'org_owner'
union all
  select id, 'bill.approve' from roles where key = 'org_owner'
union all
  select id, 'bill.read' from roles where key = 'org_owner'
union all
  select id, 'bill.write' from roles where key = 'org_owner'
union all
  select id, 'billing.manage' from roles where key = 'org_owner'
union all
  select id, 'budget.lock' from roles where key = 'org_owner'
union all
  select id, 'budget.read' from roles where key = 'org_owner'
union all
  select id, 'budget.write' from roles where key = 'org_owner'
union all
  select id, 'change_order.approve' from roles where key = 'org_owner'
union all
  select id, 'change_order.read' from roles where key = 'org_owner'
union all
  select id, 'change_order.write' from roles where key = 'org_owner'
union all
  select id, 'commitment.approve' from roles where key = 'org_owner'
union all
  select id, 'commitment.read' from roles where key = 'org_owner'
union all
  select id, 'commitment.write' from roles where key = 'org_owner'
union all
  select id, 'daily_log.approve' from roles where key = 'org_owner'
union all
  select id, 'daily_log.read' from roles where key = 'org_owner'
union all
  select id, 'daily_log.write' from roles where key = 'org_owner'
union all
  select id, 'docs.delete' from roles where key = 'org_owner'
union all
  select id, 'docs.download' from roles where key = 'org_owner'
union all
  select id, 'docs.read' from roles where key = 'org_owner'
union all
  select id, 'docs.share' from roles where key = 'org_owner'
union all
  select id, 'docs.upload' from roles where key = 'org_owner'
union all
  select id, 'draw.approve' from roles where key = 'org_owner'
union all
  select id, 'draw.read' from roles where key = 'org_owner'
union all
  select id, 'features.manage' from roles where key = 'org_owner'
union all
  select id, 'financials.margin.read' from roles where key = 'org_owner'
union all
  select id, 'invoice.approve' from roles where key = 'org_owner'
union all
  select id, 'invoice.read' from roles where key = 'org_owner'
union all
  select id, 'invoice.send' from roles where key = 'org_owner'
union all
  select id, 'invoice.write' from roles where key = 'org_owner'
union all
  select id, 'members.manage' from roles where key = 'org_owner'
union all
  select id, 'org.admin' from roles where key = 'org_owner'
union all
  select id, 'org.member' from roles where key = 'org_owner'
union all
  select id, 'org.read' from roles where key = 'org_owner'
union all
  select id, 'payment.read' from roles where key = 'org_owner'
union all
  select id, 'payment.release' from roles where key = 'org_owner'
union all
  select id, 'portal.access.manage' from roles where key = 'org_owner'
union all
  select id, 'project.archive' from roles where key = 'org_owner'
union all
  select id, 'project.create' from roles where key = 'org_owner'
union all
  select id, 'project.manage' from roles where key = 'org_owner'
union all
  select id, 'project.read' from roles where key = 'org_owner'
union all
  select id, 'project.settings.read' from roles where key = 'org_owner'
union all
  select id, 'project.settings.update' from roles where key = 'org_owner'
union all
  select id, 'report.read' from roles where key = 'org_owner'
union all
  select id, 'retainage.manage' from roles where key = 'org_owner'
union all
  select id, 'rfi.close' from roles where key = 'org_owner'
union all
  select id, 'rfi.read' from roles where key = 'org_owner'
union all
  select id, 'rfi.respond' from roles where key = 'org_owner'
union all
  select id, 'rfi.write' from roles where key = 'org_owner'
union all
  select id, 'schedule.baseline.manage' from roles where key = 'org_owner'
union all
  select id, 'schedule.edit' from roles where key = 'org_owner'
union all
  select id, 'schedule.publish' from roles where key = 'org_owner'
union all
  select id, 'schedule.read' from roles where key = 'org_owner'
union all
  select id, 'submittal.approve' from roles where key = 'org_owner'
union all
  select id, 'submittal.read' from roles where key = 'org_owner'
union all
  select id, 'submittal.review' from roles where key = 'org_owner'
union all
  select id, 'submittal.write' from roles where key = 'org_owner'
union all
  select id, 'bill.read' from roles where key = 'org_project_lead'
union all
  select id, 'bill.write' from roles where key = 'org_project_lead'
union all
  select id, 'budget.read' from roles where key = 'org_project_lead'
union all
  select id, 'change_order.read' from roles where key = 'org_project_lead'
union all
  select id, 'change_order.write' from roles where key = 'org_project_lead'
union all
  select id, 'commitment.read' from roles where key = 'org_project_lead'
union all
  select id, 'commitment.write' from roles where key = 'org_project_lead'
union all
  select id, 'daily_log.read' from roles where key = 'org_project_lead'
union all
  select id, 'daily_log.write' from roles where key = 'org_project_lead'
union all
  select id, 'docs.download' from roles where key = 'org_project_lead'
union all
  select id, 'docs.read' from roles where key = 'org_project_lead'
union all
  select id, 'docs.share' from roles where key = 'org_project_lead'
union all
  select id, 'docs.upload' from roles where key = 'org_project_lead'
union all
  select id, 'draw.read' from roles where key = 'org_project_lead'
union all
  select id, 'financials.margin.read' from roles where key = 'org_project_lead'
union all
  select id, 'invoice.read' from roles where key = 'org_project_lead'
union all
  select id, 'invoice.write' from roles where key = 'org_project_lead'
union all
  select id, 'org.member' from roles where key = 'org_project_lead'
union all
  select id, 'org.read' from roles where key = 'org_project_lead'
union all
  select id, 'payment.read' from roles where key = 'org_project_lead'
union all
  select id, 'portal.access.manage' from roles where key = 'org_project_lead'
union all
  select id, 'project.manage' from roles where key = 'org_project_lead'
union all
  select id, 'project.read' from roles where key = 'org_project_lead'
union all
  select id, 'project.settings.read' from roles where key = 'org_project_lead'
union all
  select id, 'report.read' from roles where key = 'org_project_lead'
union all
  select id, 'rfi.read' from roles where key = 'org_project_lead'
union all
  select id, 'rfi.respond' from roles where key = 'org_project_lead'
union all
  select id, 'rfi.write' from roles where key = 'org_project_lead'
union all
  select id, 'schedule.edit' from roles where key = 'org_project_lead'
union all
  select id, 'schedule.publish' from roles where key = 'org_project_lead'
union all
  select id, 'schedule.read' from roles where key = 'org_project_lead'
union all
  select id, 'submittal.read' from roles where key = 'org_project_lead'
union all
  select id, 'submittal.review' from roles where key = 'org_project_lead'
union all
  select id, 'submittal.write' from roles where key = 'org_project_lead'
union all
  select id, 'closeout.read' from roles where key = 'org_user'
union all
  select id, 'daily_log.read' from roles where key = 'org_user'
union all
  select id, 'daily_log.write' from roles where key = 'org_user'
union all
  select id, 'decision.read' from roles where key = 'org_user'
union all
  select id, 'decision.write' from roles where key = 'org_user'
union all
  select id, 'directory.read' from roles where key = 'org_user'
union all
  select id, 'docs.download' from roles where key = 'org_user'
union all
  select id, 'docs.read' from roles where key = 'org_user'
union all
  select id, 'docs.upload' from roles where key = 'org_user'
union all
  select id, 'drawing.markup' from roles where key = 'org_user'
union all
  select id, 'drawing.read' from roles where key = 'org_user'
union all
  select id, 'drawing.upload' from roles where key = 'org_user'
union all
  select id, 'message.read' from roles where key = 'org_user'
union all
  select id, 'message.write' from roles where key = 'org_user'
union all
  select id, 'org.member' from roles where key = 'org_user'
union all
  select id, 'org.read' from roles where key = 'org_user'
union all
  select id, 'punch.read' from roles where key = 'org_user'
union all
  select id, 'punch.write' from roles where key = 'org_user'
union all
  select id, 'rfi.read' from roles where key = 'org_user'
union all
  select id, 'rfi.respond' from roles where key = 'org_user'
union all
  select id, 'rfi.write' from roles where key = 'org_user'
union all
  select id, 'schedule.edit' from roles where key = 'org_user'
union all
  select id, 'schedule.read' from roles where key = 'org_user'
union all
  select id, 'submittal.read' from roles where key = 'org_user'
union all
  select id, 'submittal.write' from roles where key = 'org_user'
union all
  select id, 'time.read' from roles where key = 'org_user'
union all
  select id, 'time.write' from roles where key = 'org_user'
union all
  select id, 'warranty.read' from roles where key = 'org_user'
union all
  select id, 'bill.read' from roles where key = 'org_viewer'
union all
  select id, 'budget.read' from roles where key = 'org_viewer'
union all
  select id, 'change_order.read' from roles where key = 'org_viewer'
union all
  select id, 'commitment.read' from roles where key = 'org_viewer'
union all
  select id, 'daily_log.read' from roles where key = 'org_viewer'
union all
  select id, 'docs.download' from roles where key = 'org_viewer'
union all
  select id, 'docs.read' from roles where key = 'org_viewer'
union all
  select id, 'draw.read' from roles where key = 'org_viewer'
union all
  select id, 'invoice.read' from roles where key = 'org_viewer'
union all
  select id, 'org.read' from roles where key = 'org_viewer'
union all
  select id, 'payment.read' from roles where key = 'org_viewer'
union all
  select id, 'project.read' from roles where key = 'org_viewer'
union all
  select id, 'report.read' from roles where key = 'org_viewer'
union all
  select id, 'rfi.read' from roles where key = 'org_viewer'
union all
  select id, 'schedule.read' from roles where key = 'org_viewer'
union all
  select id, 'submittal.read' from roles where key = 'org_viewer'
union all
  select id, 'audit.read' from roles where key = 'platform_admin'
union all
  select id, 'impersonation.end' from roles where key = 'platform_admin'
union all
  select id, 'impersonation.start' from roles where key = 'platform_admin'
union all
  select id, 'platform.feature_flags.manage' from roles where key = 'platform_admin'
union all
  select id, 'platform.org.access' from roles where key = 'platform_admin'
union all
  select id, 'platform.org.read' from roles where key = 'platform_admin'
union all
  select id, 'platform.support.read' from roles where key = 'platform_admin'
union all
  select id, 'platform.support.write' from roles where key = 'platform_admin'
union all
  select id, 'audit.read' from roles where key = 'platform_billing_ops'
union all
  select id, 'platform.billing.manage' from roles where key = 'platform_billing_ops'
union all
  select id, 'platform.org.read' from roles where key = 'platform_billing_ops'
union all
  select id, 'platform.support.read' from roles where key = 'platform_billing_ops'
union all
  select id, 'audit.export' from roles where key = 'platform_security_auditor'
union all
  select id, 'audit.read' from roles where key = 'platform_security_auditor'
union all
  select id, 'platform.org.read' from roles where key = 'platform_security_auditor'
union all
  select id, 'platform.support.read' from roles where key = 'platform_security_auditor'
union all
  select id, 'audit.export' from roles where key = 'platform_super_admin'
union all
  select id, 'audit.read' from roles where key = 'platform_super_admin'
union all
  select id, 'authz.policy.manage' from roles where key = 'platform_super_admin'
union all
  select id, 'impersonation.end' from roles where key = 'platform_super_admin'
union all
  select id, 'impersonation.start' from roles where key = 'platform_super_admin'
union all
  select id, 'platform.billing.manage' from roles where key = 'platform_super_admin'
union all
  select id, 'platform.feature_flags.manage' from roles where key = 'platform_super_admin'
union all
  select id, 'platform.org.access' from roles where key = 'platform_super_admin'
union all
  select id, 'platform.org.read' from roles where key = 'platform_super_admin'
union all
  select id, 'platform.support.read' from roles where key = 'platform_super_admin'
union all
  select id, 'platform.support.write' from roles where key = 'platform_super_admin'
union all
  select id, 'audit.read' from roles where key = 'platform_support_readonly'
union all
  select id, 'platform.org.read' from roles where key = 'platform_support_readonly'
union all
  select id, 'platform.support.read' from roles where key = 'platform_support_readonly'
union all
  select id, 'bill.read' from roles where key = 'pm'
union all
  select id, 'bill.write' from roles where key = 'pm'
union all
  select id, 'budget.read' from roles where key = 'pm'
union all
  select id, 'budget.write' from roles where key = 'pm'
union all
  select id, 'change_order.read' from roles where key = 'pm'
union all
  select id, 'change_order.write' from roles where key = 'pm'
union all
  select id, 'commitment.read' from roles where key = 'pm'
union all
  select id, 'commitment.write' from roles where key = 'pm'
union all
  select id, 'daily_log.read' from roles where key = 'pm'
union all
  select id, 'daily_log.write' from roles where key = 'pm'
union all
  select id, 'docs.download' from roles where key = 'pm'
union all
  select id, 'docs.read' from roles where key = 'pm'
union all
  select id, 'docs.share' from roles where key = 'pm'
union all
  select id, 'docs.upload' from roles where key = 'pm'
union all
  select id, 'draw.read' from roles where key = 'pm'
union all
  select id, 'invoice.read' from roles where key = 'pm'
union all
  select id, 'invoice.send' from roles where key = 'pm'
union all
  select id, 'invoice.write' from roles where key = 'pm'
union all
  select id, 'payment.read' from roles where key = 'pm'
union all
  select id, 'portal.access.manage' from roles where key = 'pm'
union all
  select id, 'project.manage' from roles where key = 'pm'
union all
  select id, 'project.read' from roles where key = 'pm'
union all
  select id, 'project.settings.read' from roles where key = 'pm'
union all
  select id, 'project.settings.update' from roles where key = 'pm'
union all
  select id, 'report.read' from roles where key = 'pm'
union all
  select id, 'rfi.close' from roles where key = 'pm'
union all
  select id, 'rfi.read' from roles where key = 'pm'
union all
  select id, 'rfi.respond' from roles where key = 'pm'
union all
  select id, 'rfi.write' from roles where key = 'pm'
union all
  select id, 'schedule.baseline.manage' from roles where key = 'pm'
union all
  select id, 'schedule.edit' from roles where key = 'pm'
union all
  select id, 'schedule.publish' from roles where key = 'pm'
union all
  select id, 'schedule.read' from roles where key = 'pm'
union all
  select id, 'submittal.read' from roles where key = 'pm'
union all
  select id, 'submittal.review' from roles where key = 'pm'
union all
  select id, 'submittal.write' from roles where key = 'pm'
union all
  select id, 'time.read' from roles where key = 'pm'
union all
  select id, 'time.write' from roles where key = 'pm'
union all
  select id, 'safety.read' from roles where key in ('org_owner', 'org_admin', 'org_office_admin', 'org_project_lead', 'pm', 'field')
union all
  select id, 'safety.write' from roles where key in ('org_owner', 'org_admin', 'org_office_admin', 'org_project_lead', 'pm', 'field')
on conflict (role_id, permission_key) do nothing;

-- 4. Prune grants no longer declared, so this file stays authoritative for managed roles.
with desired (role_key, permission_key) as (values
  ('field', 'daily_log.read'),
  ('field', 'daily_log.write'),
  ('field', 'docs.download'),
  ('field', 'docs.read'),
  ('field', 'docs.upload'),
  ('field', 'project.read'),
  ('field', 'report.read'),
  ('field', 'rfi.read'),
  ('field', 'rfi.respond'),
  ('field', 'rfi.write'),
  ('field', 'schedule.edit'),
  ('field', 'schedule.read'),
  ('field', 'submittal.read'),
  ('field', 'submittal.write'),
  ('field', 'time.read'),
  ('field', 'time.write'),
  ('org_admin', 'audit.read'),
  ('org_admin', 'bid.read'),
  ('org_admin', 'bid.write'),
  ('org_admin', 'bill.approve'),
  ('org_admin', 'bill.read'),
  ('org_admin', 'bill.write'),
  ('org_admin', 'billing.manage'),
  ('org_admin', 'budget.lock'),
  ('org_admin', 'budget.read'),
  ('org_admin', 'budget.write'),
  ('org_admin', 'change_order.approve'),
  ('org_admin', 'change_order.read'),
  ('org_admin', 'change_order.write'),
  ('org_admin', 'closeout.read'),
  ('org_admin', 'closeout.write'),
  ('org_admin', 'commitment.approve'),
  ('org_admin', 'commitment.read'),
  ('org_admin', 'commitment.write'),
  ('org_admin', 'daily_log.approve'),
  ('org_admin', 'daily_log.read'),
  ('org_admin', 'daily_log.write'),
  ('org_admin', 'decision.read'),
  ('org_admin', 'decision.write'),
  ('org_admin', 'directory.read'),
  ('org_admin', 'directory.write'),
  ('org_admin', 'docs.delete'),
  ('org_admin', 'docs.download'),
  ('org_admin', 'docs.read'),
  ('org_admin', 'docs.share'),
  ('org_admin', 'docs.upload'),
  ('org_admin', 'draw.approve'),
  ('org_admin', 'draw.read'),
  ('org_admin', 'drawing.markup'),
  ('org_admin', 'drawing.read'),
  ('org_admin', 'drawing.upload'),
  ('org_admin', 'features.manage'),
  ('org_admin', 'financials.margin.read'),
  ('org_admin', 'invoice.approve'),
  ('org_admin', 'invoice.read'),
  ('org_admin', 'invoice.send'),
  ('org_admin', 'invoice.write'),
  ('org_admin', 'members.manage'),
  ('org_admin', 'message.read'),
  ('org_admin', 'message.write'),
  ('org_admin', 'org.admin'),
  ('org_admin', 'org.member'),
  ('org_admin', 'org.read'),
  ('org_admin', 'payment.read'),
  ('org_admin', 'payment.release'),
  ('org_admin', 'pipeline.read'),
  ('org_admin', 'pipeline.write'),
  ('org_admin', 'portal.access.manage'),
  ('org_admin', 'project.archive'),
  ('org_admin', 'project.create'),
  ('org_admin', 'project.manage'),
  ('org_admin', 'project.read'),
  ('org_admin', 'project.settings.read'),
  ('org_admin', 'project.settings.update'),
  ('org_admin', 'proposal.read'),
  ('org_admin', 'proposal.write'),
  ('org_admin', 'punch.close'),
  ('org_admin', 'punch.read'),
  ('org_admin', 'punch.write'),
  ('org_admin', 'report.read'),
  ('org_admin', 'retainage.manage'),
  ('org_admin', 'rfi.close'),
  ('org_admin', 'rfi.read'),
  ('org_admin', 'rfi.respond'),
  ('org_admin', 'rfi.write'),
  ('org_admin', 'schedule.baseline.manage'),
  ('org_admin', 'schedule.edit'),
  ('org_admin', 'schedule.publish'),
  ('org_admin', 'schedule.read'),
  ('org_admin', 'signature.read'),
  ('org_admin', 'signature.send'),
  ('org_admin', 'submittal.approve'),
  ('org_admin', 'submittal.read'),
  ('org_admin', 'submittal.review'),
  ('org_admin', 'submittal.write'),
  ('org_admin', 'meeting.write'),
  ('org_admin', 'transmittal.write'),
  ('org_admin', 'time.read'),
  ('org_admin', 'time.write'),
  ('org_admin', 'warranty.read'),
  ('org_admin', 'warranty.write'),
  ('org_bookkeeper', 'bill.read'),
  ('org_bookkeeper', 'bill.write'),
  ('org_bookkeeper', 'budget.read'),
  ('org_bookkeeper', 'commitment.read'),
  ('org_bookkeeper', 'directory.read'),
  ('org_bookkeeper', 'directory.write'),
  ('org_bookkeeper', 'docs.download'),
  ('org_bookkeeper', 'docs.read'),
  ('org_bookkeeper', 'draw.read'),
  ('org_bookkeeper', 'invoice.read'),
  ('org_bookkeeper', 'invoice.send'),
  ('org_bookkeeper', 'invoice.write'),
  ('org_bookkeeper', 'org.member'),
  ('org_bookkeeper', 'org.read'),
  ('org_bookkeeper', 'payment.read'),
  ('org_bookkeeper', 'project.read'),
  ('org_bookkeeper', 'report.read'),
  ('org_estimator', 'bid.read'),
  ('org_estimator', 'bid.write'),
  ('org_estimator', 'directory.read'),
  ('org_estimator', 'directory.write'),
  ('org_estimator', 'docs.download'),
  ('org_estimator', 'docs.read'),
  ('org_estimator', 'docs.upload'),
  ('org_estimator', 'org.member'),
  ('org_estimator', 'org.read'),
  ('org_estimator', 'pipeline.read'),
  ('org_estimator', 'pipeline.write'),
  ('org_estimator', 'project.read'),
  ('org_estimator', 'proposal.read'),
  ('org_estimator', 'proposal.write'),
  ('org_estimator', 'report.read'),
  ('org_estimator', 'signature.read'),
  ('org_estimator', 'signature.send'),
  ('org_office_admin', 'audit.read'),
  ('org_office_admin', 'bill.approve'),
  ('org_office_admin', 'bill.read'),
  ('org_office_admin', 'bill.write'),
  ('org_office_admin', 'billing.manage'),
  ('org_office_admin', 'budget.read'),
  ('org_office_admin', 'budget.write'),
  ('org_office_admin', 'change_order.approve'),
  ('org_office_admin', 'change_order.read'),
  ('org_office_admin', 'change_order.write'),
  ('org_office_admin', 'commitment.approve'),
  ('org_office_admin', 'commitment.read'),
  ('org_office_admin', 'commitment.write'),
  ('org_office_admin', 'daily_log.approve'),
  ('org_office_admin', 'daily_log.read'),
  ('org_office_admin', 'daily_log.write'),
  ('org_office_admin', 'docs.delete'),
  ('org_office_admin', 'docs.download'),
  ('org_office_admin', 'docs.read'),
  ('org_office_admin', 'docs.share'),
  ('org_office_admin', 'docs.upload'),
  ('org_office_admin', 'draw.approve'),
  ('org_office_admin', 'draw.read'),
  ('org_office_admin', 'financials.margin.read'),
  ('org_office_admin', 'invoice.approve'),
  ('org_office_admin', 'invoice.read'),
  ('org_office_admin', 'invoice.send'),
  ('org_office_admin', 'invoice.write'),
  ('org_office_admin', 'members.manage'),
  ('org_office_admin', 'org.admin'),
  ('org_office_admin', 'org.member'),
  ('org_office_admin', 'org.read'),
  ('org_office_admin', 'payment.read'),
  ('org_office_admin', 'payment.release'),
  ('org_office_admin', 'portal.access.manage'),
  ('org_office_admin', 'project.archive'),
  ('org_office_admin', 'project.create'),
  ('org_office_admin', 'project.manage'),
  ('org_office_admin', 'project.read'),
  ('org_office_admin', 'project.settings.read'),
  ('org_office_admin', 'project.settings.update'),
  ('org_office_admin', 'report.read'),
  ('org_office_admin', 'retainage.manage'),
  ('org_office_admin', 'rfi.close'),
  ('org_office_admin', 'rfi.read'),
  ('org_office_admin', 'rfi.respond'),
  ('org_office_admin', 'rfi.write'),
  ('org_office_admin', 'schedule.baseline.manage'),
  ('org_office_admin', 'schedule.edit'),
  ('org_office_admin', 'schedule.publish'),
  ('org_office_admin', 'schedule.read'),
  ('org_office_admin', 'submittal.approve'),
  ('org_office_admin', 'submittal.read'),
  ('org_office_admin', 'submittal.review'),
  ('org_office_admin', 'submittal.write'),
  ('org_office_admin', 'meeting.write'),
  ('org_office_admin', 'transmittal.write'),
  ('org_owner', 'audit.read'),
  ('org_owner', 'bill.approve'),
  ('org_owner', 'bill.read'),
  ('org_owner', 'bill.write'),
  ('org_owner', 'billing.manage'),
  ('org_owner', 'budget.lock'),
  ('org_owner', 'budget.read'),
  ('org_owner', 'budget.write'),
  ('org_owner', 'change_order.approve'),
  ('org_owner', 'change_order.read'),
  ('org_owner', 'change_order.write'),
  ('org_owner', 'commitment.approve'),
  ('org_owner', 'commitment.read'),
  ('org_owner', 'commitment.write'),
  ('org_owner', 'daily_log.approve'),
  ('org_owner', 'daily_log.read'),
  ('org_owner', 'daily_log.write'),
  ('org_owner', 'docs.delete'),
  ('org_owner', 'docs.download'),
  ('org_owner', 'docs.read'),
  ('org_owner', 'docs.share'),
  ('org_owner', 'docs.upload'),
  ('org_owner', 'draw.approve'),
  ('org_owner', 'draw.read'),
  ('org_owner', 'features.manage'),
  ('org_owner', 'financials.margin.read'),
  ('org_owner', 'invoice.approve'),
  ('org_owner', 'invoice.read'),
  ('org_owner', 'invoice.send'),
  ('org_owner', 'invoice.write'),
  ('org_owner', 'members.manage'),
  ('org_owner', 'org.admin'),
  ('org_owner', 'org.member'),
  ('org_owner', 'org.read'),
  ('org_owner', 'payment.read'),
  ('org_owner', 'payment.release'),
  ('org_owner', 'portal.access.manage'),
  ('org_owner', 'project.archive'),
  ('org_owner', 'project.create'),
  ('org_owner', 'project.manage'),
  ('org_owner', 'project.read'),
  ('org_owner', 'project.settings.read'),
  ('org_owner', 'project.settings.update'),
  ('org_owner', 'report.read'),
  ('org_owner', 'retainage.manage'),
  ('org_owner', 'rfi.close'),
  ('org_owner', 'rfi.read'),
  ('org_owner', 'rfi.respond'),
  ('org_owner', 'rfi.write'),
  ('org_owner', 'schedule.baseline.manage'),
  ('org_owner', 'schedule.edit'),
  ('org_owner', 'schedule.publish'),
  ('org_owner', 'schedule.read'),
  ('org_owner', 'submittal.approve'),
  ('org_owner', 'submittal.read'),
  ('org_owner', 'submittal.review'),
  ('org_owner', 'submittal.write'),
  ('org_owner', 'meeting.write'),
  ('org_owner', 'transmittal.write'),
  ('org_project_lead', 'bill.read'),
  ('org_project_lead', 'bill.write'),
  ('org_project_lead', 'budget.read'),
  ('org_project_lead', 'change_order.read'),
  ('org_project_lead', 'change_order.write'),
  ('org_project_lead', 'commitment.read'),
  ('org_project_lead', 'commitment.write'),
  ('org_project_lead', 'daily_log.read'),
  ('org_project_lead', 'daily_log.write'),
  ('org_project_lead', 'docs.download'),
  ('org_project_lead', 'docs.read'),
  ('org_project_lead', 'docs.share'),
  ('org_project_lead', 'docs.upload'),
  ('org_project_lead', 'draw.read'),
  ('org_project_lead', 'financials.margin.read'),
  ('org_project_lead', 'invoice.read'),
  ('org_project_lead', 'invoice.write'),
  ('org_project_lead', 'org.member'),
  ('org_project_lead', 'org.read'),
  ('org_project_lead', 'payment.read'),
  ('org_project_lead', 'portal.access.manage'),
  ('org_project_lead', 'project.manage'),
  ('org_project_lead', 'project.read'),
  ('org_project_lead', 'project.settings.read'),
  ('org_project_lead', 'report.read'),
  ('org_project_lead', 'rfi.read'),
  ('org_project_lead', 'rfi.respond'),
  ('org_project_lead', 'rfi.write'),
  ('org_project_lead', 'schedule.edit'),
  ('org_project_lead', 'schedule.publish'),
  ('org_project_lead', 'schedule.read'),
  ('org_project_lead', 'submittal.read'),
  ('org_project_lead', 'submittal.review'),
  ('org_project_lead', 'submittal.write'),
  ('org_project_lead', 'meeting.write'),
  ('org_project_lead', 'transmittal.write'),
  ('org_user', 'closeout.read'),
  ('org_user', 'daily_log.read'),
  ('org_user', 'daily_log.write'),
  ('org_user', 'decision.read'),
  ('org_user', 'decision.write'),
  ('org_user', 'directory.read'),
  ('org_user', 'docs.download'),
  ('org_user', 'docs.read'),
  ('org_user', 'docs.upload'),
  ('org_user', 'drawing.markup'),
  ('org_user', 'drawing.read'),
  ('org_user', 'drawing.upload'),
  ('org_user', 'message.read'),
  ('org_user', 'message.write'),
  ('org_user', 'org.member'),
  ('org_user', 'org.read'),
  ('org_user', 'punch.read'),
  ('org_user', 'punch.write'),
  ('org_user', 'rfi.read'),
  ('org_user', 'rfi.respond'),
  ('org_user', 'rfi.write'),
  ('org_user', 'schedule.edit'),
  ('org_user', 'schedule.read'),
  ('org_user', 'submittal.read'),
  ('org_user', 'submittal.write'),
  ('org_user', 'time.read'),
  ('org_user', 'time.write'),
  ('org_user', 'warranty.read'),
  ('org_viewer', 'bill.read'),
  ('org_viewer', 'budget.read'),
  ('org_viewer', 'change_order.read'),
  ('org_viewer', 'commitment.read'),
  ('org_viewer', 'daily_log.read'),
  ('org_viewer', 'docs.download'),
  ('org_viewer', 'docs.read'),
  ('org_viewer', 'draw.read'),
  ('org_viewer', 'invoice.read'),
  ('org_viewer', 'org.read'),
  ('org_viewer', 'payment.read'),
  ('org_viewer', 'project.read'),
  ('org_viewer', 'report.read'),
  ('org_viewer', 'rfi.read'),
  ('org_viewer', 'schedule.read'),
  ('org_viewer', 'submittal.read'),
  ('platform_admin', 'audit.read'),
  ('platform_admin', 'impersonation.end'),
  ('platform_admin', 'impersonation.start'),
  ('platform_admin', 'platform.feature_flags.manage'),
  ('platform_admin', 'platform.org.access'),
  ('platform_admin', 'platform.org.read'),
  ('platform_admin', 'platform.support.read'),
  ('platform_admin', 'platform.support.write'),
  ('platform_billing_ops', 'audit.read'),
  ('platform_billing_ops', 'platform.billing.manage'),
  ('platform_billing_ops', 'platform.org.read'),
  ('platform_billing_ops', 'platform.support.read'),
  ('platform_security_auditor', 'audit.export'),
  ('platform_security_auditor', 'audit.read'),
  ('platform_security_auditor', 'platform.org.read'),
  ('platform_security_auditor', 'platform.support.read'),
  ('platform_super_admin', 'audit.export'),
  ('platform_super_admin', 'audit.read'),
  ('platform_super_admin', 'authz.policy.manage'),
  ('platform_super_admin', 'impersonation.end'),
  ('platform_super_admin', 'impersonation.start'),
  ('platform_super_admin', 'platform.billing.manage'),
  ('platform_super_admin', 'platform.feature_flags.manage'),
  ('platform_super_admin', 'platform.org.access'),
  ('platform_super_admin', 'platform.org.read'),
  ('platform_super_admin', 'platform.support.read'),
  ('platform_super_admin', 'platform.support.write'),
  ('platform_support_readonly', 'audit.read'),
  ('platform_support_readonly', 'platform.org.read'),
  ('platform_support_readonly', 'platform.support.read'),
  ('pm', 'bill.read'),
  ('pm', 'bill.write'),
  ('pm', 'budget.read'),
  ('pm', 'budget.write'),
  ('pm', 'change_order.read'),
  ('pm', 'change_order.write'),
  ('pm', 'commitment.read'),
  ('pm', 'commitment.write'),
  ('pm', 'daily_log.read'),
  ('pm', 'daily_log.write'),
  ('pm', 'docs.download'),
  ('pm', 'docs.read'),
  ('pm', 'docs.share'),
  ('pm', 'docs.upload'),
  ('pm', 'draw.read'),
  ('pm', 'invoice.read'),
  ('pm', 'invoice.send'),
  ('pm', 'invoice.write'),
  ('pm', 'payment.read'),
  ('pm', 'portal.access.manage'),
  ('pm', 'project.manage'),
  ('pm', 'project.read'),
  ('pm', 'project.settings.read'),
  ('pm', 'project.settings.update'),
  ('pm', 'report.read'),
  ('pm', 'rfi.close'),
  ('pm', 'rfi.read'),
  ('pm', 'rfi.respond'),
  ('pm', 'rfi.write'),
  ('pm', 'schedule.baseline.manage'),
  ('pm', 'schedule.edit'),
  ('pm', 'schedule.publish'),
  ('pm', 'schedule.read'),
  ('pm', 'submittal.read'),
  ('pm', 'submittal.review'),
  ('pm', 'submittal.write'),
  ('pm', 'meeting.write'),
  ('pm', 'transmittal.write'),
  ('pm', 'time.read'),
  ('pm', 'time.write'),
  ('org_owner', 'budget.approve'),
  ('org_owner', 'prequal.review'),
  ('org_admin', 'budget.approve'),
  ('org_admin', 'prequal.review'),
  ('org_office_admin', 'budget.approve'),
  ('org_office_admin', 'prequal.review'),
  ('org_project_lead', 'budget.approve'),
  ('org_project_lead', 'prequal.review'),
  ('pm', 'budget.approve'),
  ('pm', 'prequal.review'),
  ('org_estimator', 'prequal.review'),
  ('org_owner', 'safety.read'),
  ('org_owner', 'safety.write'),
  ('org_admin', 'safety.read'),
  ('org_admin', 'safety.write'),
  ('org_office_admin', 'safety.read'),
  ('org_office_admin', 'safety.write'),
  ('org_project_lead', 'safety.read'),
  ('org_project_lead', 'safety.write'),
  ('pm', 'safety.read'),
  ('pm', 'safety.write'),
  ('field', 'safety.read'),
  ('field', 'safety.write')
)
delete from role_permissions rp using roles r
where rp.role_id = r.id
  and r.key in ('field', 'org_admin', 'org_bookkeeper', 'org_estimator', 'org_office_admin', 'org_owner', 'org_project_lead', 'org_user', 'org_viewer', 'platform_admin', 'platform_billing_ops', 'platform_security_auditor', 'platform_super_admin', 'platform_support_readonly', 'pm')
  and not exists (select 1 from desired d where d.role_key = r.key and d.permission_key = rp.permission_key);

commit;
