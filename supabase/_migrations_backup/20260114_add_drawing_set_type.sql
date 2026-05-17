alter table if exists public.drawing_sets
add column if not exists set_type text;
