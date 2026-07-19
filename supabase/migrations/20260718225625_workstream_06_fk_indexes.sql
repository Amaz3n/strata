-- Cover Workstream 06 foreign keys where the primary read index begins with
-- org_id and therefore cannot serve FK maintenance from the referenced side.
create index lot_reservations_community_fk_idx on public.lot_reservations (community_id);
create index incentives_community_fk_idx on public.incentives (community_id)
  where community_id is not null;
create index closings_community_fk_idx on public.closings (community_id)
  where community_id is not null;
create index closing_checklist_items_closing_fk_idx on public.closing_checklist_items (closing_id);
