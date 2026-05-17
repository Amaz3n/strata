alter table public.subscriptions
  alter column plan_code drop not null,
  alter column current_period_end drop not null,
  alter column trial_ends_at drop not null,
  alter column cancel_at drop not null,
  alter column external_customer_id drop not null,
  alter column external_subscription_id drop not null;

create unique index if not exists subscriptions_external_subscription_id_key
  on public.subscriptions (external_subscription_id)
  where external_subscription_id is not null;

create index if not exists subscriptions_external_customer_id_idx
  on public.subscriptions (external_customer_id)
  where external_customer_id is not null;

alter table public.memberships
  alter column invited_by drop not null,
  alter column last_active_at drop not null;

create unique index if not exists memberships_org_user_idx
  on public.memberships (org_id, user_id);

alter table public.entitlements
  alter column expires_at drop not null;

insert into public.plan_features (feature_key, name, description, category, metadata)
values
  ('projects', 'Projects', 'Project workspaces, contacts, milestones, and overview tracking.', 'Core', '{}'::jsonb),
  ('schedule', 'Scheduling', 'Schedules, lookaheads, assignments, and schedule reporting.', 'Operations', '{}'::jsonb),
  ('daily_logs', 'Daily Logs', 'Field daily logs, photos, weather, labor, and notes.', 'Operations', '{}'::jsonb),
  ('files_drawings', 'Files & Drawings', 'Project files, drawing sets, versions, markups, and sharing.', 'Documents', '{}'::jsonb),
  ('client_portal', 'Client Portal', 'Client-facing portal access for selections, invoices, files, and updates.', 'Client Experience', '{}'::jsonb),
  ('rfis_submittals', 'RFIs & Submittals', 'RFI and submittal workflows with portal collaboration.', 'Project Controls', '{}'::jsonb),
  ('bids_proposals', 'Bids & Proposals', 'Bid packages, proposals, pipeline, and preconstruction workflows.', 'Preconstruction', '{}'::jsonb),
  ('financials_ar', 'Receivables', 'Client invoices, payments, draws, retainage, and AR reporting.', 'Financials', '{}'::jsonb),
  ('financials_ap', 'Payables', 'Commitments, vendor bills, payments, lien waivers, and AP reporting.', 'Financials', '{}'::jsonb),
  ('change_orders', 'Change Orders', 'Change order requests, approvals, pricing, and logs.', 'Financials', '{}'::jsonb),
  ('selections', 'Selections', 'Selection sheets, client choices, allowances, and approvals.', 'Client Experience', '{}'::jsonb),
  ('closeout_warranty', 'Closeout & Warranty', 'Closeout packets, punch lists, warranty requests, and handoff tracking.', 'Client Experience', '{}'::jsonb),
  ('qbo', 'QuickBooks', 'QuickBooks connection, sync, and accounting workflows.', 'Integrations', '{}'::jsonb),
  ('esign', 'E-signatures', 'Document packets, signature envelopes, and executed-file tracking.', 'Integrations', '{}'::jsonb),
  ('ai_search', 'AI Search', 'AI search, summaries, action assistance, and cross-record querying.', 'AI', '{}'::jsonb),
  ('cost_plus', 'Cost Plus', 'Cost-plus billing, markup rules, time, expenses, and client billing packages.', 'Financials', '{}'::jsonb)
on conflict (feature_key) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category;
