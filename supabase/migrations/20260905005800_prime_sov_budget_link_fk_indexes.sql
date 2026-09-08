-- Cover FK maintenance paths independently of the organization-scoped query indexes.
create index prime_sov_budget_links_project_fk_idx
  on public.prime_sov_budget_links(project_id);

create index prime_sov_budget_links_contract_fk_idx
  on public.prime_sov_budget_links(contract_id);
