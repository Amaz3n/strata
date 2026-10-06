-- Immutable entity calendar years derived from independently reviewed identity.
-- Preparation/review does not activate an entity ledger or close legacy periods.
begin;
create function public.books_entity_month_boundary(p_year integer,p_month integer,p_day integer,p_offset integer)
returns date language sql immutable security invoker set search_path=pg_catalog,public as $$
 select make_date(p_year+(p_month-1+p_offset)/12,(p_month-1+p_offset)%12+1,least(p_day,extract(day from (make_date(p_year+(p_month-1+p_offset)/12,(p_month-1+p_offset)%12+1,1)+interval '1 month - 1 day'))::integer));
$$;
create table public.books_entity_calendar_years(
 id uuid primary key,org_id uuid not null,legal_entity_id uuid not null,profile_id uuid not null,
 starts_in_year integer not null check(starts_in_year between 1900 and 9997),starts_on date not null,ends_on date not null,
 prepared_by uuid not null references public.app_users(id),prepared_at timestamptz not null,prepared_access_event_id uuid not null,
 preparation_notes text not null check(length(btrim(preparation_notes)) between 10 and 2000),
 unique(org_id,legal_entity_id,id),unique(org_id,legal_entity_id,id,starts_in_year),
 foreign key(org_id,legal_entity_id,profile_id) references public.books_legal_entity_profiles(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,prepared_access_event_id) references public.books_legal_entity_access_history(org_id,legal_entity_id,id),check(ends_on>=starts_on)
);
create table public.books_entity_fiscal_periods(
 id uuid primary key default gen_random_uuid(),org_id uuid not null,legal_entity_id uuid not null,calendar_year_id uuid not null,
 period_number integer not null check(period_number between 1 and 12),starts_on date not null,ends_on date not null,
 unique(calendar_year_id,period_number),
 foreign key(org_id,legal_entity_id,calendar_year_id) references public.books_entity_calendar_years(org_id,legal_entity_id,id),check(ends_on>=starts_on)
);
create table public.books_entity_calendar_reviews(
 id uuid primary key,org_id uuid not null,legal_entity_id uuid not null,calendar_year_id uuid not null unique,starts_in_year integer not null,
 reviewed_by uuid not null references public.app_users(id),reviewed_at timestamptz not null,reviewed_access_event_id uuid not null,
 review_notes text not null check(length(btrim(review_notes)) between 10 and 2000),unique(org_id,legal_entity_id,starts_in_year),
 foreign key(org_id,legal_entity_id,calendar_year_id,starts_in_year) references public.books_entity_calendar_years(org_id,legal_entity_id,id,starts_in_year),
 foreign key(org_id,legal_entity_id,reviewed_access_event_id) references public.books_legal_entity_access_history(org_id,legal_entity_id,id)
);
create function public.books_entity_calendar_year_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare p public.books_legal_entity_profiles;latest uuid;
begin
 perform 1 from public.books_legal_entities where org_id=new.org_id and id=new.legal_entity_id for update;
 if not found or not public.books_entity_has_access(new.org_id,new.legal_entity_id,new.prepared_by,'prepare') then raise exception 'Entity calendar preparation access is required';end if;
 perform 1 from public.memberships where org_id=new.org_id and user_id=new.prepared_by and status='active' for share;
 if not found then raise exception 'Active calendar maker organization membership is required';end if;
 select * into p from public.books_legal_entity_profiles where org_id=new.org_id and legal_entity_id=new.legal_entity_id and id=new.profile_id;
 if p.id is null or not exists(select 1 from public.books_legal_entity_profile_reviews where profile_id=p.id) then raise exception 'Calendar requires an independently reviewed entity profile';end if;
 new.starts_on:=public.books_entity_month_boundary(new.starts_in_year,p.fiscal_start_month,p.fiscal_start_day,0);
 new.ends_on:=public.books_entity_month_boundary(new.starts_in_year,p.fiscal_start_month,p.fiscal_start_day,12)-1;
 select x.id into latest from public.books_legal_entity_profiles x join public.books_legal_entity_profile_reviews r on r.profile_id=x.id where x.org_id=new.org_id and x.legal_entity_id=new.legal_entity_id and x.effective_on<=new.starts_on order by x.revision desc limit 1;
 if latest is distinct from p.id then raise exception 'Calendar profile is not the applicable reviewed identity';end if;
 new.prepared_at:=clock_timestamp();new.preparation_notes:=btrim(new.preparation_notes);
 select h.id into new.prepared_access_event_id from public.books_legal_entity_access_history h where h.org_id=new.org_id and h.legal_entity_id=new.legal_entity_id and h.user_id=new.prepared_by order by h.sequence_no desc limit 1;
 return new;
