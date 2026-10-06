-- STAGED / UNAPPLIED. public.pg_trgm is present in the authoritative base schema.
-- Verify actual plans and index-build operational impact before rollout.
create index catalog_member_option_name_search_idx on public.selection_options using gin (lower(name) public.gin_trgm_ops);
create index catalog_member_category_name_search_idx on public.selection_categories using gin (lower(name) public.gin_trgm_ops);
