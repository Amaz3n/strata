-- Row-graph copier for the scale seed (production-scale-seed.cjs, EP13-01). Session
-- functions only (pg_temp): nothing is installed in the database.
--
-- sc_collect gathers a template's row graph into sc_g: the roots, every row of the
-- given projects, the parents named in p_parents (a home's buyer), and then every row
-- that references a gathered row through a single-column foreign key, until nothing
-- new is found. Rows of another organisation and the tables in p_exclude never enter.
--
-- sc_clone writes one copy of sc_g per row of sc_targets: each gathered id gets a
-- fresh id, every value that names a gathered id (any column, not only declared
-- foreign keys) names its copy, sc_targets.overrides re-points ids outside the graph
-- (the target lot, community, division), columns that reference p_null_parents are
-- cleared, and text columns of a unique key that is not scoped by a copied id take
-- the target's suffix. Every date and timestamp column moves back sc_targets.shift_days,
-- so a copy keeps the template's history in step but lives at its own point in time,
-- and sc_targets.patches (table name -> fields) is laid over last. Triggers are off
-- for the copy (session_replication_role = replica, so the caller is the stack's
-- superuser): a copy repeats rows the services already validated, and the guards
-- would refuse the second home on a template lot.

create temp table if not exists sc_g (gid bigserial primary key, tbl regclass not null, id text, row jsonb not null, round int not null default 0);
create index if not exists sc_g_tbl on sc_g (tbl, id);
create temp table if not exists sc_targets (k int primary key, suffix text not null, overrides jsonb not null default '{}', patches jsonb not null default '{}', shift_days int not null default 0);
create temp table if not exists sc_map (k int not null, old text not null, new text not null, primary key (k, old));

create or replace function pg_temp.sc_fk() returns table (child regclass, col text, parent regclass, coltype text) language sql stable as $$
  select c.conrelid::regclass, a.attname::text, c.confrelid::regclass, format_type(a.atttypid, a.atttypmod)
  from pg_constraint c
  join pg_class pc on pc.oid = c.confrelid and pc.relnamespace = 'public'::regnamespace
  join pg_class cc on cc.oid = c.conrelid and cc.relnamespace = 'public'::regnamespace and not cc.relispartition
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
  join pg_attribute pa on pa.attrelid = c.confrelid and pa.attnum = c.confkey[1] and pa.attname = 'id'
  where c.contype = 'f' and cardinality(c.conkey) = 1
$$;

create or replace function pg_temp.sc_add(p_tbl regclass, p_where text, p_org uuid, p_round int) returns int language plpgsql as $$
declare n int;
begin
  execute format(
    'insert into sc_g (tbl, id, row, round) select %L::regclass, j->>''id'', j, %s from (select to_jsonb(x) j from %s x where %s) s
     where coalesce(j->>''org_id'', %L) = %L
       and not exists (select 1 from sc_g g where g.tbl = %L::regclass and (g.id = j->>''id'' or (j->>''id'' is null and g.row = j)))',
    p_tbl, p_round, p_tbl, p_where, p_org, p_org, p_tbl);
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function pg_temp.sc_collect(p_org uuid, p_roots jsonb, p_projects uuid[], p_exclude regclass[], p_parents regclass[], p_max_rounds int default 8) returns int language plpgsql as $$
declare r record; added int; total int := 0; i int;
begin
  truncate sc_g;
  for r in select (x->>'tbl')::regclass tbl, x->>'id' id from jsonb_array_elements(p_roots) x loop
    total := total + pg_temp.sc_add(r.tbl, format('x.id = %L', r.id), p_org, 0);
  end loop;
  if cardinality(p_projects) > 0 then
    for r in select c.oid::regclass tbl from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'project_id' and not a.attisdropped
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relispartition and not (c.oid::regclass = any (p_exclude)) loop
      total := total + pg_temp.sc_add(r.tbl, format('x.project_id = any (%L::uuid[])', p_projects), p_org, 0);
    end loop;
  end if;
  for i in 1..p_max_rounds loop
    added := 0;
    -- The buyer and other named parents of what was just gathered.
    for r in select distinct f.child, f.col, f.parent, f.coltype from pg_temp.sc_fk() f
      where f.parent = any (p_parents) and f.child in (select distinct tbl from sc_g where round = i - 1) loop
      added := added + pg_temp.sc_add(r.parent, format('x.id in (select (g.row->>%L)::%s from sc_g g where g.tbl = %L::regclass and g.round = %s)', r.col, r.coltype, r.child, i - 1), p_org, i);
    end loop;
    -- Everything that references what was just gathered.
    for r in select distinct f.child, f.col, f.parent, f.coltype from pg_temp.sc_fk() f
      where not (f.child = any (p_exclude)) and f.parent in (select distinct tbl from sc_g where round = i - 1) loop
      added := added + pg_temp.sc_add(r.child, format('x.%I in (select g.id::%s from sc_g g where g.tbl = %L::regclass and g.round = %s)', r.col, r.coltype, r.parent, i - 1), p_org, i);
    end loop;
    total := total + added;
    exit when added = 0;
  end loop;
  return total;
end $$;

-- A JSON value with every id it names (at any depth) pointed at its copy for target p_k.
create or replace function pg_temp.sc_deep(p jsonb, p_k int) returns jsonb language plpgsql stable as $$
declare kind text := jsonb_typeof(p); v text;
begin
  if kind = 'object' then return coalesce((select jsonb_object_agg(key, pg_temp.sc_deep(value, p_k)) from jsonb_each(p)), '{}'::jsonb);
  elsif kind = 'array' then return coalesce((select jsonb_agg(pg_temp.sc_deep(value, p_k) order by o) from jsonb_array_elements(p) with ordinality a(value, o)), '[]'::jsonb);
  elsif kind = 'string' and length(p #>> '{}') = 36 then
    select new into v from sc_map where k = p_k and old = p #>> '{}';
    return coalesce(to_jsonb(v), p);
  end if;
  return p;
end $$;

-- Text columns of a unique key whose only uuid column is org_id: they would repeat in a copy.
create or replace function pg_temp.sc_suffix_columns(p_tbl regclass) returns text[] language sql stable as $$
  select coalesce(array_agg(distinct a.attname::text), '{}') from pg_index i
  join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
  where i.indrelid = p_tbl and i.indisunique and not i.indisprimary
    and a.atttypid in ('text'::regtype, 'varchar'::regtype, 'citext'::regtype)
    and not exists (select 1 from pg_attribute u where u.attrelid = i.indrelid and u.attnum = any (i.indkey) and u.atttypid = 'uuid'::regtype and u.attname <> 'org_id')
$$;

create or replace function pg_temp.sc_clone(p_null_parents regclass[]) returns jsonb language plpgsql as $$
declare r record; cols text; nulls text[]; suffixes text[]; dates text[]; stamps text[]; n int; written jsonb := '{}';
begin
  truncate sc_map;
  insert into sc_map select t.k, g.id, gen_random_uuid()::text from sc_g g cross join sc_targets t
    where g.id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  insert into sc_map select t.k, o.key, o.value #>> '{}' from sc_targets t cross join jsonb_each(t.overrides) o
    on conflict (k, old) do update set new = excluded.new;
  for r in select distinct tbl from sc_g loop
    select string_agg(quote_ident(attname), ',' order by attnum) into cols from pg_attribute
      where attrelid = r.tbl and attnum > 0 and not attisdropped and attgenerated = '' and attidentity <> 'a'
        -- A non-uuid key (a serial) is left to its default.
        and not (attname = 'id' and atttypid <> 'uuid'::regtype);
    select coalesce(array_agg(f.col), '{}') into nulls from pg_temp.sc_fk() f join pg_attribute a on a.attrelid = f.child and a.attname = f.col
      where f.child = r.tbl and f.parent = any (p_null_parents) and not a.attnotnull;
    suffixes := pg_temp.sc_suffix_columns(r.tbl);
    select coalesce(array_agg(attname::text) filter (where atttypid = 'date'::regtype), '{}'), coalesce(array_agg(attname::text) filter (where atttypid in ('timestamptz'::regtype, 'timestamp'::regtype)), '{}')
      into dates, stamps from pg_attribute where attrelid = r.tbl and attnum > 0 and not attisdropped;
    execute format(
      'insert into %s (%s) select %s from (select (jsonb_populate_record(null::%s, s.j || coalesce((select tt.patches -> %L from sc_targets tt where tt.k = s.k), ''{}''))).* from (
         select t.k, jsonb_object_agg(e.key, case
             when e.key = any (%L::text[]) then ''null''::jsonb
             when m.new is not null then to_jsonb(m.new)
             when jsonb_typeof(e.value) in (''object'', ''array'') then pg_temp.sc_deep(e.value, t.k)
             when t.shift_days <> 0 and e.key = any (%L::text[]) and jsonb_typeof(e.value) = ''string'' then to_jsonb(((e.value #>> ''{}'')::date - t.shift_days)::text)
             when t.shift_days <> 0 and e.key = any (%L::text[]) and jsonb_typeof(e.value) = ''string'' then to_jsonb((e.value #>> ''{}'')::timestamptz - make_interval(days => t.shift_days))
             when e.key = any (%L::text[]) and jsonb_typeof(e.value) = ''string'' then to_jsonb((e.value #>> ''{}'') || t.suffix)
             else e.value end) j
         from sc_g g cross join sc_targets t cross join lateral jsonb_each(g.row) e
         left join sc_map m on m.k = t.k and m.old = case when jsonb_typeof(e.value) = ''string'' and length(e.value #>> ''{}'') = 36 then e.value #>> ''{}'' end
         where g.tbl = %L::regclass group by g.gid, t.k) s) c',
      r.tbl, cols, cols, r.tbl, r.tbl::text, nulls, dates, stamps, suffixes, r.tbl);
    get diagnostics n = row_count;
    written := written || jsonb_build_object(r.tbl::text, n);
  end loop;
  return written;
end $$;

-- The copy of a template id for target k.
create or replace function pg_temp.sc_new(p_k int, p_old uuid) returns uuid language sql stable as $$
  select new::uuid from sc_map where k = p_k and old = p_old::text
$$;
