begin;

select plan(19);

-- Structure -----------------------------------------------------------------

select has_column('public','portal_access_tokens','purpose','payout invitations are their own kind of access record');
select has_function('public','assert_vendor_relationship_claim_live',array[]::text[]);
select has_function('public','assert_claim_withdrawal_closes_access',array[]::text[]);
select has_trigger('public','vendor_payment_relationships','vendor_payment_relationships_claim_live','a relationship cannot go active behind the invariant''s back');
select has_trigger('public','vendor_company_claims','vendor_company_claims_withdrawal_closes_access','a claim cannot be withdrawn behind the invariant''s back');
select ok(
  exists(select 1 from pg_indexes where schemaname='public' and indexname='portal_access_tokens_vendor_payout_idx'),
  'payout invitations are indexed by the (org, company, contact) they belong to'
);
select is((select column_default from information_schema.columns where table_schema='public' and table_name='portal_access_tokens' and column_name='purpose'),
  '''portal''::text',
  'existing access records stay ordinary portal access — a project link that was once reused as a payout link is not reclassified');
select throws_ok(
  $$insert into public.portal_access_tokens(token_hash,org_id,company_id,portal_type,purpose)
    values('phase-e-bad-purpose','00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000','sub','something_else')$$,
  '23514',
  null,
  'purpose is a closed set');

-- Fixture --------------------------------------------------------------------

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data)
values('13000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phasee-ap@example.test','',now(),now(),now(),'{}','{}');
insert into public.app_users(id,email,full_name) values('13000000-0000-0000-0000-000000000001','phasee-ap@example.test','Phase E Clerk');
insert into public.orgs(id,name,slug,created_by) values('23000000-0000-0000-0000-000000000001','Phase E Test','phase-e-test','13000000-0000-0000-0000-000000000001');
insert into public.memberships(org_id,user_id,role_id,status)
values('23000000-0000-0000-0000-000000000001','13000000-0000-0000-0000-000000000001',(select id from public.roles where key='org_admin'),'active');
insert into public.projects(id,org_id,name,created_by) values('33000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000001','Phase E Project','13000000-0000-0000-0000-000000000001');
insert into public.companies(id,org_id,name) values('43000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000001','Phase E Framing');
insert into public.vendor_entities(id,legal_name,status) values('53000000-0000-0000-0000-000000000001','Phase E Framing LLC','active');
insert into public.vendor_portal_identities(id,email,full_name,status) values('63000000-0000-0000-0000-000000000001','owner@phase-e.test','Phase E Owner','active');
insert into public.vendor_company_claims(id,org_id,company_id,vendor_entity_id,claimed_by_identity_id,status,verification_method,verified_at)
values('73000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000001','43000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','63000000-0000-0000-0000-000000000001','pending','portal_invitation',null);

-- Money cannot move against a claim that is not live -------------------------

select throws_ok(
  $$insert into public.vendor_payment_relationships(org_id,company_id,vendor_entity_id,vendor_company_claim_id,status)
    values('23000000-0000-0000-0000-000000000001','43000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','73000000-0000-0000-0000-000000000001','active')$$,
  '23514',
  null,
  'a relationship cannot be active while its claim is only pending');

update public.vendor_company_claims set status='verified', verified_at=now() where id='73000000-0000-0000-0000-000000000001';
select lives_ok(
  $$insert into public.vendor_payment_relationships(id,org_id,company_id,vendor_entity_id,vendor_company_claim_id,status)
    values('83000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000001','43000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','73000000-0000-0000-0000-000000000001','active')$$,
  'a verified claim lets the relationship go active');

select throws_ok(
  $$update public.vendor_company_claims set status='revoked', revoked_at=now() where id='73000000-0000-0000-0000-000000000001'$$,
  '23514',
  null,
  'a claim cannot be withdrawn out from under an active relationship');

update public.vendor_payment_relationships set status='revoked', revoked_at=now() where id='83000000-0000-0000-0000-000000000001';
select lives_ok(
  $$update public.vendor_company_claims set status='revoked', revoked_at=now() where id='73000000-0000-0000-0000-000000000001'$$,
  'withdrawing access in the right order — relationship first, then claim — is allowed');
select throws_ok(
  $$update public.vendor_payment_relationships set status='active' where id='83000000-0000-0000-0000-000000000001'$$,
  '23514',
  null,
  'money cannot be restored against a revoked claim without restoring the claim');

update public.vendor_company_claims set status='verified', verified_at=now(), revoked_at=null where id='73000000-0000-0000-0000-000000000001';
select lives_ok(
  $$update public.vendor_payment_relationships set status='active', revoked_at=null where id='83000000-0000-0000-0000-000000000001'$$,
  'restoring the claim first is what makes restore work without SQL');

-- A bill on the rail always names its vendor ---------------------------------
--
-- Already enforced before Phase E, by `enforce_payment_run_item_integrity`.
-- These pin it: the rule is load-bearing for remittance recipients, the payout
-- destination and the vendor-facing payment view, and nothing else states it.

insert into public.vendor_bills(id,org_id,project_id,company_id,bill_number,status,total_cents,currency,approved_at,approved_by) values
('93000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000001','33000000-0000-0000-0000-000000000001',null,'PHASE-E-ORPHAN','approved',10000,'usd',now(),'13000000-0000-0000-0000-000000000001'),
('93000000-0000-0000-0000-000000000002','23000000-0000-0000-0000-000000000001','33000000-0000-0000-0000-000000000001','43000000-0000-0000-0000-000000000001','PHASE-E-ATTRIBUTED','approved',10000,'usd',now(),'13000000-0000-0000-0000-000000000001');
insert into public.org_funding_sources(id,org_id,provider,provider_customer_id,provider_payment_method_id,mandate_status,verification_status,status,is_default,created_by)
values('a3000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000001','stripe','cus_phasee','pm_phasee','accepted','verified','active',true,'13000000-0000-0000-0000-000000000001');
insert into public.payment_runs(id,org_id,funding_source_id,status,currency,payment_count,vendor_amount_cents,total_debit_cents,approval_mode_snapshot,required_approvals,requested_by,control_snapshot,idempotency_key)
values('b3000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000001','a3000000-0000-0000-0000-000000000001','draft','usd',1,10000,10000,'sole',1,'13000000-0000-0000-0000-000000000001','{}','phase-e-run');

select throws_ok(
  $$insert into public.payment_run_items(org_id,run_id,project_id,bill_id,relationship_id,bill_balance_snapshot_cents,gross_payment_cents,vendor_amount_cents,total_debit_cents)
    values('23000000-0000-0000-0000-000000000001','b3000000-0000-0000-0000-000000000001','33000000-0000-0000-0000-000000000001','93000000-0000-0000-0000-000000000001','83000000-0000-0000-0000-000000000001',10000,10000,10000,10000)$$,
  'P0001',
  'Payment run item bill must identify the relationship vendor',
  'a bill with no vendor company cannot enter a payment run');
select lives_ok(
  $$insert into public.payment_run_items(org_id,run_id,project_id,bill_id,relationship_id,bill_balance_snapshot_cents,gross_payment_cents,vendor_amount_cents,total_debit_cents)
    values('23000000-0000-0000-0000-000000000001','b3000000-0000-0000-0000-000000000001','33000000-0000-0000-0000-000000000001','93000000-0000-0000-0000-000000000002','83000000-0000-0000-0000-000000000001',10000,10000,10000,10000)$$,
  'an attributed bill enters the run normally');

-- And the rail has no second entrance: a disbursement is bound to a run item,
-- and its own integrity trigger refuses one whose bill differs.
select col_not_null('public','disbursements','run_item_id','every disbursement descends from a run item');
select ok(
  pg_get_functiondef('public.enforce_disbursement_integrity'::regproc) like '%item_bill is distinct from new.bill_id%',
  'a disbursement cannot name a bill its run item does not');

-- Bills legitimately have no company until someone attributes them; the
-- constraint is on entry into the rail, never on the bill.
select is(
  (select is_nullable from information_schema.columns where table_schema='public' and table_name='vendor_bills' and column_name='company_id'),
  'YES',
  'an unattributed bill is still a bill — email ingest writes them before anyone files them');

select * from finish();
rollback;
