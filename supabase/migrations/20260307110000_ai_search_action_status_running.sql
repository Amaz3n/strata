alter table if exists public.ai_search_action_requests
  drop constraint if exists ai_search_action_requests_status_check;

alter table if exists public.ai_search_action_requests
  add constraint ai_search_action_requests_status_check
  check (status in ('proposed', 'running', 'executed', 'rejected', 'failed'));
