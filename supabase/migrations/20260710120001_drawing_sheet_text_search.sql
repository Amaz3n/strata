-- Full-text search over drawing sheet content.
--
-- The pipeline extracts every page's text during split but previously threw
-- it away after title-block detection. Persist it per sheet version and index
-- it so users can search the *content* of the drawings ("roof drain"), not
-- just sheet numbers/titles.

alter table public.drawing_sheet_versions
  add column if not exists page_text text;

-- Generated tsvector (explicit config keeps to_tsvector immutable). Sheet
-- text is small (a few KB of title-block + notes), the cap is a guard.
alter table public.drawing_sheet_versions
  add column if not exists page_text_tsv tsvector
  generated always as (to_tsvector('english', left(coalesce(page_text, ''), 200000))) stored;

create index if not exists drawing_sheet_versions_page_text_tsv_idx
  on public.drawing_sheet_versions using gin (page_text_tsv);

-- Ranked content search over each sheet's CURRENT published version, with a
-- ts_headline snippet. SECURITY DEFINER + service_role-only: callers go
-- through the drawings service, which enforces org context + drawing.read.
create or replace function public.search_drawing_sheets(
  p_org_id uuid,
  p_project_id uuid,
  p_query text,
  p_limit integer default 20
)
returns table (
  sheet_id uuid,
  version_id uuid,
  snippet text,
  rank real
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.id as sheet_id,
    v.id as version_id,
    ts_headline(
      'english',
      left(coalesce(v.page_text, ''), 20000),
      websearch_to_tsquery('english', p_query),
      'MaxWords=18, MinWords=8, ShortWord=2, MaxFragments=1'
    ) as snippet,
    ts_rank(v.page_text_tsv, websearch_to_tsquery('english', p_query)) as rank
  from public.drawing_sheet_versions v
  join public.drawing_sheets s
    on s.id = v.drawing_sheet_id
   and s.current_revision_id = v.drawing_revision_id
  where v.org_id = p_org_id
    and s.org_id = p_org_id
    and s.project_id = p_project_id
    and v.page_text_tsv @@ websearch_to_tsquery('english', p_query)
  order by rank desc
  limit least(greatest(p_limit, 1), 50);
$$;

revoke all on function public.search_drawing_sheets(uuid, uuid, text, integer) from public;
revoke all on function public.search_drawing_sheets(uuid, uuid, text, integer) from anon;
revoke all on function public.search_drawing_sheets(uuid, uuid, text, integer) from authenticated;
grant execute on function public.search_drawing_sheets(uuid, uuid, text, integer) to service_role;
