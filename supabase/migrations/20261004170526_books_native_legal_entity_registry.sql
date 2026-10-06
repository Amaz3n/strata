-- Native entity setup only. No legacy ledger is assigned or activated here.
create table public.books_legal_entities (
 id uuid primary key, org_id uuid not null references public.orgs(id),
 code text not null check(code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
 ledger_state text not null default 'setup' check(ledger_state='setup'),
 created_by uuid not null references public.app_users(id), created_at timestamptz not null default now(),
 creation_notes text not null check(length(trim(creation_notes)) between 10 and 2000),
 unique(org_id,id),unique(org_id,code)
);
create table public.books_legal_entity_members (
 org_id uuid not null,legal_entity_id uuid not null,user_id uuid not null references public.app_users(id),
 access_level text not null check(access_level in('read','prepare','review','manage','revoked')),
 changed_by uuid not null references public.app_users(id),changed_at timestamptz not null default now(),
 change_notes text not null check(length(trim(change_notes)) between 10 and 2000),
 primary key(org_id,legal_entity_id,user_id),
 foreign key(org_id,legal_entity_id) references public.books_legal_entities(org_id,id)
);
create table public.books_legal_entity_access_history (
 id bigint generated always as identity primary key,
 org_id uuid not null,legal_entity_id uuid not null,user_id uuid not null references public.app_users(id),
 prior_level text,access_level text not null,changed_by uuid not null references public.app_users(id),
 changed_at timestamptz not null,change_notes text not null,
 foreign key(org_id,legal_entity_id) references public.books_legal_entities(org_id,id)
);
create table public.books_legal_entity_profiles (
 id uuid primary key,org_id uuid not null,legal_entity_id uuid not null,
 revision integer not null check(revision>0),previous_profile_id uuid,
 legal_name text not null check(length(trim(legal_name)) between 1 and 200),
 legal_form text not null check(legal_form in('sole_proprietorship','partnership','corporation','llc','other')),
 functional_currency text not null check(functional_currency='USD'),
 fiscal_start_month integer not null,fiscal_start_day integer not null,
 effective_on date not null,identity_evidence jsonb not null check(jsonb_typeof(identity_evidence)='object' and identity_evidence<>'{}' and octet_length(identity_evidence::text)<=65536),
 prepared_by uuid not null references public.app_users(id),prepared_at timestamptz not null default now(),
 preparation_notes text not null check(length(trim(preparation_notes)) between 10 and 2000),
 unique(org_id,legal_entity_id,id),unique(org_id,legal_entity_id,revision),
 foreign key(org_id,legal_entity_id) references public.books_legal_entities(org_id,id),
 foreign key(org_id,legal_entity_id,previous_profile_id) references public.books_legal_entity_profiles(org_id,legal_entity_id,id),
 check(previous_profile_id is distinct from id),
 check(fiscal_start_month between 1 and 12 and fiscal_start_day between 1 and 31)
);
create table public.books_legal_entity_profile_reviews (
 org_id uuid not null,legal_entity_id uuid not null,profile_id uuid primary key,
 reviewed_by uuid not null references public.app_users(id),reviewed_at timestamptz not null default now(),
 review_notes text not null check(length(trim(review_notes)) between 10 and 2000),
 foreign key(org_id,legal_entity_id,profile_id) references public.books_legal_entity_profiles(org_id,legal_entity_id,id)
);
create index books_entity_member_actor_idx on public.books_legal_entity_members(org_id,user_id,legal_entity_id) where access_level<>'revoked';
create index books_entity_access_history_idx on public.books_legal_entity_access_history(org_id,legal_entity_id,id desc);
create index books_entity_profile_page_idx on public.books_legal_entity_profiles(org_id,legal_entity_id,revision desc);

create function public.books_entity_has_access(p_org uuid,p_entity uuid,p_actor uuid,p_operation text)
returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
 select exists(select 1 from public.books_legal_entity_members e join public.memberships m on m.org_id=e.org_id and m.user_id=e.user_id and m.status='active'
 where e.org_id=p_org and e.legal_entity_id=p_entity and e.user_id=p_actor and
 case p_operation when 'read' then e.access_level<>'revoked' when 'prepare' then e.access_level in('prepare','manage') when 'review' then e.access_level in('review','manage') when 'manage' then e.access_level='manage' else false end);
$$;
create function public.books_entity_immutable() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin raise exception 'Native entity identity and reviewed evidence are immutable';end $$;
create function public.books_entity_member_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare e public.books_legal_entities;v_bootstrap boolean;
begin
 if tg_op='DELETE' then raise exception 'Revoke entity membership explicitly; history cannot be deleted';end if;
 select * into e from public.books_legal_entities where org_id=new.org_id and id=new.legal_entity_id for update;
 if not found then raise exception 'Entity is unavailable in organization';end if;
 if tg_op='UPDATE' and (old.org_id,old.legal_entity_id,old.user_id) is distinct from (new.org_id,new.legal_entity_id,new.user_id) then raise exception 'Entity membership identity is immutable';end if;
 if not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.changed_by and status='active') then raise exception 'Entity access actor must be an active organization member';end if;
 if new.access_level<>'revoked' and not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.user_id and status='active') then raise exception 'Entity member must be active in organization';end if;
 v_bootstrap:=tg_op='INSERT' and new.user_id=e.created_by and new.changed_by=e.created_by and new.access_level='manage' and not exists(select 1 from public.books_legal_entity_members where org_id=e.org_id and legal_entity_id=e.id);
 if not v_bootstrap and not public.books_entity_has_access(new.org_id,new.legal_entity_id,new.changed_by,'manage') then raise exception 'Entity manager access is required';end if;
 if tg_op='UPDATE' and old.access_level='manage' and new.access_level<>'manage' and not exists(select 1 from public.books_legal_entity_members where org_id=e.org_id and legal_entity_id=e.id and user_id<>old.user_id and access_level='manage' and public.books_entity_has_access(e.org_id,e.id,user_id,'manage')) then raise exception 'Cannot remove the last active entity manager';end if;
 new.changed_at:=clock_timestamp();return new;
