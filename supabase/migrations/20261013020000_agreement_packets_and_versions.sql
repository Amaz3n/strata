-- Purchase agreement packets, versions and cancellation (EP05-03, EP05-07).
--
-- 1. Agreement templates. Arc supplies no legal text: an organization uploads
--    its counsel's agreement and addenda as PDFs. A template is a family; each
--    version is immutable once published and carries its own applicability
--    (states, communities). One published version per family at a time.
-- 2. The packet. `resolve_agreement_packet` is the ONLY resolver: for a home's
--    community and state it picks the most specific base agreement, every
--    required addendum and the optional addenda the seller picked, and hashes
--    the list. Agreement creation stores that packet in the contract snapshot,
--    so `purchase_agreement_signing_input` binds it with no further change.
--    Signing preparation refuses a packet that lost a document to withdrawal or
--    that is missing an addendum now required for the home.
-- 3. Versions. A signed purchase agreement is version 1; every buyer-signed
--    change order approved on the home becomes the next version, written by a
--    trigger in the same transaction as the approval, so every approval path
--    gets it. A bound change order needs buyer evidence to be approved and can
--    never be voided once approved. `purchase_agreement_authorized_terms` is the
--    current authorized price.
-- 4. Cancellation. `void_purchase_agreement_atomic` voids the agreement and
--    reconciles what the sale committed in one transaction, against a plan the
--    seller reviewed (`preview_purchase_agreement_cancellation`, hashed). The
--    receipt carries the money steps the service finishes afterwards.
--
-- Backfill side effect: an open closing whose settlement preview counted an
-- approved change order from before the signature, from a prior buyer, or one
-- that never needed the buyer's signature no longer counts it. The migration
-- raises a NOTICE naming each such closing.

-- ---------------------------------------------------------------------------
-- 1. Agreement templates.
-- ---------------------------------------------------------------------------

create or replace function public.agreement_jurisdiction(p_state text)
returns text
language sql
immutable
set search_path = ''
as $$
  select s.code
  from (values
    ('AL','alabama'),('AK','alaska'),('AZ','arizona'),('AR','arkansas'),('CA','california'),('CO','colorado'),
    ('CT','connecticut'),('DE','delaware'),('DC','district of columbia'),('FL','florida'),('GA','georgia'),
    ('HI','hawaii'),('ID','idaho'),('IL','illinois'),('IN','indiana'),('IA','iowa'),('KS','kansas'),
    ('KY','kentucky'),('LA','louisiana'),('ME','maine'),('MD','maryland'),('MA','massachusetts'),
    ('MI','michigan'),('MN','minnesota'),('MS','mississippi'),('MO','missouri'),('MT','montana'),
    ('NE','nebraska'),('NV','nevada'),('NH','new hampshire'),('NJ','new jersey'),('NM','new mexico'),
    ('NY','new york'),('NC','north carolina'),('ND','north dakota'),('OH','ohio'),('OK','oklahoma'),
    ('OR','oregon'),('PA','pennsylvania'),('RI','rhode island'),('SC','south carolina'),('SD','south dakota'),
    ('TN','tennessee'),('TX','texas'),('UT','utah'),('VT','vermont'),('VA','virginia'),('WA','washington'),
    ('WV','west virginia'),('WI','wisconsin'),('WY','wyoming')
  ) as s(code, name)
  where s.code = upper(btrim(coalesce(p_state, ''))) or s.name = lower(btrim(coalesce(p_state, '')))
  limit 1
$$;
revoke all on function public.agreement_jurisdiction(text) from public, anon, authenticated;

create table public.agreement_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  kind text not null check (kind in ('agreement', 'addendum')),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  sort_order integer not null default 0,
  status text not null default 'active' check (status in ('active', 'retired')),
  current_version_id uuid,
  created_by uuid references public.app_users(id),
  retired_at timestamptz,
  retired_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, kind, name),
  unique (org_id, id),
  check ((status = 'retired') = (retired_at is not null))
);

create table public.agreement_template_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  template_id uuid not null,
  version_number integer not null check (version_number >= 1),
  status text not null default 'draft' check (status in ('draft', 'published', 'superseded', 'withdrawn')),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  required boolean not null default false,
  applies_to_states text[] not null default '{}'
    check (array_to_string(applies_to_states, ',') ~ '^([A-Z]{2}(,[A-Z]{2})*)?$'),
  source_file_id uuid not null references public.files(id),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes > 0),
  page_count integer not null check (page_count between 1 and 200),
  storage_path text not null check (char_length(storage_path) > 0),
  change_note text check (change_note is null or char_length(change_note) <= 2000),
  published_at timestamptz,
  published_by uuid references public.app_users(id),
  withdrawn_at timestamptz,
  withdrawn_by uuid references public.app_users(id),
  withdrawn_reason text,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, template_id) references public.agreement_templates(org_id, id) on delete cascade,
  unique (template_id, version_number),
  unique (org_id, id),
  check ((status = 'draft') = (published_at is null)),
  check ((status = 'withdrawn') = (withdrawn_at is not null)),
  check (status <> 'withdrawn' or char_length(btrim(coalesce(withdrawn_reason, ''))) >= 3)
);

alter table public.agreement_templates
  add constraint agreement_templates_current_version_fkey
  foreign key (org_id, current_version_id) references public.agreement_template_versions(org_id, id);

