-- Severity duplicated priority for the internal bug tracker (impact vs urgency),
-- adding a redundant input without real value. Priority alone captures "how bad".
alter table public.platform_bugs
  drop column if exists severity;
