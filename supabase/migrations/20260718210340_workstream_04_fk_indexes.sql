-- Workstream 04 post-deploy hardening: direct covering indexes for new foreign
-- keys. Composite indexes whose leading column is org_id do not cover these
-- referential-integrity lookups.

create index bid_packages_community_fk_idx
  on public.bid_packages (community_id);

create index commitment_change_orders_reason_code_fk_idx
  on public.commitment_change_orders (reason_code_id);

create index po_generation_runs_project_fk_idx
  on public.po_generation_runs (project_id);

create index po_generation_exceptions_project_fk_idx
  on public.po_generation_exceptions (project_id);

create index po_completions_project_fk_idx
  on public.po_completions (project_id);
create index po_completions_commitment_fk_idx
  on public.po_completions (commitment_id);
create index po_completions_reported_by_user_fk_idx
  on public.po_completions (reported_by_user_id);
create index po_completions_verified_by_fk_idx
  on public.po_completions (verified_by);
create index po_completions_approved_by_fk_idx
  on public.po_completions (approved_by);

create index vendor_price_agreements_company_fk_idx
  on public.vendor_price_agreements (company_id);
create index vendor_price_agreements_cost_code_fk_idx
  on public.vendor_price_agreements (cost_code_id);
create index vendor_price_agreements_community_fk_idx
  on public.vendor_price_agreements (community_id);
create index vendor_price_agreements_house_plan_fk_idx
  on public.vendor_price_agreements (house_plan_id);
create index vendor_price_agreements_created_by_fk_idx
  on public.vendor_price_agreements (created_by);
