-- Create active subscription for Strata Construction LLC test org
INSERT INTO subscriptions (
  org_id,
  plan_code,
  status,
  current_period_start,
  current_period_end,
  trial_ends_at,
  cancel_at,
  external_customer_id,
  external_subscription_id
)
SELECT
  id,
  'pro',
  'active'::subscription_status,
  now(),
  (now() + interval '1 year'),
  (now() + interval '30 days'),
  NULL,
  'test_customer_strata',
  'test_subscription_strata'
FROM orgs
WHERE name = 'Strata Construction LLC'
ON CONFLICT DO NOTHING;