end $$;
create function public.books_entity_member_audit() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 insert into public.books_legal_entity_access_history(org_id,legal_entity_id,user_id,prior_level,access_level,changed_by,changed_at,change_notes)
 values(new.org_id,new.legal_entity_id,new.user_id,case when tg_op='UPDATE' then old.access_level else null end,new.access_level,new.changed_by,new.changed_at,new.change_notes);return new;
end $$;
create function public.books_entity_profile_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_previous uuid;v_revision integer;
begin
 perform 1 from public.books_legal_entities where org_id=new.org_id and id=new.legal_entity_id for update;
 if not found or not public.books_entity_has_access(new.org_id,new.legal_entity_id,new.prepared_by,'prepare') then raise exception 'Entity preparation access is required';end if;
 perform make_date(2001,new.fiscal_start_month,new.fiscal_start_day);
 select p.id into v_previous from public.books_legal_entity_profiles p join public.books_legal_entity_profile_reviews r on r.profile_id=p.id where p.org_id=new.org_id and p.legal_entity_id=new.legal_entity_id order by p.revision desc limit 1;
 if new.previous_profile_id is distinct from v_previous then raise exception 'Entity profile predecessor changed; prepare against the current reviewed identity';end if;
 select coalesce(max(revision),0)+1 into v_revision from public.books_legal_entity_profiles where org_id=new.org_id and legal_entity_id=new.legal_entity_id;
 if new.revision<>v_revision then raise exception 'Entity profile revision must follow retained history';end if;
 return new;
