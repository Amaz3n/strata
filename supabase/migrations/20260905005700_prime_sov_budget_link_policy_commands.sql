-- Keep authenticated reads and writes distinct so SELECT evaluates one policy.
drop policy if exists prime_sov_budget_links_write on public.prime_sov_budget_links;

create policy prime_sov_budget_links_insert
on public.prime_sov_budget_links
for insert to authenticated
with check (
  public.has_org_permission(org_id, 'sov.write') and exists (
    select 1
    from public.prime_sov_lines s
    join public.budget_lines l on l.id = prime_sov_budget_links.budget_line_id
    join public.budgets b on b.id = l.budget_id
    where s.id = prime_sov_budget_links.prime_sov_line_id
      and s.org_id = prime_sov_budget_links.org_id
      and s.project_id = prime_sov_budget_links.project_id
      and s.contract_id = prime_sov_budget_links.contract_id
      and l.org_id = s.org_id
      and b.org_id = s.org_id
      and b.project_id = s.project_id
  )
);

create policy prime_sov_budget_links_update
on public.prime_sov_budget_links
for update to authenticated
using (public.has_org_permission(org_id, 'sov.write'))
with check (
  public.has_org_permission(org_id, 'sov.write') and exists (
    select 1
    from public.prime_sov_lines s
    join public.budget_lines l on l.id = prime_sov_budget_links.budget_line_id
    join public.budgets b on b.id = l.budget_id
    where s.id = prime_sov_budget_links.prime_sov_line_id
      and s.org_id = prime_sov_budget_links.org_id
      and s.project_id = prime_sov_budget_links.project_id
      and s.contract_id = prime_sov_budget_links.contract_id
      and l.org_id = s.org_id
      and b.org_id = s.org_id
      and b.project_id = s.project_id
  )
);

create policy prime_sov_budget_links_delete
on public.prime_sov_budget_links
for delete to authenticated
using (public.has_org_permission(org_id, 'sov.write'));
