-- Per-project sequential change order numbers (CO-001, CO-002, ... scoped to each project).
-- Existing change orders predate this column, so we backfill by created_at order per project,
-- then assign new numbers via a BEFORE INSERT trigger so every insert path is covered.

alter table "public"."change_orders"
  add column if not exists "co_number" integer;

-- Backfill existing rows: number sequentially within each project, oldest first.
with numbered as (
  select
    "id",
    row_number() over (partition by "project_id" order by "created_at", "id") as "rn"
  from "public"."change_orders"
)
update "public"."change_orders" co
set "co_number" = numbered."rn"
from numbered
where co."id" = numbered."id"
  and co."co_number" is null;

-- Assign the next per-project number on insert (covers native creation, imports, etc.).
create or replace function "public"."assign_change_order_number"()
returns trigger
language plpgsql
as $$
begin
  if new."co_number" is null then
    -- Serialize concurrent inserts for the same project so numbers don't collide.
    perform pg_advisory_xact_lock(hashtextextended(new."project_id"::text, 0));
    select coalesce(max("co_number"), 0) + 1
      into new."co_number"
      from "public"."change_orders"
      where "project_id" = new."project_id";
  end if;
  return new;
end;
$$;

drop trigger if exists "trg_assign_change_order_number" on "public"."change_orders";
create trigger "trg_assign_change_order_number"
  before insert on "public"."change_orders"
  for each row
  execute function "public"."assign_change_order_number"();

-- One number per project. Voided/deleted orders keep their number (gaps are expected).
create unique index if not exists "change_orders_project_co_number_key"
  on "public"."change_orders" ("project_id", "co_number");
