# Arc for iOS and iPadOS

Arc is a universal SwiftUI app for field workflows. It lives beside the web app so native features and their mobile API contracts can evolve together.

## Requirements

- Xcode 26 or newer
- iOS 17 or newer

## App identity

- Display name: `Arc`
- Bundle identifier: `com.arcprojects.mobile`
- Apple Developer Team: `L2PS6KCB8C`
- Device families: iPhone and iPad

Free personal Apple teams can run Debug builds on device, but they cannot use Push Notifications. Debug builds are intentionally push-disabled and do not include the APNs entitlement. Before TestFlight or production push, confirm the bundle identifier exists in a paid Apple Developer account and the provisioning profile includes Push Notifications.

## Environments

- Debug builds use `development` and `http://127.0.0.1:3000/api/mobile/v1`.
- The `Arc Staging` scheme sets `ARC_ENVIRONMENT=staging`.
- Release builds use `production` and `https://app.arcnaples.com/api/mobile/v1`.

Set the public Sentry DSN with the `ARC_SENTRY_DSN` scheme environment variable or the `ArcSentryDSN` Info.plist build setting. Never add service-role keys, Sentry auth tokens, or other private credentials to the app bundle.

Set these public Supabase values in the Arc target's User-Defined Build Settings or as scheme environment variables:

- `ARC_SUPABASE_URL`
- `ARC_SUPABASE_PUBLISHABLE_KEY`

Use the publishable key (or legacy anon key while migrating), never the secret/service-role key. The native client uses Supabase Auth for password sign-in and refresh, stores the resulting session in Keychain, and sends only the short-lived access token to Arc's versioned mobile API.

For local builds, `Config/Shared.xcconfig` includes the git-ignored `Config/Secrets.xcconfig`. It should contain only public client-safe values:

- `ARC_SUPABASE_URL`
- `ARC_SUPABASE_PUBLISHABLE_KEY`
- `ARC_SENTRY_DSN` (optional)

The auth client currently talks to Supabase Auth's token endpoints behind the local `AuthClient` protocol. This avoids blocking the app on unavailable GitHub package resolution; the official `supabase-swift` SDK can replace that implementation without changing session, UI, or workspace code.

The API contract lives at `docs/mobile-api-v1.openapi.yaml` in the repository root.

`Observability` is ready to use the `Sentry` module when linked. Add the official `sentry-cocoa` Swift package at version `9.18.0` and select its `Sentry` product. The package is deliberately not committed yet because GitHub package resolution was unavailable during foundation setup; keeping the unresolved reference made every Xcode build hang.

## Open and run

Open `Arc/Arc.xcodeproj`, select the `Arc` scheme, and run on an iPhone or iPad simulator.

## Structure

- `App/` owns app composition, adaptive navigation, and routing.
- `Core/` contains shared networking, authentication, persistence, and sync infrastructure.
- `Features/` contains product features. Feature-specific state stays with its feature.
- `Resources/` contains assets and configuration.
- `ArcTests/` contains unit tests for app and domain behavior.

## Navigation model

The native app has two explicit contexts:

- The global workspace opens to the searchable Projects directory.
- Opening a project enters a project workspace with Project, Docs, Drawings, Logs, and More destinations.

On iPhone those destinations use a tab bar with independent navigation history. On iPad the same destinations appear in a project-scoped sidebar. The project name opens a searchable switcher from every module, while All Projects returns to the global workspace without discarding the last-project convenience selection.

The initial screens are intentionally skeletal. The first production vertical slice should establish authentication, project selection, the versioned mobile API, and an offline-capable field workflow.

## Offline behavior

SwiftData stores the authenticated user's last workspace and project snapshots locally. After one successful load, the app can restore that context during a cold launch without connectivity. Feature work can save editable payloads as durable drafts and enqueue API mutations with stable idempotency keys; the sync engine retries transient failures with exponential backoff whenever connectivity returns. A toolbar indicator shows offline, syncing, queued, failed, and up-to-date states.

Large file and photo transfers use a background `URLSession`, allowing iOS to continue uploads after the app leaves the foreground. Individual field features remain responsible for copying selected files into app-owned durable storage before enqueueing a transfer.

## Daily Logs

The Daily Logs module uses the versioned `/projects/{projectId}/daily-logs` mobile API. It presents logs as a date-grouped field timeline with search, photo and inspection-issue filters, weather, work-hour and progress summaries, inspection results, comments, and pending-sync state.

The native composer supports date, weather, site narrative, camera/library photos, work entries, schedule links, hours, progress, trade, location, inspections, task completion, punch-item closure, and project-team mentions. Drafts auto-save in SwiftData. Submissions use stable client UUIDs, so log, comment, and photo requests can safely be retried. Transient/offline writes enter the durable mutation and upload queues for automatic synchronization.

Log detail supports photo viewing, comments with mentions, editing summary/weather/mentions, and deletion. Mentioned users receive Arc's existing in-app/email notification flow.

