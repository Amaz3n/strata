-- Find a home filters and sorts on what a lot costs and how long it has stood.
--
-- Both are derived, not stored: the asking price comes from the community's
-- price sheet (an elevation's own row outranks the plan-wide row, only rows on
-- sale today count) plus the lot premium and the home's confirmed structural
-- options, unless the lot carries its own asking price; the age is the days
-- since Books recorded the home's completion into finished inventory. The
-- application displays the price this view derives (it does not recompute it),
-- so the price a band, a sort and the screen agree on has exactly one formula;
-- the age is derived in lib/sales/spec-inventory.ts specInventoryAge as well.
--
-- security_invoker: the org RLS on lots, communities, plans and the price sheet
-- applies to whoever selects from it. Callers still filter on org_id.
--
-- The asking price of a home must not depend on who asks. project_selections is
-- RLS-limited to project members and org admins, so a sales consultant reading
-- it directly would price a home without its confirmed structural options.
-- project_structural_option_cents is the one narrow door through it: a definer
-- function that returns a single number (the total of the home's confirmed
-- structural options) for a project in an organisation the caller belongs to,
-- and nothing about the selections themselves.

create or replace function public.project_structural_option_cents(p_project_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select sum(ps.price_cents_snapshot)::bigint
  from public.projects p
  join public.project_selections ps on ps.org_id = p.org_id and ps.project_id = p.id
  join public.selection_options so on so.id = ps.selected_option_id and so.org_id = ps.org_id
  where p.id = p_project_id
    and (
      (select auth.role()) = 'service_role'
      -- Division scope is the enforcement layer: a member reaches the total only for a home in a
      -- division they work in. Project assignment is deliberately not required, so everyone who
      -- can sell in a division sees the same asking price.
      or exists (
        select 1
        from public.memberships m
        where m.org_id = p.org_id
          and m.user_id = (select auth.uid())
          and m.status = 'active'
          and (
            public.membership_is_org_admin(m.id, m.role_id)
            or m.division_scope = 'all'
            or exists (
              select 1 from public.membership_divisions md
              where md.membership_id = m.id and md.division_id = p.division_id
            )
          )
      )
    )
    and ps.status in ('confirmed', 'ordered', 'received')
    and so.option_scope = 'structural';
$$;

revoke all on function public.project_structural_option_cents(uuid) from public, anon;
grant execute on function public.project_structural_option_cents(uuid) to authenticated, service_role;

create or replace view public.sellable_lot_inventory
with (security_invoker = true)
as
select
  l.id           as lot_id,
  l.org_id,
  l.community_id,
  l.division_id,
  l.project_id,
  l.status,
  l.lot_number,
  l.block,
  concat_ws('-', nullif(l.block, ''), l.lot_number) as lot_label,
  l.house_plan_id,
  l.created_at,
  c.name         as community_name,
  hp.code        as plan_code,
  hp.name        as plan_name,
  hp.beds        as plan_beds,
  case
    when l.asking_price_override_cents is not null then l.asking_price_override_cents
    when base.base_price_cents is null then null
    else base.base_price_cents + l.premium_cents + coalesce(public.project_structural_option_cents(l.project_id), 0)
  end            as asking_price_cents,
  case
    when fs.books_inventory_completed_on is not null and fs.books_inventory_completed_on <= current_date
      then current_date - fs.books_inventory_completed_on
    else 0
  end            as aging_days
from public.lots l
left join public.communities c on c.id = l.community_id and c.org_id = l.org_id
left join public.house_plans hp on hp.id = l.house_plan_id and hp.org_id = l.org_id
left join lateral (
  select a.base_price_cents
  from public.community_plan_availability a
  where a.org_id = l.org_id
    and a.community_id = l.community_id
    and a.house_plan_id = l.house_plan_id
    and a.is_available
    and (a.elevation_id is null or a.elevation_id = l.house_plan_elevation_id)
    and (a.effective_start is null or a.effective_start <= current_date)
    and (a.effective_end is null or a.effective_end >= current_date)
  order by (a.elevation_id is not null) desc
  limit 1
) base on l.house_plan_id is not null
left join lateral (
  select s.books_inventory_completed_on
  from public.project_financial_settings s
  where s.org_id = l.org_id and s.project_id = l.project_id
  order by s.books_inventory_completed_on desc nulls last
  limit 1
) fs on l.project_id is not null;

comment on view public.sellable_lot_inventory is
  'One row per lot with the facts Find a home filters and sorts on: community and plan names, bedrooms, the derived asking price (null when the sheet does not price the plan) and the days a finished home has stood. security_invoker so the org RLS on the base tables applies to whoever selects from it.';

grant select on public.sellable_lot_inventory to authenticated;
grant select on public.sellable_lot_inventory to service_role;