end $$;
create function public.books_entity_fiscal_period_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare y public.books_entity_calendar_years;p public.books_legal_entity_profiles;
begin
 select * into y from public.books_entity_calendar_years where org_id=new.org_id and legal_entity_id=new.legal_entity_id and id=new.calendar_year_id;
 select * into p from public.books_legal_entity_profiles where id=y.profile_id;
 if y.id is null or new.starts_on is distinct from public.books_entity_month_boundary(y.starts_in_year,p.fiscal_start_month,p.fiscal_start_day,new.period_number-1) or new.ends_on is distinct from public.books_entity_month_boundary(y.starts_in_year,p.fiscal_start_month,p.fiscal_start_day,new.period_number)-1 then raise exception 'Fiscal period differs from retained reviewed profile';end if;
 return new;
end $$;
create function public.books_entity_calendar_complete() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if (select count(*) from public.books_entity_fiscal_periods where calendar_year_id=new.id)<>12 then raise exception 'Entity calendar requires exactly twelve fiscal periods';end if;return null;
end $$;
create function public.books_entity_calendar_review_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare y public.books_entity_calendar_years;latest uuid;
begin
 perform 1 from public.books_legal_entities where org_id=new.org_id and id=new.legal_entity_id for update;
 select * into y from public.books_entity_calendar_years where org_id=new.org_id and legal_entity_id=new.legal_entity_id and id=new.calendar_year_id;
 if y.id is null or not public.books_entity_has_access(new.org_id,new.legal_entity_id,new.reviewed_by,'review') or new.reviewed_by=y.prepared_by then raise exception 'Calendar requires an independent active entity reviewer';end if;
 perform 1 from public.memberships where org_id=new.org_id and user_id in(new.reviewed_by,y.prepared_by) and status='active' order by user_id for share;
 if (select count(*) from public.memberships where org_id=new.org_id and user_id in(new.reviewed_by,y.prepared_by) and status='active')<>2 then raise exception 'Active calendar maker and reviewer organization memberships are required';end if;
 select p.id into latest from public.books_legal_entity_profiles p join public.books_legal_entity_profile_reviews r on r.profile_id=p.id where p.org_id=new.org_id and p.legal_entity_id=new.legal_entity_id and p.effective_on<=y.starts_on order by p.revision desc limit 1;
 if not public.books_entity_has_access(new.org_id,new.legal_entity_id,y.prepared_by,'prepare') then raise exception 'Calendar maker must retain active preparation access';end if;
 if latest is distinct from y.profile_id then raise exception 'Calendar reviewed identity changed; prepare a new calendar';end if;
 if (select count(*) from public.books_entity_fiscal_periods where calendar_year_id=y.id)<>12 then raise exception 'Calendar is incomplete';end if;
 if exists(select 1 from public.books_entity_calendar_reviews r join public.books_entity_calendar_years x on x.id=r.calendar_year_id where r.org_id=new.org_id and r.legal_entity_id=new.legal_entity_id and x.starts_on<=y.ends_on and x.ends_on>=y.starts_on) then raise exception 'Reviewed entity calendars cannot overlap';end if;
 if exists(select 1 from public.books_entity_calendar_reviews r join public.books_entity_calendar_years x on x.id=r.calendar_year_id where r.org_id=new.org_id and r.legal_entity_id=new.legal_entity_id and x.ends_on<y.starts_on having max(x.ends_on)+1<>y.starts_on) or exists(select 1 from public.books_entity_calendar_reviews r join public.books_entity_calendar_years x on x.id=r.calendar_year_id where r.org_id=new.org_id and r.legal_entity_id=new.legal_entity_id and x.starts_on>y.ends_on having min(x.starts_on)-1<>y.ends_on) then raise exception 'Reviewed calendars must remain contiguous; review intervening or fiscal transition periods first';end if;
 new.starts_in_year:=y.starts_in_year;new.reviewed_at:=clock_timestamp();new.review_notes:=btrim(new.review_notes);
 select h.id into new.reviewed_access_event_id from public.books_legal_entity_access_history h where h.org_id=new.org_id and h.legal_entity_id=new.legal_entity_id and h.user_id=new.reviewed_by order by h.sequence_no desc limit 1;
 return new;
