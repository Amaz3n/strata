-- Workstream 08 rollout gates. READ ONLY. Save one result snapshot before each
-- application deploy and compare it with the 24h/48h and 14-day snapshots.

-- HARDENING MIGRATION PREFLIGHT. Both queries must return zero rows before
-- 20260724010343_accounting_abstraction_hardening.sql is applied.
select provider, external_account_id, count(*) as active_owners,
       array_agg(id order by id) as connection_ids,
       array_agg(org_id order by org_id) as org_ids
from public.accounting_connections
where status = 'active'
group by provider, external_account_id
having count(*) > 1;

select org_id, connection_id, entity_type, entity_id, count(*) as duplicate_rows
from public.accounting_sync_records
group by org_id, connection_id, entity_type, entity_id
having count(*) > 1;

-- Zero-downtime compatibility: both pairs must stay equal until B3.
select
  (select count(*) from public.accounting_connections) as neutral_connections,
  (select count(*) from public.qbo_connections) as legacy_connections,
  (select count(*) from public.accounting_sync_records) as neutral_sync_records,
  (select count(*) from public.qbo_sync_records) as legacy_sync_records;

-- Patagonia's production connection guard. This row must retain its id, realm,
-- active status, zero refresh failures, and null last_error across every gate.
select c.id, c.org_id, c.provider, c.external_account_id, c.status,
       c.refresh_failure_count, c.refresh_token_expires_at, c.last_error
from public.accounting_connections c
join public.orgs o on o.id = c.org_id
where o.name = 'Patagonia Development LLC' and c.provider = 'qbo';

-- Counterparty links must never cross org/provider boundaries.
select l.*
from public.accounting_counterparty_links l
left join public.accounting_connections c
  on c.id = l.connection_id and c.org_id = l.org_id and c.provider = l.provider
where c.id is null;

-- Sync ledger error rate by provider/entity/day.
select provider, entity_type, date_trunc('day', last_synced_at) as day,
       count(*) as attempts,
       count(*) filter (where status in ('error','needs_review','conflict')) as failures,
       round(100.0 * count(*) filter (where status in ('error','needs_review','conflict'))
             / nullif(count(*), 0), 2) as failure_pct
from public.accounting_sync_records
where last_synced_at >= now() - interval '14 days'
group by 1,2,3 order by 3 desc,1,2;

-- Provider-neutral and legacy outbox depth. Legacy types must be zero before D.
select job_type, status, count(*) as jobs, min(created_at) as oldest
from public.outbox
where job_type like 'accounting_push_%' or job_type like 'qbo_sync_%'
group by 1,2 order by 1,2;

-- CDC freshness per active QBO accounting file.
select id, org_id, label, external_account_name,
       settings->>'qbo_cdc_last_synced_at' as cdc_cursor,
       now() - (settings->>'qbo_cdc_last_synced_at')::timestamptz as cursor_age,
       last_sync_at, last_error
from public.accounting_connections
where provider='qbo' and status='active'
order by cursor_age desc nulls first;

-- Webhook retry/dead-letter pressure.
select process_status, count(*) as events, max(attempts) as max_attempts,
       min(received_at) filter (where process_status in ('pending','failed')) as oldest_waiting
from public.qbo_webhook_events
group by process_status order by process_status;

-- Multi-entity routing proof: the ledger connection must equal today's resolved
-- project map for project-owned invoice/expense/bill rows. Any row is a gate stop.
with project_records as (
  select r.id, r.org_id, r.connection_id, r.entity_type, r.entity_id, i.project_id
  from public.accounting_sync_records r join public.invoices i on r.entity_type='invoice' and i.id=r.entity_id
  union all
  select r.id, r.org_id, r.connection_id, r.entity_type, r.entity_id, e.project_id
  from public.accounting_sync_records r join public.project_expenses e on r.entity_type='project_expense' and e.id=r.entity_id
  union all
  select r.id, r.org_id, r.connection_id, r.entity_type, r.entity_id, b.project_id
  from public.accounting_sync_records r join public.vendor_bills b on r.entity_type in ('bill','vendor_credit') and b.id=r.entity_id
), resolved as (
  select pr.*, coalesce(pm.connection_id, cm.connection_id, dm.connection_id, om.connection_id) as resolved_connection_id
  from project_records pr
  left join public.projects p on p.id=pr.project_id
  left join public.lots l on l.project_id=pr.project_id
  left join public.accounting_entity_map pm on pm.org_id=pr.org_id and pm.project_id=pr.project_id
  left join public.accounting_entity_map cm on cm.org_id=pr.org_id and cm.community_id=l.community_id
  left join public.accounting_entity_map dm on dm.org_id=pr.org_id and dm.division_id=p.division_id
  left join public.accounting_entity_map om on om.org_id=pr.org_id and om.scope='org_default'
)
select * from resolved
where resolved_connection_id is distinct from connection_id;
