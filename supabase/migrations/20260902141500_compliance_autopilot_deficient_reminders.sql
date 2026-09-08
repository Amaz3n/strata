-- Autopilot can chase a document that is on file and still not enough.
--
-- The reminder kinds have only ever described whether a document EXISTS and
-- whether it has LAPSED. A certificate that is present, approved, and $500k
-- short of the $1M the requirement asks for produced no reminder at all — the
-- payment hold blocked every payable to that vendor, the compliance tab showed
-- the shortfall, and the one person who could fix it was never told.
--
-- `deficient` is that case: coverage below the required minimum, or a required
-- endorsement the document does not carry. It is the vendor's move to make, so
-- it belongs in the same chase as `missing` and `expired`.

alter table public.compliance_autopilot_deliveries
  drop constraint if exists compliance_autopilot_deliveries_reminder_kind_check;

alter table public.compliance_autopilot_deliveries
  add constraint compliance_autopilot_deliveries_reminder_kind_check
    check (reminder_kind in (
      'missing',
      'expiring',
      'expired',
      'rejected',
      'escalation',
      'deficient',
      'pm_digest'
    ));

comment on column public.compliance_autopilot_deliveries.reminder_kind is
  'Why this reminder went out. `deficient` means the document is on file and approved but does not meet the requirement — the shortfall itself is in `payload.deficiency`, because "send us your certificate" is useless advice to a vendor who already did.';