end $$;
create function public.books_entity_profile_review_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare p public.books_legal_entity_profiles;v_previous uuid;
begin
 perform 1 from public.books_legal_entities where org_id=new.org_id and id=new.legal_entity_id for update;
 select * into p from public.books_legal_entity_profiles where org_id=new.org_id and legal_entity_id=new.legal_entity_id and id=new.profile_id;
 if not found or not public.books_entity_has_access(new.org_id,new.legal_entity_id,new.reviewed_by,'review') or new.reviewed_by=p.prepared_by then raise exception 'Entity identity requires a separate active entity reviewer';end if;
 select x.id into v_previous from public.books_legal_entity_profiles x join public.books_legal_entity_profile_reviews r on r.profile_id=x.id where x.org_id=new.org_id and x.legal_entity_id=new.legal_entity_id order by x.revision desc limit 1;
 if p.previous_profile_id is distinct from v_previous then raise exception 'Entity review predecessor changed; prepare a current revision';end if;
 return new;
end $$;
create trigger books_entity_identity_immutable before update or delete on public.books_legal_entities for each row execute function public.books_entity_immutable();
create trigger books_entity_members_guard before insert or update or delete on public.books_legal_entity_members for each row execute function public.books_entity_member_guard();
create trigger books_entity_members_audit after insert or update on public.books_legal_entity_members for each row execute function public.books_entity_member_audit();
create trigger books_entity_access_history_immutable before update or delete on public.books_legal_entity_access_history for each row execute function public.books_entity_immutable();
create trigger books_entity_profiles_guard before insert on public.books_legal_entity_profiles for each row execute function public.books_entity_profile_guard();
create trigger books_entity_profiles_immutable before update or delete on public.books_legal_entity_profiles for each row execute function public.books_entity_immutable();
create trigger books_entity_reviews_guard before insert on public.books_legal_entity_profile_reviews for each row execute function public.books_entity_profile_review_guard();
create trigger books_entity_reviews_immutable before update or delete on public.books_legal_entity_profile_reviews for each row execute function public.books_entity_immutable();

