Strata — Foundation Plan (LLM-Optimized Spec)

Purpose of this document: Provide a single, explicit blueprint that an LLM (and humans) can use to start building a modern, local-first construction management SaaS that supports two business models:
	1.	Multi-tenant SaaS subscription
	2.	Custom licensed instance (one-time license + paid enhancements)

This spec prioritizes: maintainability, scalability, tenant isolation, modularity, and a clear roadmap.

⸻

0) Product Definition

One-liner

A fast, mobile-first operating system for local builders to run projects (schedule, docs, field logs, change orders, light job costing), with localized templates and optional dedicated-instance “ownership” licensing.

Target market

Local builders/remodelers/GCs (typical 5–200 employees) who want simplicity, speed, and predictable pricing, not enterprise bloat.

Differentiators
	•	Modern UX + speed (Next.js + shadcn)
	•	Local-first value (permit/inspection templates, local norms)
	•	Configurable workflows (custom fields/forms/workflows)
	•	Clean upgrade path (core platform stable; customizations via plugins/config)

Non-goals (initially)
	•	Full ERP accounting replacement
	•	Complex BIM/plan takeoff suite
	•	Nationwide marketing marketplace (keep local)

⸻

1) Core Goals & Constraints

Goals
	•	Ship a sellable MVP in ~12 weeks without painting into a corner.
	•	Support multi-tenant SaaS and dedicated single-tenant instances from the same codebase.
	•	Make customization scalable via configuration + plugins, never custom forks.
	•	Ensure security + auditability for financial/approval flows.

Constraints
	•	Small team execution (1–3 builders initially)
	•	Must be maintainable: no bespoke deployments that require special handling.
	•	Must support mobile-first field usage (fast, offline-friendly later).

⸻

2) Personas & Primary Workflows

Personas
	•	Owner/PM: responsible for schedule, profitability, clients.
	•	Office Admin: manages docs, invoices, change orders, coordination.
	•	Field Lead: daily logs, photos, punch list, updates.
	•	Client: approvals + visibility.
	•	Subcontractor/Vendor: tasks, docs, bill submission.

Top workflows to support (priority)
	1.	Plan → project setup → schedule → field logs/photos → client updates
	2.	Estimate → proposal → acceptance → budget skeleton
	3.	Change order draft → send → approve/sign → budget impact
	4.	Tasks/punch list → assignment → completion + photo evidence

⸻

3) Business Models & Packaging

A) SaaS Subscription (multi-tenant)
	•	Flat company subscription (unlimited users) + add-ons.
	•	Entitlements/limits controlled via feature flags.

Example tiers:
	•	Starter: core ops + limited storage
	•	Pro: portals + change orders + budgeting lite
	•	Premium: QuickBooks sync + advanced automation + AI add-ons

B) Custom Licensed Instance (dedicated)

Recommended interpretation of “own it”:
	•	Customer owns the instance + data + perpetual right to use.
	•	Customer does not own the core source code or redistribution rights.

Commercial structure:
	•	One-time license: ~$30k (range $25–40k)
	•	Optional maintenance: annual fee for security patches/core upgrades
	•	New features: paid change requests (hourly or fixed)

Technical structure:
	•	Dedicated DB + isolated storage bucket + dedicated environment.
	•	Customizations implemented via plugins/config, no core fork.

⸻

4) Technical Architecture

Stack
	•	Frontend: Next.js (App Router), TypeScript, shadcn/ui, Tailwind
	•	Backend: Postgres + Supabase (Auth, Storage, Edge Functions)
	•	Async: Supabase Edge Functions + cron + job queue pattern (outbox)
	•	Docs/PDF: server-side PDF generation (Edge Function)

Deployment modes
	1.	Multi-tenant SaaS (shared DB; strict RLS)
	2.	Single-tenant hosted instance (dedicated DB; plugin/config enabled)
	3.	Self-hosted (optional later; not in MVP)

Code organization (monorepo suggested)
	•	apps/web (Next.js)
	•	packages/ui (design system)
	•	packages/core (domain logic, permission checks)
	•	packages/db (migrations, typed DB helpers)
	•	packages/plugins (plugin SDK)
	•	packages/integrations (QBO, Drive, etc.)

API pattern
	•	Next.js Server Actions for standard CRUD flows.
	•	Service layer (domain services) to centralize business rules.
	•	Zero “business logic in UI components”.

Non-negotiables (foundation)
	•	Audit log for critical actions
	•	Event stream table for notifications/activity feed/integrations
	•	Feature flags + entitlements per org
	•	Strict tenant isolation with DB Row Level Security (RLS)

⸻

5) Data Model (Postgres) — Core Entities

Rule: Every tenant-owned row must include org_id. Most project data includes project_id.

