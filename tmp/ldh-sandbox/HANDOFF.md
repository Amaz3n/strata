# Lifestyle Design Homes — Sandbox

## Current configuration update

Final simplification: all sample vendor price agreements were removed to hide Purchasing. Exactly two projects remain: Naples Coastal Custom — Sample (residential) and Estero Wellness & Showroom — Sample (commercial). The other eight sample projects and their dependent project records were deleted after a successful rollback rehearsal. A database recovery snapshot was saved in `audit_log` with source `sandbox_cleanup_snapshot`. Org tier remains residential. This supersedes the project counts and provisioning tour below. Verification was database-only, as requested.

Latest update: the user subsequently requested residential org posture. The org's `product_tier` is now `residential`, verified in the database. All ten projects and their data remain; the commercial sample project retains its project-specific commercial type. There are still zero production projects. This supersedes the commercial org configuration described below.

At the user's request, all seven production sample projects were reclassified as residential. The org remains commercial: nine residential projects, one commercial project, and zero production projects. This removes the production navigation trigger. Existing sample records were preserved. Verified by database query only; the user will check the browser manually. The original hybrid setup and tour below describe the initial provisioning, not the current navigation.

Created September 16, 2026. Organization ID: `fafc5e08-24d5-50a1-9ab4-7819306a2768`. Slug: `lifestyle-design-homes-sandbox`.

Open https://app.arcnaples.com and select **Lifestyle Design Homes — Sandbox**. Agustin's existing `agustin@arcnaples.com` account has owner membership. The client owner name/email has not yet been supplied, so no client invitation was created or sent. Local trial ends October 16, 2026; no Stripe subscription was purchased.

## Hybrid configuration

The org uses commercial posture with residential, commercial, and production projects. Arc's sidebar exposes Sales, Pipeline, Communities, Plans, Design Studio, Starts, Projects, Warranty, Purchasing, Billing, Payables, Bids, Schedule, Directory, Reports, and Safety. Project navigation adapts to each project's property type. One org supports this mixed evaluation; separate organizations are unnecessary for the sandbox. Commercial is a configuration choice, not a custom pricing agreement.

## Suggested tour

1. **Pipeline:** six fictional prospects; three editable estimates and proposals.
2. **Naples Coastal Custom:** budget, draw schedule, RFIs, submittals, decisions, document files, illustrated countertop sheet, logs, photos, punch, expenses, and a waterfall-edge change order.
3. **Bonita Interior Renovation:** finish choices, cabinet/stone coordination, sample purchasing and billing.
4. **Estero Wellness & Showroom:** commercial budget/SOV, bids, meeting, specifications, transmittal, inspection, toolbox talk, and clearly fictional safety scenario.
5. **Production:** one scattered-site community, eight lots, three released plan bundles with twelve-trade takeoffs/budgets, 36 active trade price agreements, buyer holds, three upcoming start packages and their gates, selections/catalog/pricing, appointments, closings, and warranty requests.
6. **Office:** cross-project tasks, schedules, draft invoices, pending vendor bills, directory, report menus and purchasing.

There are ten projects: eight detailed examples plus two preconstruction release jobs. Seven delivery/completed jobs appear in Projects; the three preconstruction jobs appear in Starts. Sample projects include spec, presale, upcoming start, closing, and warranty stages.

All contacts and operational figures are fictional. Emails use example.com. Website photos are labeled reference-only and attributed to their public LDH source; they are not construction progress photos. Files include two PDFs, photo references and synthetic correspondence. No messages, invoices, signatures or bid invitations were sent. No payment, bank, or accounting integration was connected. Draft financial records intentionally leave approval and billing exercises available; actual paid-cost/cash metrics remain zero.

## Product fit

Interiors and stone are represented through company records, selections, decisions, documents, schedule activities, commitments, and change orders. This does not add interior-design authoring, slab inventory, nesting, fabrication/CNC, remnant tracking, or a standalone stone quoting system. Those remain candidates for separately scoped paid features. No 3D model was supplied or fabricated.

## Verification and remaining issues

- Financial sums checked against lines for budgets, invoices, commitments and bills: zero mismatches.
- Authenticated owner visibility compared with administrative counts across 79 populated tables: zero mismatches.
- Lot-to-plan version links verified. Released v2 bundles use complete costs and display approximately 19–21% margin including average lot costs. Older partial v1 bundles and prices were superseded, preserving normal immutable history.
- Browser checked hybrid sidebar and populated Home, Tasks, Sales, Pipeline, Communities, Plans, Design Studio, Starts, Purchasing, Projects, Billing, Payables, Bids, Schedule, Directory, Reports and Safety. Representative residential/commercial/production overview pages and residential RFIs, submittals, decisions, budget, closeout, daily logs, documents and drawing viewer were inspected.
- Sample drawing tiles generated, uploaded, indexed and visually verified in Arc's actual viewer. PDF artifacts rendered and visually inspected.
- **Warranty desk remains blocked by an existing app query bug:** `lib/services/warranty-operations.ts`, `listWarrantyRequestsForOrg`, embeds `lot:lots!lots_project_id_fkey(...)` directly from warranty_requests. PostgREST returns PGRST200: no relationship between warranty_requests and lots. Authorization succeeded; the three sample requests and aggregate SQL functions work. A code fix should join lots through projects (and update filtering/mapping) and be verified/deployed separately.
- **Directory compliance status unavailable** in the live UI. Directory records render, but the compliance panel reports a load failure. No compliance certificates or verified status were fabricated.

No application code was changed or deployed. Existing unrelated local code changes were preserved.

## Website references

https://lifestyledesignhomes.com/
https://lifestyledesignhomes.com/about-us/
https://lifestyledesignhomes.com/floor-plans/
https://lifestyledesignhomes.com/available-homes/

The Gold/Noir/Luxe-inspired sample plans are evaluation fixtures, not copies of actual LDH construction plans or price quotes.
