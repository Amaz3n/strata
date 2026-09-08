begin;

select plan(18);

select has_column('public', 'disbursements', 'submission_attempts', 'disbursements tracks submission attempts');
select has_column('public', 'disbursements', 'last_submission_error', 'disbursements stores the last submission error');
select has_column('public', 'disbursements', 'next_submission_at', 'disbursements schedules submission recovery');
select has_column('public', 'disbursements', 'transfer_claimed_at', 'disbursements stores durable transfer claim time');
select has_column('public', 'disbursements', 'transfer_claim_token', 'disbursements stores the transfer claim token');
select has_column('public', 'disbursements', 'provider_transfer_idempotency_key', 'disbursements stores the provider transfer idempotency key');

select has_function('public', 'claim_matured_vendor_transfers', array['integer']);
select has_function('public', 'list_payment_submission_recovery_candidates', array['integer']);
select has_function('public', 'release_failed_payment_run_item_atomic', array['uuid','uuid','text','timestamp with time zone']);
select has_function('public', 'complete_post_transfer_return_recovery_atomic', array['uuid','uuid','text','timestamp with time zone']);

select ok(
  (select pg_get_constraintdef(oid) like '%transfer_claimed%returned_after_transfer%'
   from pg_constraint where conrelid = 'public.disbursements'::regclass and conname = 'disbursements_status_check'),
  'the database state machine includes both Phase B states'
);
select ok(
  pg_get_functiondef('public.claim_matured_vendor_transfers(integer)'::regprocedure) like '%update public.disbursements d set%status = ''transfer_claimed''%',
  'the transfer claim writes durable state rather than returning a transaction-scoped lock'
);
select ok(
  pg_get_functiondef('public.claim_matured_vendor_transfers(integer)'::regprocedure) like '%interval ''15 minutes''%',
  'abandoned transfer claims become reclaimable after fifteen minutes'
);
select ok(
  pg_get_functiondef('public.list_payment_submission_recovery_candidates(integer)'::regprocedure) like '%submission_attempts < 5%next_submission_at <= now()%',
  'submission recovery is selected by a due timestamp and a hard attempt ceiling'
);
select ok(
  pg_get_functiondef('public.release_failed_payment_run_item_atomic(uuid,uuid,text,timestamp with time zone)'::regprocedure) like '%submission-reversal%',
  'definitive failure reverses the submission ledger inside the release RPC'
);
select ok(
  not has_function_privilege('anon', 'public.claim_matured_vendor_transfers(integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.claim_matured_vendor_transfers(integer)', 'execute'),
  'browser roles cannot claim vendor transfers'
);
select ok(
  not has_function_privilege('anon', 'public.release_failed_payment_run_item_atomic(uuid,uuid,text,timestamp with time zone)', 'execute')
  and not has_function_privilege('authenticated', 'public.release_failed_payment_run_item_atomic(uuid,uuid,text,timestamp with time zone)', 'execute'),
  'browser roles cannot release failed payment items'
);
select ok(
  pg_get_functiondef('public.record_ap_payment_atomic(uuid,uuid,text,text,text,text,text,timestamp with time zone)'::regprocedure) like '%returned_after_transfer%',
  'a payout that wins the return race can still record the AP payment'
);

select * from finish();
rollback;