create table public.agreement_template_version_communities (
  org_id uuid not null references public.orgs(id) on delete cascade,
  version_id uuid not null,
  community_id uuid not null references public.communities(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (version_id, community_id),
  foreign key (org_id, version_id) references public.agreement_template_versions(org_id, id) on delete cascade
);

create unique index agreement_template_versions_one_published
  on public.agreement_template_versions (template_id) where status = 'published';
create index agreement_templates_org_kind_status_idx on public.agreement_templates (org_id, kind, status);
create index agreement_templates_current_version_idx on public.agreement_templates (current_version_id);
create index agreement_templates_created_by_idx on public.agreement_templates (created_by);
create index agreement_templates_retired_by_idx on public.agreement_templates (retired_by);
create index agreement_template_versions_template_idx on public.agreement_template_versions (org_id, template_id);
create index agreement_template_versions_status_idx on public.agreement_template_versions (org_id, status);
create index agreement_template_versions_source_file_idx on public.agreement_template_versions (source_file_id);
create index agreement_template_versions_published_by_idx on public.agreement_template_versions (published_by);
create index agreement_template_versions_withdrawn_by_idx on public.agreement_template_versions (withdrawn_by);
create index agreement_template_versions_created_by_idx on public.agreement_template_versions (created_by);
create index agreement_template_version_communities_community_idx on public.agreement_template_version_communities (org_id, community_id);
create index agreement_template_version_communities_version_idx on public.agreement_template_version_communities (org_id, version_id);

create trigger agreement_templates_set_updated_at before update on public.agreement_templates
  for each row execute function public.tg_set_updated_at();
create trigger agreement_template_versions_set_updated_at before update on public.agreement_template_versions
  for each row execute function public.tg_set_updated_at();

-- A family's kind and live version are set only by publishing; a member renames,
-- reorders and retires it.
create or replace function public.guard_agreement_template()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.org_id is distinct from old.org_id or new.kind is distinct from old.kind
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'An agreement template''s kind and identity cannot change';
  end if;
  if current_user in ('anon', 'authenticated') and new.current_version_id is distinct from old.current_version_id then
    raise exception 'A template''s live version changes only by publishing or withdrawing' using errcode = '42501';
  end if;
  if old.status = 'retired' and new.status <> 'retired' then
    raise exception 'A retired agreement template stays retired';
  end if;
  return new;
end;
$$;
create trigger agreement_templates_guard before update on public.agreement_templates
  for each row execute function public.guard_agreement_template();

-- A published document is the legal text a buyer signs; it never changes. A
-- member edits a draft; publishing, superseding and withdrawing happen only in
-- the functions below.
create or replace function public.guard_agreement_template_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  member boolean := current_user in ('anon', 'authenticated');
  mutable constant text[] := array['status', 'published_at', 'published_by', 'withdrawn_at', 'withdrawn_by', 'withdrawn_reason', 'updated_at'];
  identity constant text[] := array['id', 'org_id', 'template_id', 'version_number', 'source_file_id', 'content_sha256',
    'size_bytes', 'page_count', 'storage_path', 'created_by', 'created_at'];
  key text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'An agreement template version starts as a draft' using errcode = '42501';
    end if;
    if exists (
      select 1 from public.files f
       where f.id = new.source_file_id and (f.org_id <> new.org_id or f.mime_type is distinct from 'application/pdf')
    ) then
      raise exception 'An agreement template is a PDF in the same organization' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'A published agreement template version is kept; withdraw it instead';
    end if;
    return old;
  end if;
  foreach key in array identity loop
    if to_jsonb(new) -> key is distinct from to_jsonb(old) -> key then
      raise exception 'An agreement template version''s document and identity cannot change; upload a new version';
    end if;
  end loop;
  if old.status = 'draft' then
    if new.status <> 'draft' and member then
      raise exception 'Publish an agreement template version through its publish action' using errcode = '42501';
    end if;
    if new.status not in ('draft', 'published') then
      raise exception 'A draft agreement template version can only be published';
    end if;
    return new;
  end if;
  if member then
    raise exception 'A published agreement template version is immutable' using errcode = '42501';
  end if;
  if (to_jsonb(new) - mutable) is distinct from (to_jsonb(old) - mutable)
     or new.published_at is distinct from old.published_at
     or new.published_by is distinct from old.published_by
     or not (
       new.status = old.status
       or (old.status = 'published' and new.status in ('superseded', 'withdrawn'))
       or (old.status = 'superseded' and new.status = 'withdrawn')
     ) then
    raise exception 'A published agreement template version is immutable';
  end if;
  return new;
end;
$$;
create trigger agreement_template_versions_guard
  before insert or update or delete on public.agreement_template_versions
  for each row execute function public.guard_agreement_template_version();

create or replace function public.guard_agreement_template_version_communities()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  row_version uuid := coalesce(new.version_id, old.version_id);
  row_org uuid := coalesce(new.org_id, old.org_id);
begin
  if tg_op = 'UPDATE' then
    raise exception 'Change a version''s communities by removing and adding them';
  end if;
  if not exists (select 1 from public.agreement_template_versions v where v.id = row_version and v.org_id = row_org and v.status = 'draft') then
    raise exception 'Only a draft agreement template version''s communities can change';
  end if;
  if tg_op = 'INSERT' and not exists (select 1 from public.communities c where c.id = new.community_id and c.org_id = new.org_id) then
    raise exception 'Community not found in this organization';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger agreement_template_version_communities_guard
  before insert or update or delete on public.agreement_template_version_communities
  for each row execute function public.guard_agreement_template_version_communities();

alter table public.agreement_templates enable row level security;
alter table public.agreement_template_versions enable row level security;
alter table public.agreement_template_version_communities enable row level security;

create policy agreement_templates_read on public.agreement_templates for select to authenticated
  using (public.has_org_permission(org_id, 'sales.read') or public.has_org_permission(org_id, 'agreement_template.manage'));
create policy agreement_templates_insert on public.agreement_templates for insert to authenticated
  with check (public.has_org_permission(org_id, 'agreement_template.manage') and created_by = (select auth.uid()) and current_version_id is null);
create policy agreement_templates_update on public.agreement_templates for update to authenticated
  using (public.has_org_permission(org_id, 'agreement_template.manage'))
  with check (public.has_org_permission(org_id, 'agreement_template.manage'));

create policy agreement_template_versions_read on public.agreement_template_versions for select to authenticated
  using (public.has_org_permission(org_id, 'sales.read') or public.has_org_permission(org_id, 'agreement_template.manage'));
create policy agreement_template_versions_insert on public.agreement_template_versions for insert to authenticated
  with check (public.has_org_permission(org_id, 'agreement_template.manage') and created_by = (select auth.uid()));
create policy agreement_template_versions_update on public.agreement_template_versions for update to authenticated
  using (public.has_org_permission(org_id, 'agreement_template.manage') and status = 'draft')
  with check (public.has_org_permission(org_id, 'agreement_template.manage'));
create policy agreement_template_versions_delete on public.agreement_template_versions for delete to authenticated
  using (public.has_org_permission(org_id, 'agreement_template.manage') and status = 'draft');

create policy agreement_template_version_communities_read on public.agreement_template_version_communities for select to authenticated
  using (public.has_org_permission(org_id, 'sales.read') or public.has_org_permission(org_id, 'agreement_template.manage'));
create policy agreement_template_version_communities_write on public.agreement_template_version_communities for insert to authenticated
  with check (public.has_org_permission(org_id, 'agreement_template.manage'));
create policy agreement_template_version_communities_delete on public.agreement_template_version_communities for delete to authenticated
  using (public.has_org_permission(org_id, 'agreement_template.manage'));
create policy agreement_template_version_communities_division_scope on public.agreement_template_version_communities
  as restrictive for all to authenticated
  using (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or community_id in (select public.member_reachable_community_ids())
  )
  with check (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or community_id in (select public.member_reachable_community_ids())
  );

revoke all on table public.agreement_templates, public.agreement_template_versions, public.agreement_template_version_communities from anon, authenticated;
grant select, insert, update on table public.agreement_templates to authenticated;
grant select, insert, update, delete on table public.agreement_template_versions to authenticated;
grant select, insert, delete on table public.agreement_template_version_communities to authenticated;
grant all on table public.agreement_templates, public.agreement_template_versions, public.agreement_template_version_communities to service_role;

-- Publishing supersedes the family's live version in one step. The family row
-- is the lock agreement creation shares, so a sale never resolves against a
-- half-published family.
create or replace function public.publish_agreement_template_version(p_org_id uuid, p_version_id uuid, p_actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.agreement_template_versions;
  t public.agreement_templates;
  superseded uuid;
begin
  if p_actor_id is null or not exists (select 1 from public.app_users where id = p_actor_id) then
    raise exception 'A template is published by a person' using errcode = '22023';
  end if;
  if (select auth.uid()) is not null and (select auth.uid()) <> p_actor_id then
    raise exception 'Template publication actor mismatch' using errcode = '42501';
  end if;
  select template_id into v.template_id from public.agreement_template_versions where org_id = p_org_id and id = p_version_id;
  if not found then raise exception 'Agreement template version not found'; end if;
  select * into t from public.agreement_templates where org_id = p_org_id and id = v.template_id for update;
  select * into v from public.agreement_template_versions where org_id = p_org_id and id = p_version_id for update;
  if t.status <> 'active' then raise exception 'A retired agreement template cannot publish a version'; end if;
  if v.status <> 'draft' then raise exception 'Only a draft version can be published'; end if;
  if t.kind = 'agreement' and v.required is distinct from true then
    update public.agreement_template_versions set required = true where id = v.id;
  end if;
  update public.agreement_template_versions set status = 'superseded'
   where org_id = p_org_id and template_id = t.id and status = 'published'
  returning id into superseded;
  update public.agreement_template_versions
     set status = 'published', published_at = now(), published_by = p_actor_id
   where id = v.id
  returning * into v;
  update public.agreement_templates set current_version_id = v.id where id = t.id;
  return jsonb_build_object('version', to_jsonb(v), 'superseded_version_id', superseded);
end;
$$;
revoke all on function public.publish_agreement_template_version(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.publish_agreement_template_version(uuid, uuid, uuid) to service_role;

-- A legal recall: the version stays on record, every unsigned packet holding it
-- is refused at signing preparation, and the family has no live version until
-- a new one is published.
create or replace function public.withdraw_agreement_template_version(p_org_id uuid, p_version_id uuid, p_actor_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.agreement_template_versions;
  affected integer;
begin
  if p_actor_id is null or not exists (select 1 from public.app_users where id = p_actor_id) then
    raise exception 'A template is withdrawn by a person' using errcode = '22023';
  end if;
  if (select auth.uid()) is not null and (select auth.uid()) <> p_actor_id then
    raise exception 'Template withdrawal actor mismatch' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'A withdrawal reason is required'; end if;
  select template_id into v.template_id from public.agreement_template_versions where org_id = p_org_id and id = p_version_id;
  if not found then raise exception 'Agreement template version not found'; end if;
  perform 1 from public.agreement_templates where org_id = p_org_id and id = v.template_id for update;
  select * into v from public.agreement_template_versions where org_id = p_org_id and id = p_version_id for update;
  if v.status not in ('published', 'superseded') then raise exception 'Only a published or superseded version can be withdrawn'; end if;
  update public.agreement_template_versions
     set status = 'withdrawn', withdrawn_at = now(), withdrawn_by = p_actor_id, withdrawn_reason = btrim(p_reason)
   where id = v.id
  returning * into v;
  update public.agreement_templates set current_version_id = null where org_id = p_org_id and id = v.template_id and current_version_id = v.id;
  select count(*) into affected from public.contracts c
   where c.org_id = p_org_id and c.contract_type = 'purchase_agreement' and c.status = 'draft'
     and exists (select 1 from jsonb_array_elements(coalesce(c.snapshot->'purchase_agreement'->'packet'->'documents', '[]'::jsonb)) d
                  where d->>'version_id' = v.id::text);
  return jsonb_build_object('version', to_jsonb(v), 'draft_agreements_affected', affected);
end;
$$;
revoke all on function public.withdraw_agreement_template_version(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.withdraw_agreement_template_version(uuid, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. The packet.
-- ---------------------------------------------------------------------------

-- Every published version that applies to a home in this community. A version
-- naming communities applies only there; one naming states only in them; both
-- must hold when it names both. Specificity: community 2, state 1, all 0.
create or replace function public.agreement_packet_candidates(p_org_id uuid, p_community_id uuid)
returns table (
  template_id uuid, version_id uuid, kind text, name text, sort_order integer, version_number integer,
  title text, required boolean, content_sha256 text, page_count integer, specificity integer
)
language sql
stable
security definer
set search_path = ''
as $$
  with home as (
    select public.agreement_jurisdiction(c.state) as jurisdiction
    from public.communities c
    where c.org_id = p_org_id and c.id = p_community_id
  ), live as (
    select t.id as template_id, v.id as version_id, t.kind, t.name, t.sort_order, v.version_number, v.title,
           (t.kind = 'agreement' or v.required) as required, v.content_sha256, v.page_count, v.applies_to_states,
           exists (select 1 from public.agreement_template_version_communities vc where vc.version_id = v.id) as scoped
    from public.agreement_templates t
    join public.agreement_template_versions v on v.org_id = t.org_id and v.template_id = t.id and v.status = 'published'
    where t.org_id = p_org_id and t.status = 'active'
  )
  select l.template_id, l.version_id, l.kind, l.name, l.sort_order, l.version_number, l.title, l.required,
         l.content_sha256, l.page_count,
         case when l.scoped then 2 when cardinality(l.applies_to_states) > 0 then 1 else 0 end
  from live l
  cross join home h
  where (cardinality(l.applies_to_states) = 0 or h.jurisdiction = any (l.applies_to_states))
    and (not l.scoped or exists (
      select 1 from public.agreement_template_version_communities vc
      where vc.version_id = l.version_id and vc.community_id = p_community_id
    ))
$$;
revoke all on function public.agreement_packet_candidates(uuid, uuid) from public, anon, authenticated;

-- The packet a home is sold on. The hash is owned here; the application only
-- compares it. `optional_offered` is what the seller may add; it is not part
-- of the packet and is stripped before a packet is stored.
create or replace function public.resolve_agreement_packet(p_org_id uuid, p_community_id uuid, p_optional_template_ids jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  jurisdiction text;
  base_specificity integer;
  base_count integer;
  requested uuid[];
  unknown integer;
  documents jsonb;
  offered jsonb;
begin
  if jsonb_typeof(coalesce(p_optional_template_ids, '[]'::jsonb)) is distinct from 'array' then
    raise exception 'Optional addenda must be a list';
  end if;
  select public.agreement_jurisdiction(c.state) into jurisdiction from public.communities c where c.org_id = p_org_id and c.id = p_community_id;
  if not found then raise exception 'Community not found'; end if;
  select coalesce(array_agg(distinct x.value::uuid), '{}') into requested
  from jsonb_array_elements_text(coalesce(p_optional_template_ids, '[]'::jsonb)) x;

  select max(c.specificity) into base_specificity
  from public.agreement_packet_candidates(p_org_id, p_community_id) c where c.kind = 'agreement';
  if base_specificity is null then
    raise exception 'No published purchase agreement covers this home''s community and state. Publish one under Settings → Templates → Agreements.'
      using detail = 'AGREEMENT_PACKET_UNAVAILABLE';
  end if;
  select count(*) into base_count
  from public.agreement_packet_candidates(p_org_id, p_community_id) c where c.kind = 'agreement' and c.specificity = base_specificity;
  if base_count > 1 then
    raise exception 'More than one published purchase agreement applies equally to this home. Narrow or retire one under Settings → Templates → Agreements.'
      using detail = 'AGREEMENT_PACKET_AMBIGUOUS';
  end if;
  select count(*) into unknown from unnest(requested) r(template_id)
  where not exists (
    select 1 from public.agreement_packet_candidates(p_org_id, p_community_id) c
    where c.template_id = r.template_id and c.kind = 'addendum' and not c.required
  );
  if unknown > 0 then
    raise exception 'An optional addendum no longer applies to this home. Review the packet again.' using detail = 'AGREEMENT_PACKET_CHANGED';
  end if;

  select jsonb_agg(jsonb_build_object(
           'kind', c.kind, 'template_id', c.template_id, 'version_id', c.version_id, 'version_number', c.version_number,
           'title', c.title, 'required', c.required, 'content_sha256', c.content_sha256, 'page_count', c.page_count)
         order by (c.kind = 'agreement') desc, c.sort_order, c.name, c.template_id)
    into documents
  from public.agreement_packet_candidates(p_org_id, p_community_id) c
  where (c.kind = 'agreement' and c.specificity = base_specificity)
     or (c.kind = 'addendum' and (c.required or c.template_id = any (requested)));

  select coalesce(jsonb_agg(jsonb_build_object('template_id', c.template_id, 'version_id', c.version_id, 'title', c.title)
           order by c.sort_order, c.name, c.template_id), '[]'::jsonb)
    into offered
  from public.agreement_packet_candidates(p_org_id, p_community_id) c
  where c.kind = 'addendum' and not c.required;

  return jsonb_build_object(
    'jurisdiction', jurisdiction,
    'community_id', p_community_id,
    'documents', documents,
    'hash', encode(sha256(convert_to(jsonb_build_object('jurisdiction', jurisdiction, 'documents', documents)::text, 'UTF8')), 'hex'),
    'optional_offered', offered
  );
end;
$$;
revoke all on function public.resolve_agreement_packet(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.resolve_agreement_packet(uuid, uuid, jsonb) to service_role;

-- What signing preparation refuses: no packet, a packet document withdrawn or
-- changed, or an addendum now required for the home that the packet lacks. A
-- newer version of a family already in the packet does not block; the packet
-- keeps the version the buyer was shown.
create or replace function public.assert_agreement_packet_signable(p_contract public.contracts)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  packet jsonb := p_contract.snapshot->'purchase_agreement'->'packet';
  community uuid;
  missing text;
begin
  if jsonb_typeof(packet) is distinct from 'object' or jsonb_typeof(packet->'documents') is distinct from 'array'
     or not exists (select 1 from jsonb_array_elements(packet->'documents') d where d->>'kind' = 'agreement') then
    raise exception 'This agreement has no versioned packet. Refresh its packet before preparing signatures.' using detail = 'AGREEMENT_PACKET_STALE';
  end if;
  if exists (
    select 1 from jsonb_array_elements(packet->'documents') d
    left join public.agreement_template_versions v on v.org_id = p_contract.org_id and v.id::text = d->>'version_id'
    where v.id is null or v.status = 'withdrawn' or v.content_sha256 is distinct from d->>'content_sha256'
  ) then
    raise exception 'A document in this agreement''s packet was withdrawn. Refresh its packet before preparing signatures.' using detail = 'AGREEMENT_PACKET_STALE';
  end if;
  select l.community_id into community from public.lots l
  where l.org_id = p_contract.org_id and l.id::text = p_contract.snapshot->'purchase_agreement'->'configuration'->>'lot_id';
  select string_agg(c.title, ', ' order by c.sort_order, c.name) into missing
  from public.agreement_packet_candidates(p_contract.org_id, community) c
  where c.kind = 'addendum' and c.required
    and not exists (select 1 from jsonb_array_elements(packet->'documents') d where d->>'template_id' = c.template_id::text);
  if missing is not null then
    raise exception 'This agreement''s packet is missing the required addendum %. Refresh its packet before preparing signatures.', missing
      using detail = 'AGREEMENT_PACKET_STALE';
  end if;
end;
$$;
revoke all on function public.assert_agreement_packet_signable(public.contracts) from public, anon, authenticated;

-- Why a draft's packet cannot be signed, for the deal's signing status; null
-- when it can.
create or replace function public.agreement_packet_stale_reason(p_org_id uuid, p_contract_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.contracts;
  detail text;
begin
  select * into c from public.contracts where org_id = p_org_id and id = p_contract_id and contract_type = 'purchase_agreement';
  if not found then raise exception 'Purchase agreement not found'; end if;
  perform public.assert_agreement_packet_signable(c);
  return null;
exception when raise_exception then
  get stacked diagnostics detail = pg_exception_detail;
  if detail = 'AGREEMENT_PACKET_STALE' then return sqlerrm; end if;
  raise;
end;
$$;
revoke all on function public.agreement_packet_stale_reason(uuid, uuid) from public, anon, authenticated;
grant execute on function public.agreement_packet_stale_reason(uuid, uuid) to service_role;

-- Agreement creation resolves the packet inside its transaction, under a share
-- lock on the org's template families, and refuses a packet the seller did not
-- review. Otherwise unchanged from 20261004000100; a packet refresh does not
-- wedge an idempotent creation retry.
create or replace function public.create_purchase_agreement_atomic(p_org_id uuid,p_reservation_id uuid,p_actor_id uuid,p_request jsonb,p_expected jsonb default null,p_snapshot jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 receipt public.purchase_agreement_creation_receipts; r public.lot_reservations; l public.lots; c public.contracts;
 home uuid; lot_key uuid; configuration jsonb; pricing jsonb; expected jsonb; packet jsonb;
 version public.house_plan_versions; plan public.house_plans; elevation public.house_plan_elevations;
 offer public.community_plan_availability; event_key uuid; audit_key bigint; contract_key uuid:=gen_random_uuid();
 offer_date date:=(clock_timestamp() at time zone 'UTC')::date; total bigint; effective date;
begin
 if p_org_id is null or p_reservation_id is null or p_actor_id is null or jsonb_typeof(p_request) is distinct from 'object'
   or p_request->>'reservationId' is distinct from p_reservation_id::text or coalesce(p_request->>'expectedQuoteHash','') !~ '^[a-f0-9]{64}$'
   or coalesce(p_request->>'expectedPacketHash','') !~ '^[a-f0-9]{64}$' then
   raise exception 'Valid purchase agreement creation identity and reviewed request required';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('agreement-create:'||p_org_id::text||':'||p_reservation_id::text,0));
 select * into receipt from public.purchase_agreement_creation_receipts where org_id=p_org_id and reservation_id=p_reservation_id;
 if found then
   perform public.assert_agreement_signing_actor(p_org_id,receipt.project_id,p_actor_id);
   perform 1 from public.projects where org_id=p_org_id and id=receipt.project_id and property_type='production' for share;
   if not found then raise exception 'Purchase agreement creation requires an actual production home'; end if;
   if receipt.request is distinct from p_request then raise exception 'The reservation already has a creation receipt for different reviewed inputs; reconcile its agreement'; end if;
   select * into c from public.contracts where org_id=p_org_id and id=receipt.contract_id;
   if not found or (public.purchase_agreement_signing_input(c) #- '{snapshot,purchase_agreement,packet}')
       is distinct from (receipt.contract_source #- '{snapshot,purchase_agreement,packet}') then
     raise exception 'The receipted agreement source changed; reconcile it before resuming';
   end if;
   return jsonb_build_object('receipt_id',receipt.id,'created',false,'contract',to_jsonb(c));
 end if;
 select l0.project_id,l0.id into home,lot_key from public.lot_reservations r0 join public.lots l0 on l0.id=r0.lot_id and l0.org_id=r0.org_id
 where r0.org_id=p_org_id and r0.id=p_reservation_id;
 if not found or home is null then raise exception 'Reserved lot with an actual home is required'; end if;
 perform public.assert_agreement_signing_actor(p_org_id,home,p_actor_id);
 perform 1 from public.projects where org_id=p_org_id and id=home and property_type='production' for share;
 if not found then raise exception 'Purchase agreement creation requires an actual production home'; end if;
 if p_snapshot is null then return null; end if; -- Read-only receipt probe.
 -- Lock referenced keys before the revision fence. FK checks during the lot
 -- update must not wait on a catalog deletion holding a row -> revision lock.
 perform 1 from public.orgs where id=p_org_id for key share;
 perform 1 from public.house_plans where org_id=p_org_id and id=(p_snapshot->'purchase_agreement'->'configuration'->>'house_plan_id')::uuid for key share;
 perform 1 from public.house_plan_versions where org_id=p_org_id and id=(p_snapshot->'purchase_agreement'->'configuration'->>'house_plan_version_id')::uuid for key share;
 perform 1 from public.house_plan_elevations where org_id=p_org_id and id=(p_snapshot->'purchase_agreement'->'configuration'->>'elevation_id')::uuid for key share;
 -- Capacity locks precede the revision lock, matching incentive policy writers.
 perform public.lock_agreement_incentive_capacity(p_org_id,p_request->'incentiveIds');
 perform public.assert_agreement_catalog_revision(p_org_id,p_expected->>'catalog_revision');
 if p_snapshot->'purchase_agreement'->'pricing'->>'catalogRevision' is distinct from p_expected->>'catalog_revision' then raise exception 'Quote catalog revision does not match commit evidence'; end if;
 select * into l from public.lots where org_id=p_org_id and id=lot_key for update;
 select * into r from public.lot_reservations where org_id=p_org_id and id=p_reservation_id for update;
 if l.id is null or r.id is null or l.project_id is distinct from home or r.lot_id is distinct from l.id or r.community_id is distinct from l.community_id
   or r.status is distinct from 'reserved' or r.contract_id is not null or l.status not in ('owned','developed','assigned','started')
   or p_request->>'lotId' is distinct from l.id::text then raise exception 'Reservation or actual-home ownership changed; no agreement was created'; end if;
 expected:=jsonb_build_object('reservation',jsonb_build_object('id',r.id,'org_id',r.org_id,'community_id',r.community_id,'lot_id',r.lot_id,
   'status',r.status,'contract_id',r.contract_id,'buyer_contact_id',r.buyer_contact_id,'co_buyer_contact_id',r.co_buyer_contact_id,'deposit_invoice_id',r.deposit_invoice_id),
   'lot',jsonb_build_object('id',l.id,'org_id',l.org_id,'community_id',l.community_id,'project_id',l.project_id,'status',l.status,'premium_cents',l.premium_cents,
   'house_plan_id',l.house_plan_id,'house_plan_version_id',l.house_plan_version_id,'house_plan_elevation_id',l.house_plan_elevation_id,'swing',l.swing),'catalog_revision',p_expected->>'catalog_revision');
 if expected is distinct from p_expected then raise exception 'Reservation or lot facts changed; review the sale again'; end if;
 -- The packet the seller reviewed must be the packet the home resolves to now.
 perform 1 from public.agreement_templates where org_id=p_org_id order by id for share;
 packet:=public.resolve_agreement_packet(p_org_id,l.community_id,coalesce(p_request->'optionalAddendumTemplateIds','[]'::jsonb))-'optional_offered';
 if p_snapshot->'purchase_agreement'->'packet' is distinct from packet or packet->>'hash' is distinct from p_request->>'expectedPacketHash' then
   raise exception 'The agreement packet changed since it was reviewed; review it again' using detail='AGREEMENT_PACKET_CHANGED';
 end if;
 if exists(select 1 from public.contracts where org_id=p_org_id and project_id=home and contract_type='purchase_agreement' and status in ('draft','active')) then
   raise exception 'This home already has an open purchase agreement; reconcile it';
 end if;
 if r.buyer_contact_id is null or r.buyer_contact_id=r.co_buyer_contact_id then raise exception 'Valid agreement buyer identity required'; end if;
 perform 1 from public.contacts where org_id=p_org_id and id=r.buyer_contact_id for share;
 if not found then raise exception 'Agreement buyer belongs to another organization or is unavailable'; end if;
 if r.co_buyer_contact_id is not null then
   perform 1 from public.contacts where org_id=p_org_id and id=r.co_buyer_contact_id for share;
   if not found then raise exception 'Agreement co-buyer belongs to another organization or is unavailable'; end if;
 end if;
 configuration:=p_snapshot->'purchase_agreement'->'configuration'; pricing:=p_snapshot->'purchase_agreement'->'pricing';
 if jsonb_typeof(configuration) is distinct from 'object' or jsonb_typeof(pricing) is distinct from 'object'
   or not(configuration ?& array['lot_id','house_plan_id','house_plan_version_id','elevation_id','swing','option_items'])
   or jsonb_typeof(configuration->'option_items') is distinct from 'array' or jsonb_typeof(p_request->'incentiveIds') is distinct from 'array'
   or configuration->>'lot_id' is distinct from l.id::text or coalesce(configuration->>'swing','') not in ('left','right')
   or pricing->>'quoteHash' is distinct from p_request->>'expectedQuoteHash'
   or configuration->'option_items' is distinct from p_request->'optionItems'
   or p_snapshot->'purchase_agreement'->'incentive_ids' is distinct from p_request->'incentiveIds'
   or jsonb_array_length(configuration->'option_items')>200 or jsonb_array_length(p_request->'incentiveIds')>50
   or p_snapshot->'purchase_agreement'->'deposits' is distinct from (case when r.deposit_invoice_id is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('invoice_id',r.deposit_invoice_id,'kind','earnest_deposit')) end) then raise exception 'Reviewed agreement configuration and quote required'; end if;
 -- Financing and the contingencies are signed terms: the snapshot carries exactly what the seller reviewed.
 if p_snapshot->'purchase_agreement'->'financing' is distinct from p_request->'financing'
   or p_snapshot->'purchase_agreement'->'contingencies' is distinct from p_request->'contingencies'
   or coalesce(p_request->>'financing','financed') not in ('cash','financed')
   or (p_request ? 'contingencies' and case when jsonb_typeof(p_request->'contingencies') = 'array'
     then jsonb_array_length(p_request->'contingencies')>20 else true end) then raise exception 'Reviewed agreement financing and contingencies required'; end if;
 if pricing->>'lotId' is distinct from l.id::text or pricing->>'communityId' is distinct from l.community_id::text
   or pricing->>'housePlanId' is distinct from configuration->>'house_plan_id' or pricing->>'housePlanVersionId' is distinct from configuration->>'house_plan_version_id'
   or pricing->>'elevationId' is distinct from configuration->>'elevation_id' or pricing->>'swing' is distinct from configuration->>'swing'
   or (p_request ? 'housePlanVersionId' and p_request->>'housePlanVersionId' is distinct from configuration->>'house_plan_version_id')
   or (p_request ? 'elevationId' and p_request->>'elevationId' is distinct from configuration->>'elevation_id')
   or (p_request ? 'swing' and p_request->>'swing' is distinct from configuration->>'swing') then raise exception 'Reviewed quote and configuration identities do not match'; end if;
 if coalesce(pricing->>'totalCents','') !~ '^[0-9]+$' then raise exception 'Agreement total must be integer cents'; end if;
 total:=(pricing->>'totalCents')::bigint;
 if total>9007199254740991 then raise exception 'Agreement total exceeds supported integer cents'; end if;
 select * into version from public.house_plan_versions where org_id=p_org_id and id=(configuration->>'house_plan_version_id')::uuid;
 if not found or version.status is distinct from 'released' or version.house_plan_id is distinct from (configuration->>'house_plan_id')::uuid then raise exception 'Released plan version ancestry changed'; end if;
 select * into plan from public.house_plans where org_id=p_org_id and id=version.house_plan_id;
 if not found or plan.status is distinct from 'active' then raise exception 'Agreement plan is no longer active'; end if;
 if l.house_plan_id is not null and l.house_plan_id<>plan.id or l.house_plan_version_id is not null and l.house_plan_version_id<>version.id
   or l.house_plan_elevation_id is not null and l.house_plan_elevation_id is distinct from (configuration->>'elevation_id')::uuid
   or l.swing<>'either' and l.swing<>configuration->>'swing' then raise exception 'Pinned home configuration changed'; end if;
 if configuration->>'elevation_id' is not null then
   select * into elevation from public.house_plan_elevations where org_id=p_org_id and id=(configuration->>'elevation_id')::uuid;
   if not found or elevation.house_plan_id<>plan.id or elevation.is_active is distinct from true then raise exception 'Active elevation ancestry changed'; end if;
 end if;
 offer_date:=(clock_timestamp() at time zone 'UTC')::date;
 select * into offer from public.community_plan_availability where org_id=p_org_id and community_id=l.community_id and house_plan_id=plan.id
   and elevation_id is not distinct from (configuration->>'elevation_id')::uuid and is_available
   and (effective_start is null or effective_start<=offer_date) and (effective_end is null or effective_end>=offer_date);
 if not found or offer.base_price_cents is distinct from (pricing->>'basePriceCents')::bigint
   or l.premium_cents is distinct from (pricing->>'lotPremiumCents')::bigint then raise exception 'Community base price or lot premium changed; review the quote again' using detail='AGREEMENT_QUOTE_CHANGED'; end if;
 effective:=coalesce((p_request->>'effectiveDate')::date,offer_date);
 if length(coalesce(p_request->>'terms',''))>20000 then raise exception 'Agreement terms exceed supported length'; end if;
 insert into public.contracts(id,org_id,project_id,number,title,status,contract_type,total_cents,currency,terms,effective_date,snapshot,buyer_contact_id,co_buyer_contact_id)
 values(contract_key,p_org_id,home,'PA-'||extract(year from offer_date)::text||'-'||left(replace(contract_key::text,'-',''),12),
   'Purchase Agreement — Lot '||l.lot_number,'draft','purchase_agreement',total,'usd',p_request->>'terms',effective,p_snapshot,r.buyer_contact_id,r.co_buyer_contact_id) returning * into c;
 update public.lot_reservations set contract_id=c.id where id=r.id and org_id=p_org_id;
 update public.lots set house_plan_id=plan.id,house_plan_version_id=version.id,house_plan_elevation_id=(configuration->>'elevation_id')::uuid,swing=configuration->>'swing'
 where id=l.id and org_id=p_org_id;
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
 values(p_org_id,'purchase_agreement_created','contract',c.id,jsonb_build_object('project_id',home,'total_cents',total,'reservation_id',r.id,'actor_id',p_actor_id,'packet_hash',packet->>'hash'),'activity') returning id into event_key;
 insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source)
 values(p_org_id,p_actor_id,'insert','contract',c.id,to_jsonb(c),'purchase_agreement_creation') returning id into audit_key;
 insert into public.purchase_agreement_creation_receipts(org_id,project_id,lot_id,reservation_id,contract_id,actor_id,request,contract_source,event_id,audit_id)
 values(p_org_id,home,l.id,r.id,c.id,p_actor_id,p_request,public.purchase_agreement_signing_input(c),event_key,audit_key) returning * into receipt;
 return jsonb_build_object('receipt_id',receipt.id,'created',true,'contract',to_jsonb(c));
end $$;
revoke all on function public.create_purchase_agreement_atomic(uuid,uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.create_purchase_agreement_atomic(uuid,uuid,uuid,jsonb,jsonb,jsonb) to service_role;

-- The member-path attach of a draft to its reservation is gone: creation is the
-- atomic function above, the only path.
drop function if exists public.attach_purchase_agreement_draft(uuid, uuid, uuid, uuid, uuid, uuid, text, uuid);

-- The signing freeze point refuses a stale packet. Otherwise unchanged from
-- 20261004000030.
create or replace function public.reserve_purchase_agreement_document(p_org_id uuid,p_contract_id uuid,p_actor_id uuid,p_expected jsonb,p_file_id uuid default null,p_recipients jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.contracts; d public.documents; home uuid; source_input jsonb; recipients jsonb; buyer jsonb; co_buyer jsonb; builder jsonb; builder_id uuid; f public.files; configuration jsonb; lot public.lots; reservation_count integer;
begin
 select project_id into home from public.contracts where id=p_contract_id and org_id=p_org_id and contract_type='purchase_agreement';
 if not found then raise exception 'Purchase agreement not found'; end if;
 perform pg_advisory_xact_lock(hashtextextended('agreement-packet:'||p_org_id::text||':'||p_contract_id::text,0));
 perform public.assert_agreement_signing_actor(p_org_id,home,p_actor_id);
 select * into c from public.contracts where id=p_contract_id and org_id=p_org_id and contract_type='purchase_agreement' for update;
 if not found or c.project_id is distinct from home or c.status is distinct from 'draft' then raise exception 'Draft purchase agreement ownership changed'; end if;
 source_input:=public.purchase_agreement_signing_input(c);
 if source_input is distinct from p_expected then raise exception 'Agreement source changed; review it before preparing signatures'; end if;
 perform 1 from public.agreement_templates where org_id=p_org_id order by id for share;
 perform public.assert_agreement_packet_signable(c);
 configuration:=c.snapshot->'purchase_agreement'->'configuration';
 if jsonb_typeof(configuration) is distinct from 'object' or not(configuration ?& array['lot_id','house_plan_id','house_plan_version_id','elevation_id','swing']) then raise exception 'Saved agreement home configuration needs reconciliation'; end if;
 select * into lot from public.lots where org_id=p_org_id and id=(configuration->>'lot_id')::uuid for share;
 if not found or lot.status is null or lot.status not in ('owned','developed','assigned','started') or lot.project_id is distinct from home or lot.house_plan_id is distinct from (configuration->>'house_plan_id')::uuid
   or lot.house_plan_version_id is distinct from (configuration->>'house_plan_version_id')::uuid or lot.house_plan_elevation_id is distinct from (configuration->>'elevation_id')::uuid
   or lot.swing is distinct from configuration->>'swing' then raise exception 'Saved agreement home configuration needs reconciliation'; end if;
 perform 1 from public.lot_reservations where org_id=p_org_id and contract_id=c.id order by id for update;
 select count(*) into reservation_count from public.lot_reservations where org_id=p_org_id and contract_id=c.id;
 if reservation_count<>1 or not exists(select 1 from public.lot_reservations where org_id=p_org_id and contract_id=c.id and lot_id=lot.id and status='reserved') then
   raise exception 'Saved agreement reservation ownership needs reconciliation';
 end if;
 if c.buyer_contact_id is null or c.buyer_contact_id=c.co_buyer_contact_id then raise exception 'Agreement buyer identity is invalid'; end if;
 select * into d from public.documents where org_id=p_org_id and source_entity_type='contract' and source_entity_id=c.id and metadata->>'purchase_agreement'='true' for update;
 if found then
   if d.metadata->'agreement_signing_input' is distinct from source_input or d.project_id is distinct from home or d.status not in ('draft','sent','signed') then
     raise exception 'Existing agreement signing document requires reconciliation';
   end if;
   builder_id:=(d.metadata->'draft_recipients'->-1->>'user_id')::uuid;
 else builder_id:=p_actor_id;
 end if;
 -- Freeze the current bound identities through this transaction. Existing packets
 -- keep their original builder signer even when another authorized member resumes.
 perform 1 from public.contacts where org_id=p_org_id and id in (c.buyer_contact_id,c.co_buyer_contact_id) order by id for share;
 select jsonb_build_object('type','contact','contact_id',id,'user_id',null,'name',full_name,'email',email,'role','signer','signer_role','buyer','sequence',1,'required',true)
 into buyer from public.contacts where org_id=p_org_id and id=c.buyer_contact_id and coalesce(email,'')<>'';
 if buyer is null then raise exception 'Agreement buyer contact unavailable'; end if;
 if c.co_buyer_contact_id is not null then
   select jsonb_build_object('type','contact','contact_id',id,'user_id',null,'name',full_name,'email',email,'role','signer','signer_role','co_buyer','sequence',1,'required',true)
   into co_buyer from public.contacts where org_id=p_org_id and id=c.co_buyer_contact_id and coalesce(email,'')<>'';
   if co_buyer is null then raise exception 'Agreement co-buyer contact unavailable'; end if;
 end if;
 perform 1 from public.app_users where id=builder_id for share;
 perform 1 from public.memberships where org_id=p_org_id and user_id=builder_id and status='active' order by id for share;
 if not found then raise exception 'Agreement builder signer is not an active organization member'; end if;
 select jsonb_build_object('type','internal_user','contact_id',null,'user_id',id,'name',full_name,'email',email,'role','signer','signer_role','builder','sequence',2,'required',true)
 into builder from public.app_users where id=builder_id and coalesce(email,'')<>'';
 if builder is null then raise exception 'Agreement builder signer unavailable'; end if;
 recipients:=jsonb_build_array(buyer)||case when co_buyer is null then '[]'::jsonb else jsonb_build_array(co_buyer) end||jsonb_build_array(builder);
 if exists(select 1 from jsonb_array_elements(recipients) r where coalesce(r->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then raise exception 'Valid agreement signer emails required'; end if;
 if d.id is not null then
   select * into f from public.files where id=d.source_file_id and org_id=p_org_id and project_id=home and archived_at is null for share;
   if not found or d.metadata->'agreement_source_file' is distinct from jsonb_build_object('file_id',f.id,'sha256',f.checksum,'size_bytes',f.size_bytes,'storage_path',f.storage_path,'mime_type',f.mime_type,'source',f.source,'visibility',f.visibility,'current_version_id',f.current_version_id) then
     raise exception 'Agreement source file evidence changed; reconcile the existing packet';
   end if;
   if d.metadata->'draft_recipients' is distinct from recipients then raise exception 'Agreement signer details changed; reconcile the existing packet'; end if;
   return to_jsonb(d);
 end if;
 if p_file_id is null then return null; end if;
 if recipients is distinct from p_recipients then raise exception 'Agreement PDF recipients changed; review before preparing signatures'; end if;
 select * into f from public.files where id=p_file_id and org_id=p_org_id and project_id=home and archived_at is null for share;
 if not found or f.mime_type is distinct from 'application/pdf' or f.source is distinct from 'generated' or f.visibility is distinct from 'private' or coalesce(f.checksum,'') !~ '^[0-9a-f]{64}$' or coalesce(f.size_bytes,0)<=0 then raise exception 'Verified private agreement source file required'; end if;
 insert into public.documents(org_id,project_id,document_type,title,source_file_id,source_entity_type,source_entity_id,created_by,metadata)
 values(p_org_id,home,'contract',c.title,f.id,'contract',c.id,p_actor_id,jsonb_build_object('contract_id',c.id,'purchase_agreement',true,'agreement_signing_input',source_input,'draft_recipients',recipients,'agreement_source_file',jsonb_build_object('file_id',f.id,'sha256',f.checksum,'size_bytes',f.size_bytes,'storage_path',f.storage_path,'mime_type',f.mime_type,'source',f.source,'visibility',f.visibility,'current_version_id',f.current_version_id))) returning * into d;
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org_id,'purchase_agreement_signing_prepared','contract',c.id,jsonb_build_object('document_id',d.id,'actor_id',p_actor_id),'activity');
 insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source)
 values(p_org_id,p_actor_id,'insert','document',d.id,to_jsonb(d),'agreement_signing_ownership');
 return to_jsonb(d);
end $$;
revoke all on function public.reserve_purchase_agreement_document(uuid,uuid,uuid,jsonb,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_purchase_agreement_document(uuid,uuid,uuid,jsonb,uuid,jsonb) to service_role;

-- A draft whose packet went stale before signing preparation takes the packet
-- the home resolves to now. Once a signing document exists the packet is
-- frozen with it; the agreement is voided and rewritten instead.
create or replace function public.refresh_purchase_agreement_packet(p_org_id uuid, p_contract_id uuid, p_actor_id uuid, p_optional_template_ids jsonb, p_expected_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.contracts;
  community uuid;
  packet jsonb;
  before_packet jsonb;
begin
  select project_id into c.project_id from public.contracts where org_id = p_org_id and id = p_contract_id and contract_type = 'purchase_agreement';
  if not found then raise exception 'Purchase agreement not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended('agreement-packet:'||p_org_id::text||':'||p_contract_id::text,0));
  perform public.assert_agreement_signing_actor(p_org_id, c.project_id, p_actor_id);
  select * into c from public.contracts where org_id = p_org_id and id = p_contract_id for update;
  if c.status <> 'draft' or c.signed_at is not null then raise exception 'Only an unsigned draft agreement''s packet can be refreshed'; end if;
  if exists (select 1 from public.documents where org_id = p_org_id and source_entity_type = 'contract' and source_entity_id = c.id and metadata->>'purchase_agreement' = 'true') then
    raise exception 'This agreement''s signing packet is already prepared. Void the agreement and write a new one to change its documents.';
  end if;
  select l.community_id into community from public.lots l
  where l.org_id = p_org_id and l.id::text = c.snapshot->'purchase_agreement'->'configuration'->>'lot_id';
  if community is null then raise exception 'Saved agreement home configuration needs reconciliation'; end if;
  perform 1 from public.agreement_templates where org_id = p_org_id order by id for share;
  packet := public.resolve_agreement_packet(p_org_id, community, coalesce(p_optional_template_ids, '[]'::jsonb)) - 'optional_offered';
  if packet->>'hash' is distinct from p_expected_hash then
    raise exception 'The agreement packet changed since it was reviewed; review it again' using detail = 'AGREEMENT_PACKET_CHANGED';
  end if;
  before_packet := c.snapshot->'purchase_agreement'->'packet';
  update public.contracts set snapshot = jsonb_set(snapshot, '{purchase_agreement,packet}', packet, true)
  where id = c.id;
  insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
  values (p_org_id, 'purchase_agreement_packet_refreshed', 'contract', c.id,
    jsonb_build_object('project_id', c.project_id, 'actor_id', p_actor_id, 'from_hash', before_packet->>'hash', 'to_hash', packet->>'hash'), 'activity');
  insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
  values (p_org_id, p_actor_id, 'update', 'contract', c.id, jsonb_build_object('packet', before_packet), jsonb_build_object('packet', packet), 'purchase_agreement_packet_refresh');
  return packet;
end;
$$;
revoke all on function public.refresh_purchase_agreement_packet(uuid, uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.refresh_purchase_agreement_packet(uuid, uuid, uuid, jsonb, text) to service_role;

-- A signed agreement's snapshot is the signed terms, and nothing else: a
-- cancellation is a fact about the sale, recorded on its cancellation receipt.
create or replace function public.guard_binding_purchase_agreement_pricing()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.contract_type is distinct from 'purchase_agreement'
     or not (old.status = 'active' or old.signed_at is not null) then
    return new;
  end if;
  if new.contract_type is distinct from old.contract_type
     or new.org_id is distinct from old.org_id
     or new.project_id is distinct from old.project_id
     or new.total_cents is distinct from old.total_cents
     or new.currency is distinct from old.currency
     or new.snapshot is distinct from old.snapshot
  then
    raise exception 'A signed purchase agreement''s price and configuration cannot be changed. Amend it with a change order.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Versions: the signed agreement and its buyer-signed amendments.
-- ---------------------------------------------------------------------------

create table public.purchase_agreement_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  contract_id uuid not null references public.contracts(id) on delete cascade,
  version_number integer not null check (version_number >= 1),
  kind text not null check (kind in ('original', 'amendment')),
  change_order_id uuid unique references public.change_orders(id),
  price_delta_cents bigint not null,
  authorized_total_cents bigint not null check (authorized_total_cents >= 0),
  scope jsonb not null,
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  signature jsonb not null default '{}'::jsonb,
  executed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (contract_id, version_number),
  check ((kind = 'original') = (version_number = 1)),
  check ((kind = 'original') = (change_order_id is null))
);
create index purchase_agreement_versions_project_idx on public.purchase_agreement_versions (org_id, project_id);
create index purchase_agreement_versions_contract_idx on public.purchase_agreement_versions (org_id, contract_id, version_number);

-- The only way a version leaves is with its agreement's home or organization:
-- inside that cascade the agreement is already gone.
create or replace function public.guard_purchase_agreement_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.contracts c where c.id = old.contract_id) then
    return old;
  end if;
  raise exception 'A purchase agreement version is a signed record and cannot change';
end;
$$;
revoke all on function public.guard_purchase_agreement_version() from public, anon, authenticated;
create trigger purchase_agreement_versions_immutable before update or delete on public.purchase_agreement_versions
  for each row execute function public.guard_purchase_agreement_version();

alter table public.purchase_agreement_versions enable row level security;
create policy purchase_agreement_versions_read on public.purchase_agreement_versions for select to authenticated
  using (public.has_org_permission(org_id, 'sales.read'));
create policy purchase_agreement_versions_division_scope on public.purchase_agreement_versions
  as restrictive for all to authenticated
  using (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or project_id in (select public.member_reachable_project_ids())
  );
revoke all on table public.purchase_agreement_versions from anon, authenticated;
grant select on table public.purchase_agreement_versions to authenticated;
grant all on table public.purchase_agreement_versions to service_role;

-- The current authorized terms of each agreement: its head version.
create view public.purchase_agreement_authorized_terms
with (security_invoker = true)
as
select distinct on (v.contract_id)
  v.org_id, v.project_id, v.contract_id, v.id as version_id, v.version_number, v.authorized_total_cents,
  (select o.authorized_total_cents from public.purchase_agreement_versions o where o.contract_id = v.contract_id and o.version_number = 1) as original_total_cents,
  v.executed_at
from public.purchase_agreement_versions v
order by v.contract_id, v.version_number desc;
revoke all on table public.purchase_agreement_authorized_terms from anon, authenticated;
grant select on table public.purchase_agreement_authorized_terms to authenticated, service_role;

create or replace function public.purchase_agreement_original_scope(p_contract public.contracts)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'configuration', p_contract.snapshot->'purchase_agreement'->'configuration',
    'pricing', p_contract.snapshot->'purchase_agreement'->'pricing',
    'packet', p_contract.snapshot->'purchase_agreement'->'packet',
    'terms', p_contract.terms,
    'buyer_contact_id', p_contract.buyer_contact_id,
    'co_buyer_contact_id', p_contract.co_buyer_contact_id
  )
$$;
revoke all on function public.purchase_agreement_original_scope(public.contracts) from public, anon, authenticated;

-- Backfill, before the triggers exist: every signed agreement gets its original
-- version, and each change order the buyer signed after it gets the next one.
insert into public.purchase_agreement_versions (org_id, project_id, contract_id, version_number, kind, price_delta_cents,
  authorized_total_cents, scope, source_hash, signature, executed_at)
select c.org_id, c.project_id, c.id, 1, 'original', c.total_cents, c.total_cents,
       public.purchase_agreement_original_scope(c),
       encode(sha256(convert_to(public.purchase_agreement_original_scope(c)::text, 'UTF8')), 'hex'),
       coalesce(c.signature_data, '{}'::jsonb), coalesce(c.signed_at, c.updated_at)
from public.contracts c
where c.contract_type = 'purchase_agreement' and c.status = 'active' and c.total_cents >= 0;

do $$
declare
  stale record;
begin
  for stale in
    select cl.id as closing_id, cl.project_id, count(co.id) as unbound
    from public.closings cl
    join public.change_orders co on co.org_id = cl.org_id and co.project_id = cl.project_id and co.status = 'approved'
    join public.contracts c on c.org_id = cl.org_id and c.project_id = cl.project_id and c.contract_type = 'purchase_agreement' and c.status = 'active'
    where cl.status not in ('closed', 'cancelled')
      and not (co.requires_signature and co.approved_at >= coalesce(c.signed_at, c.created_at))
    group by cl.id, cl.project_id
  loop
    raise notice 'Closing % (project %) no longer counts % approved change order(s) the buyer did not sign after the agreement', stale.closing_id, stale.project_id, stale.unbound;
  end loop;
end $$;

with bound as (
  select co.id, c.id as contract_id
  from public.change_orders co
  join public.contracts c on c.org_id = co.org_id and c.project_id = co.project_id
   and c.contract_type = 'purchase_agreement' and c.status = 'active'
  where co.status = 'approved' and co.requires_signature
    and co.approved_at >= coalesce(c.signed_at, c.created_at)
)
update public.change_orders co set contract_id = bound.contract_id
from bound where co.id = bound.id;

insert into public.purchase_agreement_versions (org_id, project_id, contract_id, version_number, kind, change_order_id,
  price_delta_cents, authorized_total_cents, scope, source_hash, signature, executed_at)
select ordered.org_id, ordered.project_id, ordered.contract_id, ordered.version_number, 'amendment', ordered.id,
       ordered.total_cents, ordered.authorized_total_cents, ordered.scope,
       encode(sha256(convert_to(ordered.scope::text, 'UTF8')), 'hex'), ordered.signature, ordered.approved_at
from (
  select co.org_id, co.project_id, co.contract_id, co.id, coalesce(co.total_cents, 0)::bigint as total_cents, co.approved_at,
         1 + row_number() over (partition by co.contract_id order by co.approved_at, co.id) as version_number,
         c.total_cents + sum(coalesce(co.total_cents, 0)) over (partition by co.contract_id order by co.approved_at, co.id) as authorized_total_cents,
         jsonb_build_object('change_order_id', co.id, 'co_number', co.co_number, 'title', co.title, 'summary', co.summary,
           'days_impact', co.days_impact, 'total_cents', co.total_cents, 'backfilled', true) as scope,
         jsonb_build_object('method', coalesce(co.metadata->>'approval_method', case when co.metadata->>'approved_via_envelope' = 'true' then 'envelope' end),
           'signer_name', co.metadata->>'approved_signer_name', 'signer_email', co.metadata->>'approved_signer_email') as signature
  from public.change_orders co
  join public.contracts c on c.id = co.contract_id
  where co.contract_id is not null and co.status = 'approved' and c.contract_type = 'purchase_agreement'
) ordered
where ordered.authorized_total_cents >= 0;

-- Signing an agreement writes version 1. Imports insert agreements already
-- active, so the insert is covered too.
create or replace function public.tg_purchase_agreement_original_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  scope jsonb;
begin
  scope := public.purchase_agreement_original_scope(new);
  insert into public.purchase_agreement_versions (org_id, project_id, contract_id, version_number, kind, price_delta_cents,
    authorized_total_cents, scope, source_hash, signature, executed_at)
  values (new.org_id, new.project_id, new.id, 1, 'original', new.total_cents, new.total_cents, scope,
    encode(sha256(convert_to(scope::text, 'UTF8')), 'hex'), coalesce(new.signature_data, '{}'::jsonb), coalesce(new.signed_at, now()))
  on conflict (contract_id, version_number) do nothing;
  return null;
end;
$$;
revoke all on function public.tg_purchase_agreement_original_version() from public, anon, authenticated;
create trigger purchase_agreement_original_version
  after insert or update of status on public.contracts
  for each row
  when (new.contract_type = 'purchase_agreement' and new.status = 'active' and new.total_cents is not null)
  execute function public.tg_purchase_agreement_original_version();

-- A change order the buyer must sign, approved on a home under a signed
-- agreement, amends that agreement: it is bound to it at approval, it needs the
-- buyer's evidence (an executed envelope, a portal signature, or the signed
-- copy attached to an offline approval), and once approved it is part of the
-- agreement and cannot be voided or repriced.
create or replace function public.tg_change_order_agreement_binding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  bound public.contracts;
  agreement public.contracts;
  evidenced boolean;
begin
  if old.contract_id is not null then
    select * into bound from public.contracts where id = old.contract_id;
  end if;
  if new.contract_id is distinct from old.contract_id
     and (bound.contract_type = 'purchase_agreement'
          or exists (select 1 from public.contracts where id = new.contract_id and contract_type = 'purchase_agreement')) then
    raise exception 'A change order''s purchase agreement is set when it is approved and never moves' using errcode = '42501';
  end if;
  if bound.contract_type = 'purchase_agreement' and old.status = 'approved' then
    if new.status is distinct from 'approved' or new.lifecycle is distinct from old.lifecycle then
      raise exception 'A signed amendment is part of the purchase agreement and cannot be voided. Reverse it with a new change order the buyer signs.';
    end if;
    if new.total_cents is distinct from old.total_cents or new.project_id is distinct from old.project_id then
      raise exception 'A signed amendment''s price cannot change';
    end if;
    return new;
  end if;
  if new.status = 'approved' and old.status is distinct from 'approved' and new.requires_signature then
    select * into agreement from public.contracts
     where org_id = new.org_id and project_id = new.project_id and contract_type = 'purchase_agreement' and status in ('draft', 'active')
     order by created_at desc
     limit 1
     for update;
    if found and agreement.status = 'active' then
      evidenced := coalesce(new.metadata->>'approved_via_envelope', '') = 'true'
        or coalesce(new.metadata->>'approval_method', '') = 'portal_native_signature'
        or (coalesce(new.metadata->>'approval_method', '') = 'manual_offline'
            and coalesce(new.metadata->>'approved_signed_file_id', '') <> '');
      if not evidenced then
        raise exception 'This change order amends a signed purchase agreement, so it needs the buyer''s signature: send it for e-signature, have the buyer sign it in their portal, or attach the signed copy to the approval.'
          using errcode = '42501';
      end if;
      new.contract_id := agreement.id;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.tg_change_order_agreement_binding() from public, anon, authenticated;
create trigger change_order_agreement_binding
  before update on public.change_orders
  for each row execute function public.tg_change_order_agreement_binding();

create or replace function public.tg_change_order_agreement_amendment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  head public.purchase_agreement_versions;
  scope jsonb;
  next_total bigint;
begin
  select * into head from public.purchase_agreement_versions
   where contract_id = new.contract_id order by version_number desc limit 1;
  if not found then
    raise exception 'The signed purchase agreement has no original version; reconcile it before approving amendments';
  end if;
  next_total := head.authorized_total_cents + coalesce(new.total_cents, 0);
  if next_total < 0 then
    raise exception 'This amendment would take the agreement price below zero';
  end if;
  scope := jsonb_build_object(
    'change_order_id', new.id, 'co_number', new.co_number, 'title', new.title, 'summary', new.summary,
    'days_impact', new.days_impact, 'total_cents', new.total_cents,
    'selection_change', new.metadata->'selection_change', 'plan_adoption', new.metadata->'plan_adoption',
    'lines', (
      select coalesce(jsonb_agg(jsonb_build_object('description', l.description, 'quantity', l.quantity, 'unit', l.unit,
               'unit_cost_cents', l.unit_cost_cents) order by l.sort_order, l.id), '[]'::jsonb)
      from public.change_order_lines l where l.org_id = new.org_id and l.change_order_id = new.id
    ));
  insert into public.purchase_agreement_versions (org_id, project_id, contract_id, version_number, kind, change_order_id,
    price_delta_cents, authorized_total_cents, scope, source_hash, signature, executed_at)
  values (new.org_id, new.project_id, new.contract_id, head.version_number + 1, 'amendment', new.id,
    coalesce(new.total_cents, 0), next_total, scope, encode(sha256(convert_to(scope::text, 'UTF8')), 'hex'),
    jsonb_build_object(
      'method', case when new.metadata->>'approved_via_envelope' = 'true' then 'envelope' else new.metadata->>'approval_method' end,
      'envelope_id', new.metadata->>'approved_envelope_id',
      'executed_file_id', coalesce(new.metadata->>'approved_executed_file_id', new.metadata->>'approved_signed_file_id'),
      'signer_name', new.metadata->>'approved_signer_name',
      'signer_email', new.metadata->>'approved_signer_email',
      'signer_ip', new.metadata->>'approved_signer_ip'),
    coalesce(new.approved_at, now()));
  return null;
end;
$$;
revoke all on function public.tg_change_order_agreement_amendment() from public, anon, authenticated;
create trigger change_order_agreement_amendment
  after update on public.change_orders
  for each row
  when (new.contract_id is not null and new.status = 'approved' and old.status is distinct from 'approved')
  execute function public.tg_change_order_agreement_amendment();

-- ---------------------------------------------------------------------------
-- 4. Cancellation.
-- ---------------------------------------------------------------------------

create table public.purchase_agreement_cancellations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  contract_id uuid not null unique references public.contracts(id) on delete cascade,
  reservation_id uuid references public.lot_reservations(id),
  actor_id uuid not null references public.app_users(id),
  reason text not null check (char_length(btrim(reason)) between 3 and 1000),
  deposit_disposition text not null check (deposit_disposition in ('refund', 'forfeit', 'split', 'none')),
  forfeit_cents bigint not null default 0 check (forfeit_cents >= 0),
  refund_cents bigint not null default 0 check (refund_cents >= 0),
  plan jsonb not null,
  plan_hash text not null check (plan_hash ~ '^[0-9a-f]{64}$'),
  outcomes jsonb not null default '{}'::jsonb,
  settlement_status text not null default 'pending' check (settlement_status in ('pending', 'settling', 'completed', 'failed')),
  settlement_error text,
  settlement_claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((settlement_status = 'completed') = (completed_at is not null))
);
create index purchase_agreement_cancellations_project_idx on public.purchase_agreement_cancellations (org_id, project_id);
create index purchase_agreement_cancellations_reservation_idx on public.purchase_agreement_cancellations (reservation_id);
create index purchase_agreement_cancellations_actor_idx on public.purchase_agreement_cancellations (actor_id);
create index purchase_agreement_cancellations_open_idx on public.purchase_agreement_cancellations (org_id, settlement_status)
  where settlement_status <> 'completed';
create trigger purchase_agreement_cancellations_set_updated_at before update on public.purchase_agreement_cancellations
  for each row execute function public.tg_set_updated_at();

-- What was decided is fixed; only the settlement of it moves.
create or replace function public.guard_purchase_agreement_cancellation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  settling constant text[] := array['outcomes', 'settlement_status', 'settlement_error', 'settlement_claimed_at', 'completed_at', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.contracts c where c.id = old.contract_id) then return old; end if;
    raise exception 'A purchase agreement cancellation is kept';
  end if;
  if (to_jsonb(new) - settling) is distinct from (to_jsonb(old) - settling) then
    raise exception 'A purchase agreement cancellation''s decision cannot change';
  end if;
  if old.settlement_status = 'completed' and new.settlement_status <> 'completed' then
    raise exception 'A settled purchase agreement cancellation stays settled';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_purchase_agreement_cancellation() from public, anon, authenticated;
create trigger purchase_agreement_cancellations_guard before update or delete on public.purchase_agreement_cancellations
  for each row execute function public.guard_purchase_agreement_cancellation();

alter table public.purchase_agreement_cancellations enable row level security;
create policy purchase_agreement_cancellations_read on public.purchase_agreement_cancellations for select to authenticated
  using (public.has_org_permission(org_id, 'sales.read'));
create policy purchase_agreement_cancellations_division_scope on public.purchase_agreement_cancellations
  as restrictive for all to authenticated
  using (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or project_id in (select public.member_reachable_project_ids())
  );
revoke all on table public.purchase_agreement_cancellations from anon, authenticated;
grant select on table public.purchase_agreement_cancellations to authenticated;
grant all on table public.purchase_agreement_cancellations to service_role;

-- Everything cancelling this sale would touch, as one hashed plan. The void
-- recomputes it under its locks and refuses a plan the seller did not review.
create or replace function public.preview_purchase_agreement_cancellation(p_org_id uuid, p_contract_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.contracts;
  reservation public.lot_reservations;
  closing record;
  doc_ids uuid[];
  pending_ids uuid[];
  plan jsonb;
  deposit jsonb := jsonb_build_object('collected_cents', 0, 'refunded_cents', 0, 'applied_cents', 0, 'available_cents', 0, 'payments', '[]'::jsonb);
begin
  select * into c from public.contracts where org_id = p_org_id and id = p_contract_id and contract_type = 'purchase_agreement';
  if not found or c.status not in ('draft', 'active') then raise exception 'Active purchase agreement not found'; end if;
  select * into reservation from public.lot_reservations
   where org_id = p_org_id and contract_id = c.id and status in ('hold', 'reserved', 'converted')
   order by created_at desc limit 1;
  select id, status into closing from public.closings
   where org_id = p_org_id and project_id = c.project_id and status <> 'cancelled'
   order by created_at desc limit 1;

  if reservation.deposit_invoice_id is not null then
    with received as (
      select p.id, p.invoice_id, p.amount_cents
      from public.payments p
      where p.org_id = p_org_id and p.invoice_id = reservation.deposit_invoice_id and p.status in ('succeeded', 'completed')
        and coalesce(p.metadata->>'customer_deposit_application', '') in ('', 'false')
    ), refunded as (
      select r.payment_id, sum(r.amount_cents) as cents
      from public.payment_reversals r
      where r.org_id = p_org_id and r.payment_id in (select id from received) and r.status in ('pending', 'succeeded')
      group by r.payment_id
    ), applied as (
      select (a.metadata->>'deposit_payment_id')::uuid as payment_id,
             sum(a.amount_cents - coalesce((select sum(x.amount_cents) from public.payment_reversals x
                                            where x.org_id = p_org_id and x.payment_id = a.id and x.status in ('pending', 'succeeded')), 0)) as cents
      from public.payments a
      where a.org_id = p_org_id and a.metadata->>'deposit_payment_id' in (select id::text from received)
        and a.status in ('succeeded', 'completed', 'paid')
      group by 1
    ), lines as (
      select rc.id, rc.invoice_id, rc.amount_cents, coalesce(rf.cents, 0) as refunded_cents, coalesce(ap.cents, 0) as applied_cents,
             greatest(rc.amount_cents - coalesce(rf.cents, 0) - coalesce(ap.cents, 0), 0) as available_cents
      from received rc
      left join refunded rf on rf.payment_id = rc.id
      left join applied ap on ap.payment_id = rc.id
    )
    select jsonb_build_object(
      'collected_cents', coalesce(sum(amount_cents), 0), 'refunded_cents', coalesce(sum(refunded_cents), 0),
      'applied_cents', coalesce(sum(applied_cents), 0), 'available_cents', coalesce(sum(available_cents), 0),
      'payments', coalesce(jsonb_agg(jsonb_build_object('payment_id', id, 'invoice_id', invoice_id, 'amount_cents', amount_cents,
        'refunded_cents', refunded_cents, 'applied_cents', applied_cents, 'available_cents', available_cents) order by id), '[]'::jsonb))
      into deposit
    from lines;
  end if;

  select coalesce(array_agg(d.id), '{}') into doc_ids from public.documents d
   where d.org_id = p_org_id and d.source_entity_type = 'contract' and d.source_entity_id = c.id;
  select coalesce(array_agg(co.id order by co.id), '{}') into pending_ids from public.change_orders co
   where co.org_id = p_org_id and co.project_id = c.project_id and co.status not in ('approved', 'cancelled', 'rejected')
     and coalesce(co.lifecycle, 'draft') in ('draft', 'pricing', 'proposed') and (co.client_visible or co.requires_signature);

  plan := jsonb_build_object(
    'contract', jsonb_build_object('id', c.id, 'status', c.status, 'number', c.number, 'project_id', c.project_id),
    'blocked', case when closing.status = 'closed' then 'This sale has closed. Reverse the closing first, then cancel the agreement.' end,
    'closing', case when closing.id is null then null else jsonb_build_object('id', closing.id, 'status', closing.status) end,
    'reservation', case when reservation.id is null then null else jsonb_build_object('id', reservation.id, 'status', reservation.status,
      'deposit_invoice_id', reservation.deposit_invoice_id, 'prospect_id', reservation.prospect_id) end,
    'deposit', deposit,
    'envelopes', (
      select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'status', e.status, 'source_entity_type', e.source_entity_type,
               'source_entity_id', e.source_entity_id) order by e.id), '[]'::jsonb)
      from public.envelopes e
      where e.org_id = p_org_id and e.status not in ('executed', 'voided')
        and (e.document_id = any (doc_ids) or (e.source_entity_type = 'change_order' and e.source_entity_id = any (pending_ids)))
    ),
    'pending_change_orders', (
      select coalesce(jsonb_agg(jsonb_build_object('id', co.id, 'co_number', co.co_number, 'title', co.title, 'total_cents', co.total_cents)
               order by co.co_number nulls last, co.id), '[]'::jsonb)
      from public.change_orders co where co.id = any (pending_ids)
    ),
    'amendments', (
      select jsonb_build_object('count', count(*), 'total_cents', coalesce(sum(v.price_delta_cents), 0))
      from public.purchase_agreement_versions v where v.contract_id = c.id and v.kind = 'amendment'
    ),
    'variance_orders', jsonb_build_object(
      'to_void', (
        select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'total_cents', x.total_cents, 'status', x.status) order by x.id), '[]'::jsonb)
        from public.commitment_change_orders x
        where x.org_id = p_org_id and x.prime_change_order_id = any (pending_ids) and x.status in ('draft', 'sent')
      ),
      'kept', (
        select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'total_cents', x.total_cents, 'status', x.status) order by x.id), '[]'::jsonb)
        from public.commitment_change_orders x
        join public.change_orders co on co.id = x.prime_change_order_id and co.project_id = c.project_id
        where x.org_id = p_org_id and x.status = 'approved'
      )
    ),
    'start_package', (
      select jsonb_build_object('id', s.id, 'status', s.status,
               'action', case when s.status in ('open', 'ready') then 'returns_to_open' else 'keeps_building' end)
      from public.start_packages s
      where s.org_id = p_org_id and s.project_id = c.project_id and s.status <> 'cancelled'
      order by s.created_at desc limit 1
    ),
    'selections', (
      select jsonb_build_object(
        'unlock', count(*) filter (where ps.locked_at is not null and ps.status in ('pending', 'selected', 'confirmed')),
        'keep_locked', count(*) filter (where ps.locked_at is not null and ps.status in ('ordered', 'received')))
      from public.project_selections ps where ps.org_id = p_org_id and ps.project_id = c.project_id
    ),
    'incentives', jsonb_array_length(coalesce(c.snapshot->'purchase_agreement'->'incentive_ids', '[]'::jsonb)),
    'portal_tokens', (
      select count(*) from public.portal_access_tokens t
      where t.org_id = p_org_id and t.project_id = c.project_id and t.portal_type = 'client' and t.revoked_at is null
    )
  );
  return plan || jsonb_build_object('hash', encode(sha256(convert_to(plan::text, 'UTF8')), 'hex'));
end;
$$;
revoke all on function public.preview_purchase_agreement_cancellation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.preview_purchase_agreement_cancellation(uuid, uuid) to service_role;

-- Cancel a sale in one transaction: the agreement is voided, its open signing
-- envelopes and unsigned change orders with them, unexecuted buyer variance
-- orders are voided, an unreleased start goes back to open for the Starts desk,
-- only undecided selections unlock (ordered and received ones stay with the
-- house), the closing is cancelled, the reservation released, the lead
-- reopened and the buyer detached. Signed amendments stay as the record. Money
-- moves afterwards, keyed to the receipt this writes.
create or replace function public.void_purchase_agreement_atomic(
  p_org_id uuid, p_contract_id uuid, p_actor_id uuid, p_reason text,
  p_deposit_disposition text, p_forfeit_cents bigint, p_expected_plan_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.contracts;
  plan jsonb;
  available bigint;
  disposition text;
  forfeit bigint := 0;
  refund bigint := 0;
  v_reservation_id uuid;
  envelope jsonb;
  pending_ids uuid[];
  receipt public.purchase_agreement_cancellations;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if p_actor_id is null or not exists (select 1 from public.app_users where id = p_actor_id) then
    raise exception 'A sale is cancelled by a person' using errcode = '22023';
  end if;
  if (select auth.uid()) is not null and (select auth.uid()) <> p_actor_id then
    raise exception 'Cancellation actor mismatch' using errcode = '42501';
  end if;
  if char_length(v_reason) < 3 then raise exception 'A cancellation reason is required'; end if;
  if p_deposit_disposition not in ('refund', 'forfeit', 'split') then raise exception 'Unknown deposit disposition'; end if;

  select * into c from public.contracts
   where org_id = p_org_id and id = p_contract_id and contract_type = 'purchase_agreement' for update;
  if not found or c.status not in ('draft', 'active') then raise exception 'Active purchase agreement not found'; end if;
  plan := public.preview_purchase_agreement_cancellation(p_org_id, p_contract_id);
  if plan->>'blocked' is not null then raise exception '%', plan->>'blocked'; end if;
  if plan->>'hash' is distinct from p_expected_plan_hash then
    raise exception 'The sale changed since you reviewed the cancellation. Review it again.' using detail = 'AGREEMENT_CANCELLATION_CHANGED';
  end if;

  available := (plan->'deposit'->>'available_cents')::bigint;
  if available = 0 then
    disposition := 'none';
  elsif p_deposit_disposition = 'refund' then
    disposition := 'refund'; refund := available;
  elsif p_deposit_disposition = 'forfeit' then
    disposition := 'forfeit'; forfeit := available;
  else
    if p_forfeit_cents is null or p_forfeit_cents <= 0 or p_forfeit_cents >= available then
      raise exception 'A split keeps part of the deposit and refunds the rest: enter an amount between $0 and the deposit';
    end if;
    disposition := 'split'; forfeit := p_forfeit_cents; refund := available - p_forfeit_cents;
  end if;

  update public.contracts set status = 'void' where id = c.id;

  for envelope in select value from jsonb_array_elements(plan->'envelopes') loop
    perform public.cancel_esign_envelope(p_org_id, (envelope->>'id')::uuid, 'Purchase agreement cancelled: ' || v_reason, null, p_actor_id);
  end loop;

  select coalesce(array_agg((x->>'id')::uuid), '{}') into pending_ids from jsonb_array_elements(plan->'pending_change_orders') x;
  update public.change_orders
     set status = 'cancelled', lifecycle = 'void',
         metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('voided_at', now(), 'voided_by', p_actor_id,
           'void_reason', 'Purchase agreement cancelled: ' || v_reason)
   where org_id = p_org_id and id = any (pending_ids);
  update public.commitment_change_orders
     set status = 'voided',
         metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('voided_at', now(), 'voided_by', p_actor_id,
           'void_reason', 'Purchase agreement cancelled: ' || v_reason)
   where org_id = p_org_id and prime_change_order_id = any (pending_ids) and status in ('draft', 'sent');

  update public.start_packages
     set status = 'open',
         metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sale_cancelled',
           jsonb_build_object('contract_id', c.id, 'at', now(), 'reason', v_reason, 'previous_status', status))
   where org_id = p_org_id and project_id = c.project_id and status in ('open', 'ready');

  update public.project_selections set locked_at = null
   where org_id = p_org_id and project_id = c.project_id and locked_at is not null
     and status in ('pending', 'selected', 'confirmed');

  update public.closings set status = 'cancelled', cancel_reason = v_reason
   where org_id = p_org_id and project_id = c.project_id and status not in ('closed', 'cancelled');

  v_reservation_id := (plan->'reservation'->>'id')::uuid;
  if v_reservation_id is not null then
    perform public.release_lot_reservation(p_org_id, p_actor_id, v_reservation_id, v_reason,
      case when disposition in ('refund', 'forfeit') then disposition end);
    update public.prospects set status = 'qualified', won_at = null, updated_at = now()
     where org_id = p_org_id and id = (plan->'reservation'->>'prospect_id')::uuid and status = 'won';
  end if;
  update public.projects set client_id = null where org_id = p_org_id and id = c.project_id and client_id is not null;

  insert into public.purchase_agreement_cancellations (org_id, project_id, contract_id, reservation_id, actor_id, reason,
    deposit_disposition, forfeit_cents, refund_cents, plan, plan_hash, outcomes, settlement_status)
  values (p_org_id, c.project_id, c.id, v_reservation_id, p_actor_id, v_reason, disposition, forfeit, refund,
    plan - 'hash', plan->>'hash',
    jsonb_build_object('voided', true, 'envelopes_voided', jsonb_array_length(plan->'envelopes'),
      'change_orders_voided', cardinality(pending_ids)),
    'pending')
  returning * into receipt;
  return jsonb_build_object('cancellation', to_jsonb(receipt), 'before', jsonb_build_object('status', c.status));
end;
$$;
revoke all on function public.void_purchase_agreement_atomic(uuid, uuid, uuid, text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.void_purchase_agreement_atomic(uuid, uuid, uuid, text, text, bigint, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. RBAC. Agreement and addenda text is legal content: owners, admins and
-- office admins manage it; everyone with sales.read sees what applies.
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('agreement_template.manage', 'Upload, publish and withdraw purchase agreement and addendum templates')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'agreement_template.manage'
from public.roles r
where r.key in ('org_owner', 'org_admin', 'org_office_admin')
on conflict (role_id, permission_key) do nothing;
