begin;

select plan(13);

select has_table('public', 'books_debt_instruments', 'debt instrument register exists');
select has_table('public', 'books_debt_events', 'immutable debt event register exists');
select has_table('public', 'books_fixed_assets', 'fixed asset register exists');
select has_table('public', 'books_fixed_asset_events', 'immutable fixed asset event register exists');
select has_table('public', 'books_tax_jurisdictions', 'tax jurisdiction register exists');
select has_table('public', 'books_tax_filings', 'tax filing evidence register exists');
select has_table('public', 'books_greenfield_launches', 'greenfield launch evidence exists');
select has_table('public', 'books_journal_proposals', 'maker-checker journal proposals exist');

select has_function(
  'public', 'post_books_registered_subledger_event_atomic',
  array['uuid','text','uuid','jsonb','jsonb','jsonb'],
  'registered subledger posting RPC exists'
);
select has_function(
  'public', 'launch_books_greenfield_atomic',
  array['uuid','uuid','date','text','text'],
  'greenfield launch RPC exists'
);
select has_function(
  'public', 'review_books_journal_proposal_atomic',
  array['uuid','uuid','uuid','text','text'],
  'maker-checker review RPC exists'
);
select has_function(
  'public', 'store_company_tax_identity_atomic',
  array['uuid','uuid','text','uuid'],
  'Vault-backed taxpayer identity RPC exists'
);
select has_function(
  'public', 'replace_company_tax_identity_atomic',
  array['uuid','uuid','text','uuid'],
  'Vault-backed taxpayer identity rotation RPC exists'
);

select * from finish();
rollback;
