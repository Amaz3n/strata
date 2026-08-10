-- Keep the provider's own words on a failed AI attempt.
--
-- Applied 2026-08-09. Additive and nullable; existing rows keep a NULL message.
--
-- `ai_usage_events` records `error_kind` — a bucket like `rate_limit` or
-- `provider_error` — and throws the provider's message away. That bucket is
-- enough to draw a chart and not enough to fix anything.
--
-- The case that motivated this: document extraction failed on every attempt for
-- two days. The telemetry said `provider_error` on `gemini-2.5-flash`, 240ms.
-- The actual message was "This model is no longer available to new users",
-- which names the problem and the fix. Recovering it meant reproducing the call
-- locally against the live API — for a string the gateway already had in hand
-- and deliberately discarded.
--
-- Truncated at 500 chars: provider errors occasionally carry a stack or a full
-- request echo, and this table gets a row per attempt.

begin;

alter table public.ai_usage_events
  add column if not exists error_message text;

comment on column public.ai_usage_events.error_message is
  'Provider error text for a failed attempt, truncated. NULL on success. The `error_kind` bucket is for charts; this is for fixing the problem.';

commit;
