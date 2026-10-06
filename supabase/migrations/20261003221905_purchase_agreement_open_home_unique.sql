-- One open purchase agreement owns a home. Prevents competing creation requests
-- from inserting two instruments before either links its reservation.
-- Approval/application required. Existing conflicting agreements must be
-- reconciled explicitly; this migration never chooses or deletes a winner.
begin;
do $$
begin
  if exists (
    select 1 from public.contracts
    where contract_type = 'purchase_agreement' and status in ('draft', 'active')
      and project_id is not null
    group by org_id, project_id having count(*) > 1
  ) then
    raise exception 'Reconcile homes with multiple open purchase agreements before applying ownership enforcement';
  end if;
end $$;
create unique index contracts_open_purchase_agreement_home_unique
  on public.contracts (org_id, project_id)
  where contract_type = 'purchase_agreement' and status in ('draft', 'active');
commit;