Tenancy & security
	•	orgs
	•	org_settings
	•	memberships (user_id, org_id, status)
	•	roles, permissions, role_permissions
	•	feature_flags (org_id, flag_key, enabled, config_json)

People / companies (CRM-lite)
	•	contacts (clients, subs, inspectors)
	•	companies (subcontractor companies, vendors)
	•	contact_company_links

Projects
	•	projects
	•	project_members (role per project)
	•	project_settings

Files/Documents
	•	files (metadata + storage pointers)
	•	file_links (polymorphic attachment to any entity)
	•	doc_versions (for drawings/plans)

Ops: schedule/tasks/field
	•	tasks
	•	schedule_items
	•	daily_logs
	•	daily_log_entries (labor/equipment/visitors)
	•	photos (file-backed + tags)
	•	punch_items

Contracts, estimating, change orders
	•	estimates, estimate_items
	•	proposals (snapshot at send time)
	•	contracts
	•	change_orders, change_order_lines
	•	approvals (generic table)

Budgeting & job costing (lite)
	•	cost_codes
	•	budgets, budget_lines
	•	commitments, commitment_lines (POs/subcontracts)
	•	vendor_bills, bill_lines
	•	invoices, invoice_lines
	•	payments
	•	receipts

Communication
	•	conversations, messages, mentions
	•	notifications, notification_deliveries

Customization engine (pre-wire early)
	•	custom_fields (org_id, entity_type, key, label, type, validation_json)
	•	custom_field_values (entity_type, entity_id, field_id, value_json)
	•	form_templates, form_instances, form_responses
	•	workflows (trigger + conditions + actions JSON)
	•	workflow_runs

Audit & events
	•	audit_log (before/after JSON)
	•	events (domain events)
	•	outbox (reliable integration jobs)

Billing & licensing
	•	plans, subscriptions, entitlements
	•	licenses (for custom)
	•	support_contracts
	•	change_requests (track paid custom work)

⸻

6) Permissions Model

Two-layer access
	1.	Org-level role (Owner/Admin/Staff/Read-only)
	2.	Project role (PM/Field/Accounting/Client/Sub)

Tools
	•	Central permission-check helpers in packages/core.
	•	DB RLS ensures no cross-tenant data access even if bugs occur.

⸻

7) Core Modules (Must-Haves)

Module A — Project Ops (MVP-critical)
	•	Project dashboard
	•	Tasks + assignments
	•	Schedule (list/calendar; later Gantt)
	•	Daily logs (fast input)
	•	Photos (capture + tag + search)
	•	Files + versioning
	•	Activity feed

Module B — Change Orders (revenue-critical)
	•	Draft → send → approve (client portal)
	•	Signatures/approval evidence
	•	Budget impacts via cost codes
	•	PDF output + email

Module C — Estimating / Proposal
	•	Templates + item catalog
	•	Markup rules
	•	Proposal send/accept
	•	Convert to contract/project budget skeleton

Module D — Budgeting/Job Costing Lite
	•	Budget lines by cost code
	•	Commitments (PO/subcontract)
	•	Bills + receipts capture
	•	Actual vs budget views

Module E — Portals (retention-critical)
	•	Client portal: progress/photos/approvals/invoices
	•	Sub portal: tasks/files/doc submissions/billing

Module F — Local Compliance Packs (local moat)
	•	Local permit/inspection templates
	•	Readiness checklists
	•	Required docs tracker

⸻

8) Integrations Strategy (keep it manageable)

Position

Integrations are valuable. Make them phased and architecture-safe.

Accounting (high ROI) — begin with QuickBooks Online

V1 scope (minimal, shippable):
	•	Export invoices (AR) to QBO
	•	Sync customers/vendors basic
	•	Pull invoice/payment status back

Guardrails:
	•	Use integration_accounts + integration_mappings (local id ↔ remote id)
	•	Use outbox/jobs with retries and idempotency
	•	Start with manual “Export” then enable auto-sync later

CRM

Do not start with deep CRM integrations.
	•	Ship CRM-lite: contacts/companies + lead→estimate pipeline.
	•	Offer Zapier/Make/webhooks first.

Simple early integrations
	•	Google Calendar export
	•	Drive/Dropbox import/export

⸻

9) Plugin & Customization Model (prevents forks)

Plugin concept

A plugin is a bounded feature bundle that can contain:
	•	UI routes/pages/components
	•	Permissions
	•	DB migrations (optional)
	•	Workflow templates
	•	Reports

Customizations should be mostly:
	•	Custom fields/forms
	•	Workflow rules
	•	Local template packs
	•	White-label branding
	•	Role/permission presets

Hard rule

Never create a customer-specific branch. If something must be custom, it is:
	•	config-only, or
	•	an isolated plugin

