-- Import rows and their neutral identity commit together. Child writes resume by
-- stable source order while the fenced import claim remains owned by this run.
alter table public.project_expense_lines add column if not exists accounting_coding jsonb not null default '{}'::jsonb;
update public.project_expense_lines l set accounting_coding = l.accounting_coding || jsonb_build_object('expense_account',
  jsonb_build_object('id', to_jsonb(l)->>'qbo_expense_account_id', 'name', to_jsonb(l)->>'qbo_expense_account_name'))
where nullif(to_jsonb(l)->>'qbo_expense_account_id','') is not null
  and (l.accounting_coding->'expense_account' is null or l.accounting_coding->'expense_account' = 'null'::jsonb);

-- Retain the external entity namespace before retiring direct business columns.
update public.accounting_sync_records s set metadata=coalesce(s.metadata,'{}'::jsonb) || jsonb_build_object('external_entity_type',
 case when s.metadata->>'source' in ('journal_entry','client_deposit') then 'JournalEntry'
 when s.entity_type='project_expense' then coalesce((select case to_jsonb(e)->>'qbo_transaction_type' when 'bill' then 'Bill' when 'journal_entry' then 'JournalEntry' else 'Purchase' end from project_expenses e where e.org_id=s.org_id and e.id=s.entity_id),'Purchase')
 else case s.entity_type when 'invoice' then 'Invoice' when 'bill' then 'Bill' when 'vendor_credit' then 'VendorCredit' when 'payment' then 'Payment' when 'bill_payment' then 'BillPayment' when 'journal_entry' then 'JournalEntry' end end)
where s.provider='qbo' and s.entity_type in ('invoice','project_expense','bill','vendor_credit','payment','bill_payment','journal_entry')
  and coalesce(s.metadata->>'external_entity_type','')='';

