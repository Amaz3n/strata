-- Mobile push: per-user APNs device tokens captured by the iOS app.
-- A token is globally unique; re-registration upserts the owning user/org and
-- refreshes last_seen_at so stale tokens can be pruned later.
create table if not exists "public"."device_tokens" (
    "id" uuid primary key default gen_random_uuid(),
    "org_id" uuid not null references "public"."orgs"("id") on delete cascade,
    "user_id" uuid not null references "public"."app_users"("id") on delete cascade,
    "token" text not null unique,
    "platform" text not null default 'ios',
    "app_version" text,
    "environment" text not null default 'production',
    "last_seen_at" timestamptz not null default now(),
    "created_at" timestamptz not null default now()
);

create index if not exists "device_tokens_user_idx" on "public"."device_tokens" ("user_id");
create index if not exists "device_tokens_org_idx" on "public"."device_tokens" ("org_id");

alter table "public"."device_tokens" enable row level security;

-- Service-role only: the mobile API uses the service client (token-authenticated),
-- and the outbox push worker reads tokens with the service role. No anon/authed
-- policies are added, so RLS denies all non-service access by default.
