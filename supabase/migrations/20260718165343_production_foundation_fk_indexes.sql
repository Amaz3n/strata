create index if not exists communities_division_fk_idx
  on public.communities (division_id) where division_id is not null;

create index if not exists lot_takedowns_community_fk_idx
  on public.lot_takedowns (community_id);
create index if not exists lot_takedowns_phase_fk_idx
  on public.lot_takedowns (community_phase_id) where community_phase_id is not null;
create index if not exists lot_takedowns_seller_company_fk_idx
  on public.lot_takedowns (seller_company_id) where seller_company_id is not null;

create index if not exists lots_phase_fk_idx
  on public.lots (community_phase_id) where community_phase_id is not null;
create index if not exists lots_division_fk_idx
  on public.lots (division_id) where division_id is not null;