⸻

10) Operational Requirements

Security
	•	RLS policies on all tenant-owned tables
	•	Signed URLs for file access
	•	Audit trails for approvals/financial edits
	•	Separate auth roles for internal users vs clients/subs

Reliability
	•	Background job retries
	•	Webhook signature verification
	•	Dead-letter patterns for failed sync

Observability
	•	Central error tracking
	•	Integration sync logs visible in admin UI
	•	Metrics: active orgs, DAU, feature usage, churn signals

⸻

11) Roadmap (build order)

Phase 0 (Weeks 1–4): Foundation (✅ Complete)
	•	Org/projects/memberships/roles + RLS
	•	Files + file_links
	•	Event stream + activity feed
	•	Core UI shell

Phase 1.1 (✅ Complete): Authentication & Real Data
	•	Supabase Auth integration (sign up/in/reset)
	•	Organization membership flows
	•	Protected routes and session management
	•	Remove mock data fallbacks

Phase 1 (Weeks 5–12): Sellable MVP (Project Ops) (~95% Complete)
	•	Tasks (✅ implemented)
	•	Schedule (list/calendar) (✅ implemented)
	•	Daily logs + photos (✅ implemented)
	•	Basic client/sub portal (view + messages) (✅ implemented)
	•	Notifications (in-app + email) - Outbox ready, delivery system needed

Phase 2 (Months 4–6): Money features
	•	Estimates + proposals
	•	Change orders end-to-end
	•	Budget skeleton + CO impacts

Phase 3 (Months 7–9): Job costing lite + billing basics
	•	Commitments
	•	Bills/receipts
	•	Invoices/payments
	•	QuickBooks Online integration V1

Phase 4 (Months 10–12): Customization + local moat
	•	Custom fields & forms UI
	•	Workflow UI
	•	Local template packs
	•	Reporting v1

Phase 5 (Year 2): AI/Automation add-ons
	•	OCR receipts
	•	Draft daily logs from voice/photos
	•	Project Q&A over docs + logs
	•	Risk alerts

⸻

12) Definition of Done (MVP)

An org can:
	•	Create a project, add members, set schedule items (✅ implemented)
	•	Capture daily logs + photos from phone (✅ implemented)
	•	Upload/manage files and share via portal (✅ implemented)
	•	Assign tasks/punch items and track completion (✅ implemented)
	•	Send client updates (messages + notifications) - Notifications pending

And the system has:
	•	Tenant isolation (RLS) (✅ implemented)
	•	Event feed (✅ implemented)
	•	Audit log for critical actions (✅ implemented)
	•	Feature flags/entitlements (✅ implemented)

⸻

13) Implementation Notes (LLM-friendly guidance)

Conventions
	•	All tables: id (uuid), org_id, created_at, updated_at
	•	Most project entities: also project_id
	•	Attachments: use file_links polymorphic referencing (entity_type, entity_id)
	•	Approvals: generic approvals table referencing (entity_type, entity_id)
	•	Events: store event_type, entity_type, entity_id, payload_json

Avoiding tech debt
	•	Keep domain rules in service layer.
	•	Use feature flags instead of branching code.
	•	Plugins/config only for custom clients.

⸻

14) Glossary
	•	Org: tenant/company
	•	Project: construction job
	•	Commitment: PO/subcontract amount committed
	•	CO: change order
	•	RLS: Row Level Security
	•	Outbox: DB pattern for reliable async processing

⸻

15) Next Steps (immediate)
	1.	Implement tenancy + permissions + RLS scaffolding.
	2.	Implement files + file_links.
	3.	Implement events + activity feed.
	4.	Build Projects + Tasks + Schedule + Daily Logs + Photos.
	5.	Onboard first local builder and iterate weekly.

16) Progress snapshot (updated)
	•	[x] UI shell scaffolded
	•	[x] Database foundation (tenancy, roles/permissions, billing models, feature flags, audit/events/outbox, files)
	•	[x] Phase 1 data model (projects, tasks, schedule, daily logs, photos, conversations/messages, notifications)
	•	[x] Phase 1 app/API (CRUD + permission checks wired to services)
	•	[x] Phase 1 UI flows (projects, tasks, schedule, daily logs, photos, portal)
	•	[x] Activity feed implementation (real-time events)
	•	[x] Phase 0 Complete: Service layer, server actions, UI components, RLS enforcement, event/audit plumbing
	•	[x] Phase 1.1: Authentication implementation (sign up/in, org membership, remove mock data)
	•	[x] Foundation: All core architecture patterns implemented and tested
	•	[ ] Phase 1 final: Notifications delivery (in-app + email/SMS/webhook) - MVP ready otherwise
