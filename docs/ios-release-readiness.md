# iOS Release Readiness

Last validated locally: 2026-07-01.

## Passed checks

- Mobile API contract: `npm run test:mobile`
- TypeScript: `npx tsc --noEmit --pretty false`
- Production web build: `npm run build`
- iOS Debug simulator tests: `xcodebuild test -project ios/Arc/Arc.xcodeproj -scheme Arc -configuration Debug -destination 'platform=iOS Simulator,id=612EA5F3-0E0A-4D13-8EC2-F85E7B99E965'`
- iOS Release simulator build: `xcodebuild build -project ios/Arc/Arc.xcodeproj -scheme Arc -configuration Release -destination 'platform=iOS Simulator,id=612EA5F3-0E0A-4D13-8EC2-F85E7B99E965'`

## App identity

- Bundle id: `com.arcprojects.mobile`
- Apple Developer Team: `L2PS6KCB8C`
- Display name: `Arc`
- Push entitlement: `ios/Arc/Arc/Resources/Arc.entitlements`

Debug builds are push-disabled so a free personal Apple team can install and test on device. Release builds are push-enabled and require a paid Apple Developer account/provisioning profile with Push Notifications.

## Required deployment config

Native app public config:

- `ARC_SUPABASE_URL`
- `ARC_SUPABASE_PUBLISHABLE_KEY`
- `ARC_SENTRY_DSN` optional

Web deployment for mobile API and push:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` or `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `APNS_KEY_ID`
- `APNS_TEAM_ID`
- `APNS_AUTH_KEY`
- `APNS_BUNDLE_ID=com.arcprojects.mobile`
- `APNS_ENVIRONMENT=production`
- `CRON_SECRET` for background job protection

## Database migrations needed

- `supabase/migrations/20260625120000_mobile_device_tokens.sql`
- `supabase/migrations/20260701123000_platform_bugs.sql`
- `supabase/migrations/20260701140000_platform_bugs_drop_unused_fields.sql`
- `supabase/migrations/20260701150000_platform_bugs_drop_severity.sql`
- `supabase/migrations/20260701160000_platform_bug_attachment_pdfs.sql`

## Manual TestFlight smoke test

- Sign in with a platform/superuser account.
- Confirm organization and project list load.
- Open Platform, review Audit, review Issues, submit a test issue.
- Open a project and check Project, Docs, Drawings, Logs, Schedule, Tasks/Punch, Expenses, RFIs, Team.
- Create a daily log with a photo and verify it appears on web.
- Submit a receipt/expense test if using the expense flow.
- Register for push on a physical device and send one notification through an existing notification-producing workflow.
- Sign out and verify the device token unregister path does not error.
