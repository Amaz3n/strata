-- Lot plat coordinates.
--
-- The community workbench draws the plat every production office has on its
-- wall. Until now it auto-wrapped lots into rows grouped by phase, which reads
-- as a legend rather than a map. These columns let somebody arrange a community
-- once, on a coarse integer grid, so the on-screen plat matches the recorded
-- one. Both stay nullable: a lot without coordinates falls back to the
-- auto-layout, so no community is broken by not having been arranged yet.

alter table public.lots
  add column if not exists plat_x integer,
  add column if not exists plat_y integer;

comment on column public.lots.plat_x is
  'Column on the community plat grid. Null means fall back to auto-layout.';
comment on column public.lots.plat_y is
  'Row on the community plat grid. Null means fall back to auto-layout.';

-- The plat reads every positioned lot in one community at once.
create index if not exists lots_plat_position_idx
  on public.lots (org_id, community_id, plat_y, plat_x)
  where plat_x is not null and plat_y is not null;