create or replace function public.accounting_persist_import_row(
  p_org_id uuid, p_connection_id uuid, p_claim_token uuid, p_table text,
  p_entity_type text, p_external_type text, p_external_id text, p_line_id text, p_values jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_provider text;
  v_columns text;
  v_values text;
  v_payload jsonb;
  v_metadata jsonb;
begin
  if not ((p_table = 'invoices' and p_entity_type = 'invoice' and p_external_type in ('Invoice','JournalEntry'))
    or (p_table = 'project_expenses' and p_entity_type = 'project_expense' and p_external_type in ('Purchase','JournalEntry'))
    or (p_table = 'vendor_bills' and ((p_entity_type='bill' and p_external_type='Bill') or (p_entity_type='vendor_credit' and p_external_type='VendorCredit')))
    or (p_table = 'payments' and ((p_entity_type='payment' and p_external_type in ('Payment','JournalEntry')) or (p_entity_type='bill_payment' and p_external_type='BillPayment')))) then
    raise exception 'Unsupported import entity';
  end if;
  select provider into v_provider from accounting_import_claims
  where org_id = p_org_id and connection_id = p_connection_id and claim_token = p_claim_token
    and external_id = p_external_id and (case external_entity_type when 'invoice' then 'Invoice' when 'expense' then 'Purchase' when 'expense_credit' then 'Purchase' when 'bill' then 'Bill' when 'vendor_credit' then 'VendorCredit' when 'payment' then 'Payment' when 'bill_payment' then 'BillPayment' when 'journal_entry' then 'JournalEntry' when 'client_deposit' then 'JournalEntry' else external_entity_type end) = p_external_type and status = 'processing' and lease_expires_at > now()
  for update;
  if not found then raise exception 'Import claim is no longer owned'; end if;
  if p_values->>'org_id' is distinct from p_org_id::text then raise exception 'Import organization mismatch'; end if;
  if p_values->>'project_id' is not null and not exists(select 1 from projects where id = (p_values->>'project_id')::uuid and org_id = p_org_id) then
    raise exception 'Import project organization mismatch';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_connection_id::text || ':' || p_external_type || ':' || p_external_id, 0));
  select s.entity_id into v_id from accounting_sync_records s
  where s.org_id = p_org_id and s.connection_id = p_connection_id and s.entity_type = p_entity_type and s.external_id = p_external_id
    and coalesce(s.metadata->>'external_entity_type', case when s.metadata->>'source' in ('journal_entry','client_deposit') then 'JournalEntry' else case s.entity_type when 'invoice' then 'Invoice' when 'project_expense' then 'Purchase' when 'bill' then 'Bill' when 'vendor_credit' then 'VendorCredit' when 'payment' then 'Payment' when 'bill_payment' then 'BillPayment' end end) = p_external_type
    and coalesce(s.metadata->>'import_line_id', s.metadata->>'qbo_purchase_line_id', s.metadata->>'qbo_je_line_id', 'document') = p_line_id;
  if found then
    execute format('select id from public.%I where org_id = $1 and id = $2', p_table) into v_id using p_org_id, v_id;
    if v_id is null then raise exception 'Import mapping points to missing document'; end if;
    return v_id;
  end if;
  -- Existing payment identifiers are adopted only within this proven mapping
  -- scope. The migration below changes keys for unambiguous old mappings.
  if p_table = 'payments' then
    select p.id into v_id from payments p where p.org_id = p_org_id and p.provider = v_provider
      and p.provider_payment_id = p_values->>'provider_payment_id';
  end if;
  if v_id is null then
    v_id := gen_random_uuid();
    v_payload := p_values || jsonb_build_object('id', v_id, 'org_id', p_org_id);
    select string_agg(format('%I', key), ','), string_agg(format('(jsonb_populate_record(null::public.%I, $1)).%I', p_table, key), ',')
      into v_columns, v_values from jsonb_object_keys(v_payload) key;
    execute format('insert into public.%I (%s) select %s', p_table, v_columns, v_values) using v_payload;
  end if;
  v_metadata := coalesce(p_values->'metadata', '{}'::jsonb) || jsonb_build_object(
    'external_entity_type', p_external_type, 'import_line_id', p_line_id, 'import_complete', false,
    'origin', 'qbo_import', 'ownership', 'inbound');
  insert into accounting_sync_records(org_id, connection_id, provider, entity_type, entity_id, external_id,
    status, sync_direction, pushable, metadata)
  values(p_org_id, p_connection_id, v_provider, p_entity_type, v_id, p_external_id, 'pending', 'inbound', false, v_metadata)
  on conflict (org_id,connection_id,entity_type,entity_id) do update set metadata=accounting_sync_records.metadata || excluded.metadata
  where accounting_sync_records.external_id=excluded.external_id;
  if not found then raise exception 'Existing import identity conflicts with selected remote record'; end if;
  return v_id;