## Schedule

The Schedule module (`Features/Schedule`) presents a mobile agenda from `GET /projects/{projectId}/schedule`, grouped into Overdue / In progress / Upcoming / Completed with date ranges, trade/phase/location, assignees, critical-path flags, and progress. The project dashboard's "Up next" card reuses the same store to surface the next week's activity.

## Tasks & Punch list

The field-action modules (`Features/Field`) list tasks (`GET /projects/{projectId}/tasks`) and punch items (`GET /projects/{projectId}/punch-items`) and let crews toggle completion in place via `PATCH .../tasks/{taskId}` and `PATCH .../punch-items/{punchItemId}`. Open counts appear as badges in the More menu.

## Expenses & receipt capture

The Expenses module (`Features/Expenses`) lists submitted expenses with signed receipt thumbnails (`GET /projects/{projectId}/expenses`). The capture flow takes a photo (or library image), optionally runs AI extraction (`POST .../expenses/scan`) to prefill vendor/date/amount/tax/payment method, and submits a multipart expense with the receipt (`POST .../expenses`). Submissions use a client UUID for idempotent retries.

## Documents

The Documents module (`Features/Documents`) browses the project file tree (`GET /projects/{projectId}/files?folder=...`), descending into folders and previewing files with QuickLook after an on-demand signed-URL download. Daily-log photo uploads are excluded from the browser.

## Notifications

The Notifications screen (`Features/Inbox`) lists the user's in-app notifications for the selected org (`GET /notifications`), supports mark-as-read and mark-all-read (`POST /notifications/{id}/read`, `POST /notifications/read-all`), and drives an unread badge on the toolbar bell in both the global and project shells.

## Design system

`Core/DesignSystem` holds the shared brand palette (`BrandTheme`) plus reusable components (`Components.swift`): `ArcCard`, `MetricTile`, `QuickActionTile`, `ArcSectionHeader`, and `StatusBadge` with `ArcStatusColor` semantic colors so schedule/task/punch/expense/RFI statuses read consistently. The project dashboard (`Features/Home`) is a polished home: project header, a 2×2 metric grid (open tasks, punch, schedule %, daily logs), quick actions, an "Up next" schedule card, and recent logs.

## RFIs & Team

`Features/ProjectInfo` lists project RFIs (`GET /projects/{projectId}/rfis`) grouped open/answered with priority and assignee, and the project team directory (`GET /projects/{projectId}/team`) with avatars and mailto links. Both are reachable from the More menu and the enriched Project Details screen.

## Platform tools

Platform users see a global Platform sheet with Audit and Issues tabs. Audit uses `GET /platform/audit-log`; Issues uses `GET /platform/issues` and `POST /platform/issues` so platform owners can inspect client activity and file issues from iPhone or iPad.

## Offline & sync

Task and punch status toggles update optimistically and, when offline or on a retryable failure, enqueue a JSON `PATCH` into the durable `PendingMutation` queue handled by `SyncEngine` (the same queue daily logs use). A toolbar sync indicator surfaces syncing / offline / queued-count / needs-attention state in both shells.

## Push notifications

`Core/Push/PushManager` requests notification authorization, registers for remote notifications, and uploads the APNs token to `POST /api/mobile/v1/devices` (removed on sign-out via `DELETE`). The `ArcAppDelegate` forwards the device token through `PushTokenBroker`. Server-side, `NotificationService.createAndQueue` enqueues a `deliver_push` outbox job and the `process-outbox` worker sends via `lib/services/apns.ts` — all **env-gated** on `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_AUTH_KEY` / `APNS_BUNDLE_ID` (optional `APNS_ENVIRONMENT=sandbox`). When unset, every push path is a no-op.

Debug builds set `ARC_PUSH_ENABLED=NO` so personal teams can install the app without a paid account. Release builds include `Resources/Arc.entitlements`, resolve `aps-environment=production`, and set `ARC_PUSH_ENABLED=YES`. Before push works on device you must ensure the Apple provisioning profile includes Push Notifications, run the `supabase/migrations/20260625120000_mobile_device_tokens.sql` migration, and set `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_AUTH_KEY`, `APNS_BUNDLE_ID`, and optional `APNS_ENVIRONMENT` in the web deployment.

## Release readiness

Commands currently used for the local release gate:

```sh
npm run test:mobile
npx tsc --noEmit --pretty false
npm run build
xcodebuild test -project ios/Arc/Arc.xcodeproj -scheme Arc -configuration Debug -destination 'platform=iOS Simulator,id=612EA5F3-0E0A-4D13-8EC2-F85E7B99E965'
xcodebuild build -project ios/Arc/Arc.xcodeproj -scheme Arc -configuration Release -destination 'platform=iOS Simulator,id=612EA5F3-0E0A-4D13-8EC2-F85E7B99E965'
```

For TestFlight, switch the destination to a generic iOS device or archive from Xcode after confirming signing and provisioning.