end $$;
create trigger books_entity_calendar_year_guard before insert on public.books_entity_calendar_years for each row execute function public.books_entity_calendar_year_guard();
create constraint trigger books_entity_calendar_complete after insert on public.books_entity_calendar_years deferrable initially deferred for each row execute function public.books_entity_calendar_complete();
create trigger books_entity_fiscal_period_guard before insert on public.books_entity_fiscal_periods for each row execute function public.books_entity_fiscal_period_guard();
create trigger books_entity_calendar_review_guard before insert on public.books_entity_calendar_reviews for each row execute function public.books_entity_calendar_review_guard();
create trigger books_entity_calendar_year_immutable before update or delete on public.books_entity_calendar_years for each row execute function public.books_entity_immutable();
create trigger books_entity_fiscal_period_immutable before update or delete on public.books_entity_fiscal_periods for each row execute function public.books_entity_immutable();
create trigger books_entity_calendar_review_immutable before update or delete on public.books_entity_calendar_reviews for each row execute function public.books_entity_immutable();
create function public.prepare_books_entity_calendar(p_org uuid,p_entity uuid,p_id uuid,p_profile uuid,p_actor uuid,p_year integer,p_notes text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare y public.books_entity_calendar_years;p public.books_legal_entity_profiles;
begin
 perform 1 from public.books_legal_entities where org_id=p_org and id=p_entity for update;
 if not found or not public.books_entity_has_access(p_org,p_entity,p_actor,'prepare') then raise exception 'Entity calendar preparation access is required';end if;
 select * into y from public.books_entity_calendar_years where id=p_id;
 if found then
  if (y.org_id,y.legal_entity_id,y.profile_id,y.prepared_by,y.starts_in_year,y.preparation_notes) is distinct from (p_org,p_entity,p_profile,p_actor,p_year,btrim(p_notes)) then raise exception 'Calendar retry differs from retained preparation';end if;
 else
  insert into public.books_entity_calendar_years(id,org_id,legal_entity_id,profile_id,starts_in_year,starts_on,ends_on,prepared_by,prepared_at,prepared_access_event_id,preparation_notes) values(p_id,p_org,p_entity,p_profile,p_year,current_date,current_date,p_actor,clock_timestamp(),p_id,p_notes) returning * into y;
  select * into p from public.books_legal_entity_profiles where id=y.profile_id;
  insert into public.books_entity_fiscal_periods(org_id,legal_entity_id,calendar_year_id,period_number,starts_on,ends_on) select p_org,p_entity,y.id,n,public.books_entity_month_boundary(p_year,p.fiscal_start_month,p.fiscal_start_day,n-1),public.books_entity_month_boundary(p_year,p.fiscal_start_month,p.fiscal_start_day,n)-1 from generate_series(1,12)n;
 end if;
 return jsonb_build_object('year',to_jsonb(y),'periods',(select jsonb_agg(to_jsonb(x) order by period_number) from public.books_entity_fiscal_periods x where calendar_year_id=y.id),'ledgerActivated',false);
end $$;
create function public.review_books_entity_calendar(p_org uuid,p_entity uuid,p_calendar uuid,p_id uuid,p_actor uuid,p_notes text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r public.books_entity_calendar_reviews;
begin
 perform 1 from public.books_legal_entities where org_id=p_org and id=p_entity for update;
 if not found or not public.books_entity_has_access(p_org,p_entity,p_actor,'review') then raise exception 'Entity calendar review access is required';end if;
 select * into r from public.books_entity_calendar_reviews where calendar_year_id=p_calendar;
 if found then
  if (r.id,r.org_id,r.legal_entity_id,r.reviewed_by,r.review_notes) is distinct from (p_id,p_org,p_entity,p_actor,btrim(p_notes)) then raise exception 'Calendar retry differs from retained review';end if;
 else insert into public.books_entity_calendar_reviews(id,org_id,legal_entity_id,calendar_year_id,starts_in_year,reviewed_by,reviewed_at,reviewed_access_event_id,review_notes) values(p_id,p_org,p_entity,p_calendar,1900,p_actor,clock_timestamp(),p_id,p_notes) returning * into r;end if;
 return to_jsonb(r);
end $$;
do $$declare t text;r record;begin
 foreach t in array array['books_entity_calendar_years','books_entity_fiscal_periods','books_entity_calendar_reviews'] loop
 execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant all on public.%I to service_role',t);end loop;
 for r in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in('books_entity_month_boundary','books_entity_calendar_year_guard','books_entity_fiscal_period_guard','books_entity_calendar_complete','books_entity_calendar_review_guard','prepare_books_entity_calendar','review_books_entity_calendar') loop execute format('revoke all on function %s from public,anon,authenticated',r.signature);execute format('grant execute on function %s to service_role',r.signature);end loop;
end $$;

create function public.read_books_entity_calendars(p_org uuid,p_entity uuid,p_actor uuid,p_before uuid default null,p_limit integer default 50)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare years jsonb;ids uuid[];cursor uuid;
begin
 if p_limit is null or p_limit not between 1 and 50 or not public.books_entity_has_access(p_org,p_entity,p_actor,'read') then raise exception 'Entity calendar read access is required';end if;
 select array_agg(id order by id) into ids from(select id from public.books_entity_calendar_years where org_id=p_org and legal_entity_id=p_entity and (p_before is null or id>p_before) order by id limit p_limit+1)x;
 if cardinality(ids)>p_limit then cursor:=ids[p_limit];ids:=ids[1:p_limit];end if;
 select coalesce(jsonb_agg(to_jsonb(y) order by y.id),'[]') into years from public.books_entity_calendar_years y where id=any(ids);
 return jsonb_build_object('orgId',p_org,'entityId',p_entity,'years',years,'nextCursor',cursor,'periods',(select coalesce(jsonb_agg(to_jsonb(p) order by p.calendar_year_id,p.period_number),'[]') from public.books_entity_fiscal_periods p where calendar_year_id=any(ids)),'reviews',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]') from public.books_entity_calendar_reviews r where calendar_year_id=any(ids)),'ledgerActivated',false);
end $$;
revoke all on function public.read_books_entity_calendars(uuid,uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.read_books_entity_calendars(uuid,uuid,uuid,uuid,integer) to service_role;
alter function public.capture_books_export_snapshot(uuid) rename to capture_books_export_snapshot_before_entity_calendars;
create function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare snapshot jsonb;rows jsonb;t text;
begin
 snapshot:=public.capture_books_export_snapshot_before_entity_calendars(p_org_id);
 foreach t in array array['books_entity_calendar_years','books_entity_fiscal_periods','books_entity_calendar_reviews'] loop
 execute format('select coalesce(jsonb_agg(to_jsonb(r) order by r.id),''[]'') from public.%I r where org_id=$1',t) into rows using p_org_id;
 snapshot:=jsonb_set(snapshot,array['tables',t],rows);end loop;
 return snapshot;
end $$;
revoke all on function public.capture_books_export_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;
create or replace function public.capture_books_legacy_ownership_evidence(p_org uuid,p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_snapshot jsonb;v_tables jsonb;v_rows jsonb;
begin
 v_snapshot:=public.capture_books_entity_authorized_export(p_org,p_actor);
 v_tables:=(v_snapshot->'tables')-'books_legacy_entity_proposals'-'books_legacy_entity_reviews'-'books_journal_request_resolutions'-'books_entity_calendar_years'-'books_entity_fiscal_periods'-'books_entity_calendar_reviews';
 select coalesce(jsonb_agg(row-'tax_id'-'ein'-'ssn' order by row->>'id'),'[]'::jsonb) into v_rows from jsonb_array_elements(v_tables->'companies') row;
 v_tables:=jsonb_set(v_tables,'{companies}',v_rows);
 select coalesce(jsonb_agg((select jsonb_object_agg(key,value) from jsonb_each(row) where key=any(array['id','org_id','provider','bank_name','account_type','last4','status','books_gl_account_id','created_at','updated_at'])) order by row->>'id'),'[]'::jsonb) into v_rows from jsonb_array_elements(v_tables->'org_funding_sources') row;
 v_tables:=jsonb_set(v_tables,'{org_funding_sources}',v_rows);
 return jsonb_build_object('populationText',v_tables::text,'capturedAt',v_snapshot->'capturedAt','databaseSnapshot',v_snapshot->'databaseSnapshot');
end;
$$;
commit;
