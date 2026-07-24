-- accounting_import_claims is an internal lease/identity table. Client roles
-- must never read or mutate it; service_role retains its existing access.
create policy accounting_import_claims_deny_client_access
  on public.accounting_import_claims
  for all
  to anon, authenticated
  using (false)
  with check (false);
