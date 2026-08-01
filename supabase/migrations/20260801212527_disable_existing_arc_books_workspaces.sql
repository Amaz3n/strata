-- The opt-in migration hides existing external-authority workspaces. Complete
-- that transition by also stopping their shadow-ledger projection posture.
-- Accounting-provider sync is intentionally left in its normal posture.
update public.books_settings
set
  arc_ledger_mode = 'disabled',
  external_sync_posture = 'normal'
where workspace_enabled = false
  and ledger_authority = 'external';