create function public.create_books_legal_entity(p_org uuid,p_id uuid,p_code text,p_actor uuid,p_notes text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare e public.books_legal_entities;
begin
 if not exists(select 1 from public.memberships where org_id=p_org and user_id=p_actor and status='active') then raise exception 'Active organization membership is required';end if;
 -- Tenant fence also serializes creation retries and conflicting codes.
 perform 1 from public.orgs where id=p_org for update;
 select * into e from public.books_legal_entities where id=p_id;
 if found then
  if (e.org_id,e.code,e.created_by,e.creation_notes) is distinct from (p_org,p_code,p_actor,p_notes) then raise exception 'Entity creation retry differs from committed identity';end if;
  return to_jsonb(e);
 end if;
 insert into public.books_legal_entities(id,org_id,code,created_by,creation_notes) values(p_id,p_org,p_code,p_actor,p_notes) returning * into e;
 insert into public.books_legal_entity_members(org_id,legal_entity_id,user_id,access_level,changed_by,change_notes) values(p_org,p_id,p_actor,'manage',p_actor,p_notes);
 return to_jsonb(e);
end $$;
create function public.set_books_legal_entity_member(p_org uuid,p_entity uuid,p_actor uuid,p_user uuid,p_level text,p_notes text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_result jsonb;
begin
 perform 1 from public.books_legal_entities where org_id=p_org and id=p_entity for update;
 if not found or not public.books_entity_has_access(p_org,p_entity,p_actor,'manage') then raise exception 'Entity manager access is required';end if;
 if exists(select 1 from public.books_legal_entity_members where org_id=p_org and legal_entity_id=p_entity and user_id=p_user and access_level=p_level and changed_by=p_actor and change_notes=p_notes) then
  select to_jsonb(m) into v_result from public.books_legal_entity_members m where org_id=p_org and legal_entity_id=p_entity and user_id=p_user;return v_result;
 end if;
 insert into public.books_legal_entity_members(org_id,legal_entity_id,user_id,access_level,changed_by,change_notes) values(p_org,p_entity,p_user,p_level,p_actor,p_notes)
 on conflict(org_id,legal_entity_id,user_id) do update set access_level=excluded.access_level,changed_by=excluded.changed_by,change_notes=excluded.change_notes;
 select to_jsonb(m) into v_result from public.books_legal_entity_members m where org_id=p_org and legal_entity_id=p_entity and user_id=p_user;return v_result;
end $$;
create function public.prepare_books_legal_entity_profile(p_org uuid,p_entity uuid,p_id uuid,p_actor uuid,p_previous uuid,p_profile jsonb,p_notes text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare p public.books_legal_entity_profiles;v_revision integer;
begin
 perform 1 from public.books_legal_entities where org_id=p_org and id=p_entity for update;
 if not found or not public.books_entity_has_access(p_org,p_entity,p_actor,'prepare') then raise exception 'Entity preparation access is required';end if;
 select * into p from public.books_legal_entity_profiles where id=p_id;
 if found then
  if (p.org_id,p.legal_entity_id,p.prepared_by,p.previous_profile_id,p.preparation_notes) is distinct from (p_org,p_entity,p_actor,p_previous,p_notes) or
  jsonb_build_object('legal_name',p.legal_name,'legal_form',p.legal_form,'functional_currency',p.functional_currency,'fiscal_start_month',p.fiscal_start_month,'fiscal_start_day',p.fiscal_start_day,'effective_on',p.effective_on,'identity_evidence',p.identity_evidence) is distinct from p_profile then raise exception 'Entity profile retry differs from frozen preparation';end if;
  return to_jsonb(p);
 end if;
 if jsonb_typeof(p_profile)<>'object' or p_profile-array['legal_name','legal_form','functional_currency','fiscal_start_month','fiscal_start_day','effective_on','identity_evidence']<>'{}' then raise exception 'Invalid entity profile fields';end if;
 select coalesce(max(revision),0)+1 into v_revision from public.books_legal_entity_profiles where org_id=p_org and legal_entity_id=p_entity;
 insert into public.books_legal_entity_profiles(id,org_id,legal_entity_id,revision,previous_profile_id,legal_name,legal_form,functional_currency,fiscal_start_month,fiscal_start_day,effective_on,identity_evidence,prepared_by,preparation_notes)
 values(p_id,p_org,p_entity,v_revision,p_previous,p_profile->>'legal_name',p_profile->>'legal_form',p_profile->>'functional_currency',(p_profile->>'fiscal_start_month')::integer,(p_profile->>'fiscal_start_day')::integer,(p_profile->>'effective_on')::date,p_profile->'identity_evidence',p_actor,p_notes) returning * into p;
 return to_jsonb(p);
end $$;
create function public.review_books_legal_entity_profile(p_org uuid,p_entity uuid,p_profile uuid,p_actor uuid,p_notes text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r public.books_legal_entity_profile_reviews;
begin
 perform 1 from public.books_legal_entities where org_id=p_org and id=p_entity for update;
 if not found or not public.books_entity_has_access(p_org,p_entity,p_actor,'review') then raise exception 'Entity review access is required';end if;
 select * into r from public.books_legal_entity_profile_reviews where profile_id=p_profile;
 if found then
  if (r.org_id,r.legal_entity_id,r.reviewed_by,r.review_notes) is distinct from (p_org,p_entity,p_actor,p_notes) then raise exception 'Entity review retry differs from retained approval';end if;return to_jsonb(r);
 end if;
 insert into public.books_legal_entity_profile_reviews(org_id,legal_entity_id,profile_id,reviewed_by,review_notes) values(p_org,p_entity,p_profile,p_actor,p_notes) returning * into r;
 return to_jsonb(r);
end $$;
-- Private server RPCs. Organization Books permission is checked by the service;
-- SQL additionally checks active entity membership and composite tenant identity.
do $$ declare name text;begin
 foreach name in array array['books_legal_entities','books_legal_entity_members','books_legal_entity_access_history','books_legal_entity_profiles','books_legal_entity_profile_reviews'] loop
  execute format('alter table public.%I enable row level security',name);
  execute format('revoke all on public.%I from public,anon,authenticated',name);
  execute format('grant select,insert,update,delete on public.%I to service_role',name);
 end loop;
end $$;
grant usage,select on sequence public.books_legal_entity_access_history_id_seq to service_role;
do $$ declare r record;begin
 for r in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in('books_entity_has_access','books_entity_immutable','books_entity_member_guard','books_entity_member_audit','books_entity_profile_guard','books_entity_profile_review_guard','create_books_legal_entity','set_books_legal_entity_member','prepare_books_legal_entity_profile','review_books_legal_entity_profile') loop
  execute format('revoke all on function %s from public,anon,authenticated',r.signature);
  execute format('grant execute on function %s to service_role',r.signature);
 end loop;
end $$;
create function public.read_books_legal_entity_setup(p_org uuid,p_actor uuid,p_entity uuid default null,p_before uuid default null,p_limit integer default 50)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_rows jsonb;v_next uuid;v_profiles jsonb;v_members jsonb;v_history jsonb;
begin
 if p_limit is null or p_limit not between 1 and 50 or (p_entity is not null and p_before is not null) then raise exception 'Invalid entity setup pagination';end if;
 if not exists(select 1 from public.memberships where org_id=p_org and user_id=p_actor and status='active') then raise exception 'Active organization membership is required';end if;
 if p_entity is not null and not public.books_entity_has_access(p_org,p_entity,p_actor,'read') then raise exception 'Entity read access is required';end if;
 with page as (
 select e.id,e.org_id,e.code,e.ledger_state,e.created_at,
 (select jsonb_build_object('id',p.id,'revision',p.revision,'legal_name',p.legal_name,'legal_form',p.legal_form,'functional_currency',p.functional_currency,'fiscal_start_month',p.fiscal_start_month,'fiscal_start_day',p.fiscal_start_day,'effective_on',p.effective_on) from public.books_legal_entity_profiles p join public.books_legal_entity_profile_reviews r on r.profile_id=p.id where p.org_id=e.org_id and p.legal_entity_id=e.id order by p.revision desc limit 1) reviewed_profile
 from public.books_legal_entities e where e.org_id=p_org and public.books_entity_has_access(p_org,e.id,p_actor,'read') and (p_entity is null or e.id=p_entity) and (p_before is null or e.id>p_before) order by e.id limit p_limit+1
 ) select coalesce(jsonb_agg(to_jsonb(page) order by id),'[]') into v_rows from page;
 if jsonb_array_length(v_rows)>p_limit then v_rows:=v_rows-p_limit;v_next:=(v_rows->(p_limit-1)->>'id')::uuid;end if;
 if p_entity is not null then
  select coalesce(jsonb_agg(to_jsonb(x) order by revision desc),'[]') into v_profiles from
  (select p.*, (select to_jsonb(r) from public.books_legal_entity_profile_reviews r where r.profile_id=p.id) approval from public.books_legal_entity_profiles p where p.org_id=p_org and p.legal_entity_id=p_entity order by revision desc limit 51) x;
  if public.books_entity_has_access(p_org,p_entity,p_actor,'manage') then
   select coalesce(jsonb_agg(to_jsonb(x) order by user_id),'[]') into v_members from (select * from public.books_legal_entity_members where org_id=p_org and legal_entity_id=p_entity order by user_id limit 51) x;
   select coalesce(jsonb_agg(to_jsonb(x) order by id desc),'[]') into v_history from (select * from public.books_legal_entity_access_history where org_id=p_org and legal_entity_id=p_entity order by id desc limit 51) x;
  end if;
 end if;
 return jsonb_build_object('orgId',p_org,'entityId',p_entity,'entities',v_rows,'nextCursor',v_next,
 'profiles',coalesce(v_profiles,'[]')-50,'moreProfiles',coalesce(jsonb_array_length(v_profiles)>50,false),
 'members',coalesce(v_members,'[]')-50,'moreMembers',coalesce(jsonb_array_length(v_members)>50,false),
 'accessHistory',coalesce(v_history,'[]')-50,'moreAccessHistory',coalesce(jsonb_array_length(v_history)>50,false));
end $$;
revoke all on function public.read_books_legal_entity_setup(uuid,uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.read_books_legal_entity_setup(uuid,uuid,uuid,uuid,integer) to service_role;
