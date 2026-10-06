-- Install before deploying RPC-based intake. The previous service upsert intake
-- remains compatible with the default empty metadata collection. Never restore
-- application mutation grants on rollback. No financial facts are changed.
set lock_timeout = '5s';
set statement_timeout = '120s';

alter table public.qbo_webhook_events
  add column if not exists provider_event_ids text[] not null default '{}'::text[];

revoke all privileges on public.qbo_webhook_events from public,anon,authenticated;
do $$
declare columns_sql text;
begin
  select string_agg(quote_ident(attname),',') into columns_sql from pg_attribute
    where attrelid='public.qbo_webhook_events'::regclass and attnum>0 and not attisdropped;
  execute format('revoke select (%s), insert (%s), update (%s), references (%s) on public.qbo_webhook_events from public,anon,authenticated',columns_sql,columns_sql,columns_sql,columns_sql);
end $$;

-- Each call is one atomic bounded batch. INSERT waits on unique conflicts;
-- the subsequent UPDATE uses a new READ COMMITTED snapshot and merges against
-- the current locked row. No application read/replace or MVCC system columns.
create or replace function public.intake_qbo_webhook_events(p_events jsonb,p_payload_hash text)
returns text[] language plpgsql security definer set search_path=public,pg_temp as $$
declare event jsonb; key text; field text; inserted_key text;
  newly_inserted text[] := '{}'; ids text[]; updated_key text;
begin
  if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events)>200
    or p_payload_hash is null or p_payload_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid webhook intake batch';
  end if;
  -- Validate the whole batch before issuing any persistence statement.
  for event in select value from jsonb_array_elements(p_events) loop
    if jsonb_typeof(event) is distinct from 'object' then raise exception 'Invalid webhook entity'; end if;
    if exists(select 1 from jsonb_object_keys(event) k where k not in ('event_id','realm_id','entity_name','entity_qbo_id','operation','last_updated','provider_event_id')) then raise exception 'Invalid webhook entity fields'; end if;
    foreach field in array array['event_id','realm_id','entity_name','entity_qbo_id','operation','last_updated'] loop
      if jsonb_typeof(event->field) is distinct from 'string' or event->>field='' then
        raise exception 'Invalid webhook entity field';
      end if;
    end loop;
    foreach field in array array['realm_id','entity_name','entity_qbo_id','operation'] loop
      if event->>field ~ '[:[:space:][:cntrl:]]' then raise exception 'Invalid webhook identity'; end if;
    end loop;
    if event->>'operation' not in ('Update','Create','Delete','Merge','Void','Emailed')
      or event->>'entity_name' not in ('Account','Bill','BillPayment','Budget','Class','CreditMemo','Currency','Customer','Department','Deposit','Employee','Estimate','Invoice','Item','JournalCode','JournalEntry','Payment','PaymentMethod','Preferences','Purchase','PurchaseOrder','RefundReceipt','SalesReceipt','TaxAgency','Term','TimeActivity','Transfer','Vendor','VendorCredit')
      or event->>'last_updated' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3,}Z$'
      or event->>'event_id' <> concat(event->>'realm_id',':',event->>'entity_name',':',event->>'entity_qbo_id',':',event->>'operation',':',event->>'last_updated') then
      raise exception 'Invalid canonical webhook entity';
    end if;
    perform (event->>'last_updated')::timestamptz;
    if event ? 'provider_event_id' and (jsonb_typeof(event->'provider_event_id') is distinct from 'string'
      or event->>'provider_event_id'='' or event->>'provider_event_id' ~ '[:[:space:][:cntrl:]]') then
      raise exception 'Invalid provider event identity';
    end if;
  end loop;
  -- Consistent ordering reduces lock-order deadlocks across overlapping batches.
  for event in select value from jsonb_array_elements(p_events) order by value->>'event_id',value->>'provider_event_id' loop
    key:=event->>'event_id';
    ids:=case when event ? 'provider_event_id' then array[event->>'provider_event_id'] else '{}'::text[] end;
    inserted_key:=null;
    -- Preserve the previous JavaScript millisecond projection for queue time;
    -- semantic IDs retain the full canonical precision supplied by the parser.
    insert into public.qbo_webhook_events(event_id,payload_hash,realm_id,entity_name,entity_qbo_id,operation,last_updated,provider_event_ids)
      values(key,p_payload_hash,event->>'realm_id',event->>'entity_name',event->>'entity_qbo_id',event->>'operation',(regexp_replace(event->>'last_updated','(\.[0-9]{3})[0-9]+Z$','\1Z'))::timestamptz,ids)
      on conflict(event_id) do nothing returning event_id into inserted_key;
    if inserted_key is not null then
      newly_inserted:=array_append(newly_inserted,inserted_key);
    else
      updated_key:=null;
      update public.qbo_webhook_events q set provider_event_ids=(
        select coalesce(array_agg(distinct id order by id),'{}'::text[]) from unnest(q.provider_event_ids||ids) id
      ) where q.event_id=key and q.realm_id=event->>'realm_id' and q.entity_name=event->>'entity_name'
        and q.entity_qbo_id=event->>'entity_qbo_id' and q.operation=event->>'operation'
        and not (q.provider_event_ids @> ids)
        returning q.event_id into updated_key;
      if updated_key is null and not exists(
        select 1 from public.qbo_webhook_events q where q.event_id=key and q.realm_id=event->>'realm_id'
          and q.entity_name=event->>'entity_name' and q.entity_qbo_id=event->>'entity_qbo_id'
          and q.operation=event->>'operation' and q.provider_event_ids @> ids
      ) then raise exception 'Webhook identity conflict or missing durable event'; end if;
    end if;
  end loop;
  return newly_inserted;
end $$;
revoke all on function public.intake_qbo_webhook_events(jsonb,text) from public,anon,authenticated;
grant execute on function public.intake_qbo_webhook_events(jsonb,text) to service_role;
