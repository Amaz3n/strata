-- Workstream 07 foreign-key covering indexes. Includes two pre-existing
-- warranty_requests relationships used by the expanded queue and portal joins.

create index if not exists warranty_backcharges_cost_code_idx
  on public.warranty_backcharges (cost_code_id) where cost_code_id is not null;
create index if not exists warranty_backcharges_issued_by_idx
  on public.warranty_backcharges (issued_by) where issued_by is not null;
create index if not exists warranty_request_photos_created_by_idx
  on public.warranty_request_photos (created_by) where created_by is not null;
create index if not exists warranty_requests_assigned_company_idx
  on public.warranty_requests (assigned_company_id) where assigned_company_id is not null;
create index if not exists warranty_requests_requested_by_idx
  on public.warranty_requests (requested_by) where requested_by is not null;
create index if not exists warranty_service_visits_buyer_signature_file_idx
  on public.warranty_service_visits (buyer_signature_file_id) where buyer_signature_file_id is not null;
create index if not exists warranty_service_visits_completed_by_idx
  on public.warranty_service_visits (completed_by) where completed_by is not null;
create index if not exists warranty_service_visits_project_idx
  on public.warranty_service_visits (project_id);
create index if not exists warranty_visit_photos_created_by_idx
  on public.warranty_visit_photos (created_by) where created_by is not null;
