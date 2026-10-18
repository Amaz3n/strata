alter table public.esign_reminder_deliveries add column if not exists delivery_key text;
create unique index esign_reminder_delivery_key_idx on public.esign_reminder_deliveries(org_id,delivery_key) where delivery_key is not null;
alter table public.document_signing_requests
 add column if not exists delivery_status text,
 add column if not exists delivery_error text,
 add column if not exists provider_email_id text,
 add column if not exists delivery_updated_at timestamptz;
-- Correcting the recipient rotates invitation credentials. Delivery evidence
-- for the previous invitation remains in its journal, not on the new invite.
create function public.reset_esign_delivery_on_token_rotation()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if new.token_hash is distinct from old.token_hash then
   new.provider_email_id := null;
   new.delivery_status := null;
   new.delivery_error := null;
   new.delivery_updated_at := null;
 end if;
 return new;
end $$;
create trigger esign_delivery_token_rotation before update of token_hash on public.document_signing_requests
for each row execute function public.reset_esign_delivery_on_token_rotation();
revoke all on function public.reset_esign_delivery_on_token_rotation() from public,anon,authenticated;
grant execute on function public.reset_esign_delivery_on_token_rotation() to service_role;
create table public.esign_delivery_messages (
 provider_email_id text primary key, org_id uuid not null references public.orgs(id),
 signing_request_id uuid not null references public.document_signing_requests(id),
 kind text not null check(kind in ('invitation','reminder')),
 accepted_at timestamptz not null default now()
);
create table public.esign_delivery_events (
 event_id text primary key, provider_email_id text not null, status text not null,
 occurred_at timestamptz not null, error_message text, received_at timestamptz not null default now()
);
create index esign_delivery_events_provider_idx on public.esign_delivery_events(provider_email_id,occurred_at desc);
alter table public.esign_delivery_messages enable row level security;
alter table public.esign_delivery_events enable row level security;
revoke all on public.esign_delivery_messages,public.esign_delivery_events from anon,authenticated;
grant all on public.esign_delivery_messages,public.esign_delivery_events to service_role;

create function public.record_esign_email_accepted(p_org_id uuid,p_request_id uuid,p_provider_id text,p_kind text,p_expected_token_hash text)
returns void language plpgsql security invoker set search_path='' as $$
declare m public.esign_delivery_messages; e public.esign_delivery_events;
begin
 if not exists(select 1 from public.document_signing_requests where id=p_request_id and org_id=p_org_id) then raise exception 'Signing request not found'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_provider_id,0));
 insert into public.esign_delivery_messages(provider_email_id,org_id,signing_request_id,kind)
 values(p_provider_id,p_org_id,p_request_id,p_kind) on conflict(provider_email_id) do nothing;
 select * into m from public.esign_delivery_messages where provider_email_id=p_provider_id;
 if m.org_id<>p_org_id or m.signing_request_id<>p_request_id then raise exception 'Provider message already assigned'; end if;
 select * into e from public.esign_delivery_events where provider_email_id=p_provider_id order by occurred_at desc,received_at desc limit 1;
 update public.document_signing_requests set provider_email_id=p_provider_id,
 delivery_status=coalesce(e.status,'accepted'),delivery_error=e.error_message,delivery_updated_at=coalesce(e.occurred_at,m.accepted_at)
 where id=p_request_id and org_id=p_org_id and token_hash=p_expected_token_hash and (provider_email_id is null or provider_email_id=p_provider_id or delivery_updated_at<=m.accepted_at);
end $$;
create function public.record_esign_delivery_event(p_event_id text,p_provider_id text,p_status text,p_occurred_at timestamptz,p_error text)
returns void language plpgsql security invoker set search_path='' as $$
declare m public.esign_delivery_messages; e public.esign_delivery_events;
begin
 if p_status not in ('sent','delivered','delayed','bounced','complained','failed') then raise exception 'Unsupported delivery event'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_provider_id,0));
 insert into public.esign_delivery_events(event_id,provider_email_id,status,occurred_at,error_message)
 values(p_event_id,p_provider_id,p_status,p_occurred_at,left(p_error,500)) on conflict(event_id) do nothing;
 select * into m from public.esign_delivery_messages where provider_email_id=p_provider_id;
 if found then
   select * into e from public.esign_delivery_events where provider_email_id=p_provider_id order by occurred_at desc,received_at desc limit 1;
   update public.document_signing_requests set delivery_status=e.status,delivery_error=e.error_message,delivery_updated_at=e.occurred_at
   where id=m.signing_request_id and org_id=m.org_id and provider_email_id=p_provider_id;
 end if;
end $$;
revoke all on function public.record_esign_email_accepted(uuid,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.record_esign_delivery_event(text,text,text,timestamptz,text) from public,anon,authenticated;
grant execute on function public.record_esign_email_accepted(uuid,uuid,text,text,text) to service_role;
grant execute on function public.record_esign_delivery_event(text,text,text,timestamptz,text) to service_role;
