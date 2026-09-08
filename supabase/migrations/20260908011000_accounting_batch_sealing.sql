create or replace function public.append_accounting_batch_line_atomic(
  p_org_id uuid,
  p_connection_id uuid,
  p_format text,
  p_project_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_direction text,
  p_amount_cents bigint,
  p_currency text,
  p_posted_at timestamptz,
  p_memo text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_batch public.accounting_batches%rowtype;
  v_line public.accounting_batch_lines%rowtype;
  v_existing public.accounting_batch_lines%rowtype;
begin
  if not exists(select 1 from accounting_connections where org_id=p_org_id and id=p_connection_id and provider='file' and status='active') then raise exception 'Active file accounting connection required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || p_connection_id::text, 0));
  select * into v_existing from public.accounting_batch_lines
  where org_id = p_org_id and connection_id = p_connection_id
    and entity_type = p_entity_type and entity_id = p_entity_id and direction = p_direction;
  if v_existing.id is not null then
    if v_existing.amount_cents is not distinct from p_amount_cents
      and v_existing.currency is not distinct from coalesce(p_currency,'usd')
      and v_existing.posted_at is not distinct from p_posted_at
      and v_existing.memo is not distinct from p_memo
      and v_existing.payload is not distinct from coalesce(p_payload,'{}'::jsonb)
      and v_existing.project_id is not distinct from p_project_id then
      return to_jsonb(v_existing) || jsonb_build_object('duplicate',true);
    end if;
    select * into v_batch from accounting_batches where id=v_existing.batch_id for update;
    if v_batch.status <> 'open' then
      raise exception 'This source revision was already exported; review an explicit correcting entry before exporting again';
    end if;
    update accounting_batch_lines set amount_cents=p_amount_cents,currency=coalesce(p_currency,'usd'),posted_at=p_posted_at,memo=p_memo,payload=coalesce(p_payload,'{}'::jsonb),project_id=p_project_id
      where id=v_existing.id returning * into v_line;
    update accounting_batches set total_cents=total_cents + (case when p_direction='reverse' then -1 else 1 end)*(p_amount_cents-v_existing.amount_cents) where id=v_existing.batch_id;
    return to_jsonb(v_line)||jsonb_build_object('duplicate',false,'revised',true);
  end if;

  -- Serialise open-batch creation for this connection.
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || p_connection_id::text, 0));

  select * into v_batch from public.accounting_batches
  where org_id = p_org_id and connection_id = p_connection_id and status = 'open'
  for update;

  if v_batch.id is null then
    insert into public.accounting_batches (org_id, connection_id, format)
    values (p_org_id, p_connection_id, p_format)
    returning * into v_batch;
  end if;

  insert into public.accounting_batch_lines (
    org_id, connection_id, batch_id, project_id, entity_type, entity_id,
    direction, amount_cents, currency, posted_at, memo, payload
  ) values (
    p_org_id, p_connection_id, v_batch.id, p_project_id, p_entity_type, p_entity_id,
    p_direction, p_amount_cents, coalesce(p_currency, 'usd'), p_posted_at, p_memo, coalesce(p_payload, '{}'::jsonb)
  ) returning * into v_line;

  update public.accounting_batches
  set line_count = line_count + 1,
      -- A reversal subtracts, so the batch total is what the import actually
      -- moves rather than a gross of unrelated signs.
      total_cents = total_cents + case when p_direction = 'reverse' then -p_amount_cents else p_amount_cents end
  where id = v_batch.id;

  return to_jsonb(v_line) || jsonb_build_object('duplicate', false, 'batch_id', v_batch.id);
end;
$$;

revoke all on function public.append_accounting_batch_line_atomic(uuid, uuid, text, uuid, text, uuid, text, bigint, text, timestamptz, text, jsonb) from public, anon, authenticated;
grant execute on function public.append_accounting_batch_line_atomic(uuid, uuid, text, uuid, text, uuid, text, bigint, text, timestamptz, text, jsonb) to service_role;

-- Seal under the same append lock, then read only immutable lines.
create function public.seal_accounting_batch(p_org_id uuid,p_batch_id uuid,p_actor_id uuid,p_max_lines integer default 20000)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_batch accounting_batches%rowtype; v_connection uuid; v_was_open boolean;
begin
  select connection_id into v_connection from accounting_batches where org_id=p_org_id and id=p_batch_id;
  if v_connection is null then raise exception 'Accounting batch not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':'||v_connection::text,0));
  select * into v_batch from accounting_batches where org_id=p_org_id and id=p_batch_id for update;
  if v_batch.status='void' then raise exception 'Accounting batch was voided'; end if;
  if v_batch.line_count>p_max_lines then raise exception 'Accounting batch exceeds export line limit'; end if;
  v_was_open:=v_batch.status='open';
  if v_was_open then
    update accounting_batches set status='exported',exported_at=now(),exported_by=p_actor_id where id=p_batch_id returning * into v_batch;
    update accounting_sync_records s set status='exported',status_reason='file_exported_unconfirmed'
      from accounting_batch_lines l where l.batch_id=p_batch_id and s.org_id=p_org_id and s.connection_id=v_connection and s.entity_id=l.entity_id and s.entity_type=l.entity_type;
  end if;
  return to_jsonb(v_batch)||jsonb_build_object('sealed_now',v_was_open);
end $$;
revoke all on function public.seal_accounting_batch(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.seal_accounting_batch(uuid,uuid,uuid,integer) to service_role;
