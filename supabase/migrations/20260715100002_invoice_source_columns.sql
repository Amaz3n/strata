-- Promote invoice source linkage out of metadata JSONB into real columns.
--
-- "One invoice per draw / change order / pay application" was previously enforced
-- by fetching EVERY invoice in the org and scanning metadata in JS on each
-- create/update (assertSourceNotAlreadyBilled) — O(all invoices) per write and
-- racy under concurrency. Real columns + partial unique indexes make the DB the
-- enforcer and the lookup indexed. metadata keeps the same keys for display and
-- backward compatibility; the columns are the enforcement surface.
-- (Draws additionally keep their truthful link in draw_schedules.invoice_id.)

alter table public.invoices
  add column if not exists source_type text,
  add column if not exists source_draw_id uuid,
  add column if not exists source_change_order_id uuid,
  add column if not exists source_pay_application_id uuid;

update public.invoices
   set source_type = nullif(metadata->>'source_type', ''),
       source_draw_id = nullif(metadata->>'source_draw_id', '')::uuid,
       source_change_order_id = nullif(metadata->>'source_change_order_id', '')::uuid,
       source_pay_application_id = nullif(metadata->>'source_pay_application_id', '')::uuid
 where metadata is not null
   and (source_type is null and source_draw_id is null
        and source_change_order_id is null and source_pay_application_id is null);

-- One live (non-void) invoice per source. Duplicates must be resolved before
-- this migration applies; the index creation fails loudly if any exist.
create unique index if not exists invoices_source_draw_unique
  on public.invoices (org_id, source_draw_id)
  where source_draw_id is not null and status <> 'void';

create unique index if not exists invoices_source_change_order_unique
  on public.invoices (org_id, source_change_order_id)
  where source_change_order_id is not null and status <> 'void';

create unique index if not exists invoices_source_pay_application_unique
  on public.invoices (org_id, source_pay_application_id)
  where source_pay_application_id is not null and status <> 'void';