end;
$$;
revoke all on function public.accounting_persist_import_row(uuid,uuid,uuid,text,text,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.accounting_persist_import_row(uuid,uuid,uuid,text,text,text,text,text,jsonb) to service_role;

create or replace function public.accounting_persist_import_children(
  p_org_id uuid, p_claim_token uuid, p_table text, p_rows jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_parent_key text;
  v_parent_table text;
  v_row jsonb;
  v_parent_id uuid;
  v_id uuid;
  v_existing uuid[];
  v_result jsonb := '[]'::jsonb;
  v_index integer := 0;
  v_columns text;
  v_values text;
  v_claim accounting_import_claims%rowtype;
  v_claim_external_type text;
  v_parent_types text[];
  v_valid boolean;
  v_hash text;
begin
  select * into v_claim from accounting_import_claims where org_id = p_org_id and claim_token = p_claim_token
    and status = 'processing' and lease_expires_at > now() for update;
  if not found then raise exception 'Import claim is no longer owned'; end if;
  v_claim_external_type := case v_claim.external_entity_type when 'invoice' then 'Invoice' when 'expense' then 'Purchase' when 'expense_credit' then 'Purchase' when 'bill' then 'Bill' when 'vendor_credit' then 'VendorCredit' when 'payment' then 'Payment' when 'bill_payment' then 'BillPayment' when 'journal_entry' then 'JournalEntry' when 'client_deposit' then 'JournalEntry' else v_claim.external_entity_type end;
  case p_table
    when 'invoice_lines' then v_parent_key := 'invoice_id'; v_parent_table := 'invoices'; v_parent_types := array['invoice'];
    when 'bill_lines' then v_parent_key := 'bill_id'; v_parent_table := 'vendor_bills'; v_parent_types := array['bill','vendor_credit'];
    when 'project_expense_lines' then v_parent_key := 'expense_id'; v_parent_table := 'project_expenses'; v_parent_types := array['project_expense'];
    else raise exception 'Unsupported import child table';
  end case;
  if jsonb_array_length(p_rows) = 0 then return v_result; end if;
  v_parent_id := (p_rows->0->>v_parent_key)::uuid;
  if not exists(select 1 from accounting_sync_records where org_id=p_org_id and connection_id=v_claim.connection_id
    and external_id=v_claim.external_id and entity_id=v_parent_id and entity_type=any(v_parent_types)
    and metadata->>'external_entity_type'=v_claim_external_type) then raise exception 'Import parent is outside claim'; end if;
  execute format('select exists(select 1 from public.%I where org_id=$1 and id=$2)',v_parent_table)
    into v_valid using p_org_id,v_parent_id;
  if not v_valid then raise exception 'Import parent table does not match claim'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_parent_id::text || ':import-lines', 0));
  -- Each parent line set is inserted in one transaction. A retry either sees
  -- all of it or none of it; no delete of posted document children is needed.
  execute format('select array_agg(id order by (metadata->>''accounting_import_ordinal'')::integer nulls last, id) from public.%I where org_id=$1 and %I=$2', p_table, v_parent_key)
    into v_existing using p_org_id, v_parent_id;
  if coalesce(cardinality(v_existing), 0) > 0 then
    if cardinality(v_existing) <> jsonb_array_length(p_rows) then raise exception 'Existing import lines differ; completeness review required'; end if;
    for v_row in select value from jsonb_array_elements(p_rows) loop
      if v_row->>'org_id' is distinct from p_org_id::text or v_row->>v_parent_key is distinct from v_parent_id::text then
        raise exception 'Import child scope mismatch';
      end if;
      v_hash := md5(v_row::text);
      execute format('select exists(select 1 from public.%I t where org_id=$1 and id=$2 and metadata->>''accounting_import_ordinal''=$3 and metadata->>''accounting_import_payload_hash''=$4 and to_jsonb(t) @> $5)',p_table)
        into v_valid using p_org_id,v_existing[v_index+1],v_index::text,v_hash,v_row;
      if not v_valid then raise exception 'Existing import line identity or content is unverifiable; review required'; end if;
      v_index := v_index + 1;
    end loop;
    if p_table = 'invoice_lines' then perform public.reconcile_accounting_invoice_opening_payment(p_org_id, v_parent_id); end if;
    return to_jsonb(v_existing);
  end if;
  for v_row in select value from jsonb_array_elements(p_rows) loop
    if v_row->>'org_id' is distinct from p_org_id::text or v_row->>v_parent_key is distinct from v_parent_id::text then
      raise exception 'Import child scope mismatch';
    end if;
    v_id := gen_random_uuid();
    v_hash := md5(v_row::text);
    v_row := v_row || jsonb_build_object('id', v_id, 'metadata', coalesce(v_row->'metadata','{}'::jsonb) || jsonb_build_object('accounting_import_ordinal', v_index, 'accounting_import_payload_hash', v_hash));
    select string_agg(format('%I', key), ','), string_agg(format('(jsonb_populate_record(null::public.%I, $1)).%I', p_table, key), ',')
      into v_columns, v_values from jsonb_object_keys(v_row) key;
    execute format('insert into public.%I (%s) select %s', p_table, v_columns, v_values) using v_row;
    v_result := v_result || jsonb_build_array(v_id);
    v_index := v_index + 1;
  end loop;
  if p_table = 'invoice_lines' then perform public.reconcile_accounting_invoice_opening_payment(p_org_id, v_parent_id); end if;
  return v_result;
