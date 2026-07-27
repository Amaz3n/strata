-- What's New moves from "one row per feature" to "one row per release".
-- A release carries a version, a product area (what the filter chips filter by),
-- and its shipped features inline as `items`. The per-feature change type
-- (new/improved/fixed) moves onto each item; the row-level `category` column,
-- which conflated change type with product area, is retired.

alter table public.release_notes
  add column if not exists version text,
  add column if not exists area text,
  add column if not exists items jsonb not null default '[]'::jsonb;

-- Existing rows become single releases. 'admin' and 'mobile' were already areas;
-- 'new' / 'improved' / 'fixed' described a change type, so those land in 'general'.
update public.release_notes
set area = case category
    when 'admin' then 'admin'
    when 'mobile' then 'mobile'
    else 'general'
  end
where area is null;

alter table public.release_notes
  alter column area set default 'general';

alter table public.release_notes
  alter column area set not null;

-- The 2026-07-06 batch was authored as one release split across 16 rows:
-- 'summer-2026-major-update' is the headline and the other 15 are its features.
-- Fold them in, carrying each row's category across as the item's change type and
-- keeping its deep link. Scoped to that exact publish timestamp so a re-run on a
-- fresh database (or any later release) is a no-op.
update public.release_notes r
set
  items = coalesce(
    (
      select jsonb_agg(
        jsonb_build_object(
          'type', f.category,
          'title', f.title,
          'detail', f.summary,
          'href', f.href
        )
        order by
          case f.category when 'new' then 0 when 'improved' then 1 else 2 end,
          f.created_at
      )
      from public.release_notes f
      where f.published_at = r.published_at
        and f.slug <> 'summer-2026-major-update'
    ),
    '[]'::jsonb
  ),
  -- The headline's CTA pointed at /whats-new, which is where the reader already is.
  href = null,
  cta_label = null
where r.slug = 'summer-2026-major-update';

delete from public.release_notes
where slug <> 'summer-2026-major-update'
  and published_at = (
    select published_at
    from public.release_notes
    where slug = 'summer-2026-major-update'
  );

alter table public.release_notes
  drop constraint if exists release_notes_category_check;

alter table public.release_notes
  drop column if exists category;

alter table public.release_notes
  drop constraint if exists release_notes_area_check;

alter table public.release_notes
  add constraint release_notes_area_check
  check (area in ('general', 'projects', 'financials', 'field', 'admin', 'mobile'));

alter table public.release_notes
  drop constraint if exists release_notes_items_array_check;

alter table public.release_notes
  add constraint release_notes_items_array_check
  check (jsonb_typeof(items) = 'array');

create index if not exists release_notes_area_idx
  on public.release_notes (area);
