begin;

select plan(23);

select has_column('public','accounting_sync_records','status_reason','blocked accounting sync intent keeps its reason');
select has_column('public','accounting_sync_records','last_attempt_id','current sync state links to the attempt trace');
select has_column('public','accounting_sync_records','updated_at','pending age has a durable clock');
select is(
  (select is_nullable from information_schema.columns where table_schema='public' and table_name='accounting_sync_records' and column_name='connection_id'),
  'YES',
  'a no-target intent can exist without inventing a connection'
);
select is(
  (select is_nullable from information_schema.columns where table_schema='public' and table_name='accounting_sync_records' and column_name='provider'),
  'YES',
  'a no-target intent can exist without inventing a provider'
);
select has_function(
  'public',
  'enqueue_accounting_sync_atomic',
  array['uuid','uuid','text','text','uuid','text','text','text','text','jsonb','text']
);
select ok(
  not has_function_privilege('anon','public.enqueue_accounting_sync_atomic(uuid,uuid,text,text,uuid,text,text,text,text,jsonb,text)','execute')
    and not has_function_privilege('authenticated','public.enqueue_accounting_sync_atomic(uuid,uuid,text,text,uuid,text,text,text,text,jsonb,text)','execute'),
  'browser roles cannot manufacture sync intent or accounting jobs'
);
select ok(
  exists(
    select 1
    from pg_constraint
    where conrelid = 'public.accounting_sync_records'::regclass
      and contype = 'f'
      and pg_get_constraintdef(oid) like '%last_attempt_id%accounting_sync_attempts%'
  ),
  'the current state attempt link is an enforced foreign key'
);
select ok(
  exists(
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'accounting_sync_records'
      and indexname = 'accounting_sync_records_last_attempt_idx'
  ),
  'the current state attempt foreign key has a covering index'
);

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data)
values('17000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phaseg@example.test','',now(),now(),now(),'{}','{}');
insert into public.app_users(id,email,full_name)
values('17000000-0000-0000-0000-000000000001','phaseg@example.test','Phase G Bookkeeper');
insert into public.orgs(id,name,slug,created_by)
values('27000000-0000-0000-0000-000000000001','Phase G Test','phase-g-test','17000000-0000-0000-0000-000000000001');
insert into public.accounting_connections(
  id,org_id,provider,label,external_account_id,status,connected_by
) values(
  '37000000-0000-0000-0000-000000000001','27000000-0000-0000-0000-000000000001','qbo','Phase G Books','phase-g-realm','active','17000000-0000-0000-0000-000000000001'
);

select lives_ok(
  $$select * from public.enqueue_accounting_sync_atomic(
    '27000000-0000-0000-0000-000000000001',
    '37000000-0000-0000-0000-000000000001',
    'qbo','bill','47000000-0000-0000-0000-000000000001',
    'pending',null,null,'accounting_push_vendor_bill',
    '{"bill_id":"47000000-0000-0000-0000-000000000001"}'::jsonb,
    'accounting_push_vendor_bill:bill_id:47000000-0000-0000-0000-000000000001'
  )$$,
  'queueing commits the sync record and outbox job together'
);
select is(
  (select status from public.accounting_sync_records where entity_id='47000000-0000-0000-0000-000000000001'),
  'pending',
  'queued intent is visibly pending'
);
select is(
  (select count(*)::integer from public.outbox where dedupe_key='accounting_push_vendor_bill:bill_id:47000000-0000-0000-0000-000000000001'),
  1,
  'queued intent has exactly one outbox job'
);

select lives_ok(
  $$select * from public.enqueue_accounting_sync_atomic(
    '27000000-0000-0000-0000-000000000001',
    '37000000-0000-0000-0000-000000000001',
    'qbo','bill','47000000-0000-0000-0000-000000000001',
    'pending',null,null,'accounting_push_vendor_bill',
    '{"bill_id":"47000000-0000-0000-0000-000000000001"}'::jsonb,
    'accounting_push_vendor_bill:bill_id:47000000-0000-0000-0000-000000000001'
  )$$,
  'a repeated enqueue is a successful deduplicated decision'
);
select is(
  (select count(*)::integer from public.outbox where dedupe_key='accounting_push_vendor_bill:bill_id:47000000-0000-0000-0000-000000000001'),
  1,
  'repeated enqueue cannot create a second pending job'
);

update public.accounting_sync_records
set external_id='qbo-bill-470', status='synced'
where entity_id='47000000-0000-0000-0000-000000000001';
select lives_ok(
  $$select * from public.enqueue_accounting_sync_atomic(
    '27000000-0000-0000-0000-000000000001',
    '37000000-0000-0000-0000-000000000001',
    'qbo','bill','47000000-0000-0000-0000-000000000001',
    'needs_review','disabled','Automatic sync is disabled.',null,null,null
  )$$,
  'a blocked re-enqueue remains durable'
);
select is(
  (select status_reason from public.accounting_sync_records where entity_id='47000000-0000-0000-0000-000000000001'),
  'disabled',
  'blocked state names the actionable reason'
);
select is(
  (select external_id from public.accounting_sync_records where entity_id='47000000-0000-0000-0000-000000000001'),
  'qbo-bill-470',
  'changing sync state never erases external identity'
);

select lives_ok(
  $$select * from public.enqueue_accounting_sync_atomic(
    '27000000-0000-0000-0000-000000000001',null,null,
    'bill_payment','57000000-0000-0000-0000-000000000001',
    'needs_review','no_target','No accounting target.',null,null,null
  )$$,
  'no-target bill payment still leaves a durable needs-review row'
);
select ok(
  exists(
    select 1 from public.accounting_sync_records
    where entity_id='57000000-0000-0000-0000-000000000001'
      and connection_id is null
      and provider is null
      and status='needs_review'
      and status_reason='no_target'
  ),
  'no-target state is represented directly instead of being dropped'
);
select lives_ok(
  $$select * from public.enqueue_accounting_sync_atomic(
    '27000000-0000-0000-0000-000000000001',
    '37000000-0000-0000-0000-000000000001',
    'qbo','bill_payment','57000000-0000-0000-0000-000000000001',
    'pending',null,null,'accounting_push_bill_payment',
    '{"payment_id":"57000000-0000-0000-0000-000000000001"}'::jsonb,
    'accounting_push_bill_payment:payment_id:57000000-0000-0000-0000-000000000001'
  )$$,
  'mapping a target promotes the formerly unmapped intent into queued work'
);
select ok(
  (select count(*) = 1 and bool_and(connection_id = '37000000-0000-0000-0000-000000000001'::uuid)
   from public.accounting_sync_records where entity_id='57000000-0000-0000-0000-000000000001'),
  'the obsolete no-target placeholder cannot survive beside connected state'
);

select throws_ok(
  $$select * from public.enqueue_accounting_sync_atomic(
    '27000000-0000-0000-0000-000000000001',
    '37000000-0000-0000-0000-000000000001',
    'qbo','bill','67000000-0000-0000-0000-000000000001',
    'pending',null,null,'not_an_accounting_job','{}'::jsonb,'phase-g-invalid'
  )$$,
  'P0001',
  'Queued accounting sync requires a connection, provider, job type, payload, and dedupe key',
  'an invalid job cannot commit half of an enqueue decision'
);
select is(
  (select count(*)::integer from public.accounting_sync_records where entity_id='67000000-0000-0000-0000-000000000001'),
  0,
  'failed atomic enqueue leaves no orphan sync record'
);

select * from finish();
rollback;