end;
$$;
revoke all on function public.accounting_persist_import_children(uuid,uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.accounting_persist_import_children(uuid,uuid,text,jsonb) to service_role;

-- Adopt legacy payment keys only when one connection has a real mapping to the
-- cash row. Ambiguous or unmapped historical payments remain review blockers.
with ownership as (
  select s.org_id, s.entity_id, min(s.connection_id::text) as connection_id
  from accounting_sync_records s join payments p on p.id=s.entity_id and p.org_id=s.org_id
  where s.entity_type in ('payment','bill_payment') and s.provider='qbo'
  group by s.org_id, s.entity_id having count(distinct s.connection_id)=1
), changes as (
  select p.id, p.org_id, p.provider_payment_id as old_key,
    regexp_replace(p.provider_payment_id, '^(qbo_(?:payment|billpayment|deposit))_', '\1_' || o.connection_id || '_') as new_key
  from payments p join ownership o on o.entity_id=p.id and o.org_id=p.org_id
  where p.provider='qbo' and p.provider_payment_id ~ '^qbo_(payment|billpayment|deposit)_[0-9]+(_|$)'
)
update payments p set provider_payment_id=c.new_key,
  idempotency_key=case when p.idempotency_key='qbo-import:' || c.old_key then 'qbo-import:' || c.new_key else p.idempotency_key end,
  metadata=coalesce(p.metadata,'{}'::jsonb) || jsonb_build_object('accounting_previous_payment_key',c.old_key)
from changes c where p.id=c.id and p.org_id=c.org_id;

-- Adopting an existing local document serializes on the local identity across
-- all connections, so two simultaneous book choices cannot rehome it.
create or replace function public.accounting_adopt_import_identity(
 p_org_id uuid,p_connection_id uuid,p_claim_token uuid,p_entity_type text,p_entity_id uuid,p_external_id text
) returns boolean language plpgsql security definer set search_path=public as $$
declare v_table text; v_external_type text; v_valid boolean;
begin
 case p_entity_type
 when 'invoice' then v_table:='invoices'; v_external_type:='Invoice';
 when 'project_expense' then v_table:='project_expenses'; v_external_type:='Purchase';
 when 'bill' then v_table:='vendor_bills'; v_external_type:='Bill';
 else raise exception 'Unsupported import adoption entity'; end case;
 perform 1 from accounting_import_claims where org_id=p_org_id and connection_id=p_connection_id and claim_token=p_claim_token
  and external_id=p_external_id and status='processing' and lease_expires_at>now()
  and provider='qbo' and external_entity_type=case p_entity_type when 'project_expense' then 'expense' else p_entity_type end for update;
 if not found then raise exception 'Import claim is no longer owned'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || p_entity_type || ':' || p_entity_id::text,0));
 execute format('select exists(select 1 from public.%I where org_id=$1 and id=$2)',v_table) into v_valid using p_org_id,p_entity_id;
 if not v_valid then raise exception 'Import target is outside organization'; end if;
 if exists(select 1 from accounting_sync_records where org_id=p_org_id and entity_type=p_entity_type and entity_id=p_entity_id
  and nullif(external_id,'') is not null and (connection_id is distinct from p_connection_id or external_id is distinct from p_external_id)) then
  raise exception 'Local document already belongs to another external identity';
 end if;
 if exists(select 1 from accounting_sync_records where org_id=p_org_id and connection_id=p_connection_id and entity_type=p_entity_type
  and external_id=p_external_id and entity_id<>p_entity_id and coalesce(metadata->>'external_entity_type',v_external_type)=v_external_type) then
  raise exception 'External document already belongs to another local identity';
 end if;
 insert into accounting_sync_records(org_id,connection_id,provider,entity_type,entity_id,external_id,status,sync_direction,pushable,metadata,last_synced_at)
 values(p_org_id,p_connection_id,'qbo',p_entity_type,p_entity_id,p_external_id,'synced','inbound',false,
  jsonb_build_object('origin','qbo_import_link','ownership','inbound','external_entity_type',v_external_type,'import_complete',true),now())
 on conflict(org_id,connection_id,entity_type,entity_id) do update set external_id=excluded.external_id,status=excluded.status,
  sync_direction=excluded.sync_direction,pushable=false,metadata=accounting_sync_records.metadata || excluded.metadata,last_synced_at=now(),error_message=null;
 if p_entity_type='invoice' then perform public.reconcile_accounting_invoice_opening_payment(p_org_id,p_entity_id); end if;
 return true;
end;
$$;
revoke all on function public.accounting_adopt_import_identity(uuid,uuid,uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.accounting_adopt_import_identity(uuid,uuid,uuid,text,uuid,text) to service_role;
