-- Covering indexes for arc_bid_benchmark_facts composite foreign keys.

create index if not exists arc_bid_benchmark_submission_org_idx
  on arc_bid_benchmark_facts (org_id, bid_submission_id);

create index if not exists arc_bid_benchmark_invite_org_idx
  on arc_bid_benchmark_facts (org_id, bid_invite_id);

create index if not exists arc_bid_benchmark_package_org_idx
  on arc_bid_benchmark_facts (org_id, bid_package_id);

create index if not exists arc_bid_benchmark_project_org_idx
  on arc_bid_benchmark_facts (org_id, project_id);
