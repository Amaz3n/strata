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

The global field workspace opens to Projects or My Houses. Opening a project on iPhone provides four tabs: Overview, Logs, Work, and Library. Work groups Tasks, Punch, and Schedule. Library provides Drawings, Documents, and Photos. The project menu retains Contacts, Project Details, RFIs, Field Tools, Receipts and Expenses, and Account. Field Tools exposes permission-filtered time, inspections, safety, warranty, submittals, selections, and decisions without adding office modules to the phone tabs.

Each iPhone tab keeps independent navigation history. iPad keeps an expanded field sidebar even in narrow windows and provides a separate native Workspace surface with organization/project scope, module sidebar, searchable records, and record details. Workspace uses SwiftUI throughout.

The native Workspace is under active implementation; it does not yet have full website parity. The permission-filtered catalog follows project posture, phase, module overrides, signature feature flags, and Books enablement. Organization-wide accounting access is required for Books.

Working native flows include:

- Opportunity creation/editing, contact records, activity notes, follow-up dates/completion, early lead stages, and lost/reopen actions. Delivered deals stay locked.
- Project proposals/estimates: budget and preconstruction-agreement drafts, native line items and commercial terms, draft revision with accounting/takeoff provenance preservation, PDF preview, explicit email sending, new revisions, and construction-agreement drafts derived from approved budgets. Existing executed PDFs use their stored signed snapshot, never a live replacement.
- Create and edit tasks, decisions, inspections, meetings, safety incidents, closeout items, warranty requests, companies, contacts, communities, and house-plan metadata. RFIs and submittals support draft creation.
- RFI responses and close/reopen; submittal items, submission/resubmission, unrouted reviews, and routed review-step decisions; inspection checklist responses and completion; meeting agenda items, attendees, attendance, finalization/distribution, and minutes PDFs.
- Time entry for the signed-in user, notes, and permission-gated approval/rejection.
- Correspondence conversation reading, attachment downloads, and classification; transmittal draft creation with native recipient/enclosure rows, project-document selection, recipient activity, and explicit sending.
- Signature recipients, activity, source/executed documents, reminders, and voiding existing envelopes.
- Dedicated project invoice draft creation and revision with native line items, quantities, unit prices, tax, and notes. Revisions preserve server-side accounting links and reject stale or issued/source-derived invoices. Invoice review requests/decisions, PDF preparation, and explicit issue/email actions are available.
- Payable coding and approval evidence, document preview, and approve/reject with revision checks. Project bid draft creation, package-detail editing, and scope editing preserve existing cost codes and reject foreign/duplicate scope IDs. Commitment draft creation and draft schedule-of-values line creation/edit/removal use dollar inputs. Change-order draft creation supports line items, tax/markup and schedule impact, with line details and pricing/proposal transitions. Plans and start gates have expanded details.
- Native schedule creation/editing and predecessor management, plus an organization schedule overview. Organization Tasks follows the web My Tasks visibility (created/assigned/mentioned) and filters inaccessible projects.
- Punch creation/editing, project-company assignment, verification requirements, and canonical status transitions. Project tasks support team assignment. Both support photo/document attachments with stable upload IDs for retry.
- Execute reports from the web report catalog with supported native filters, summary statistics, and formatted table rows. Report packets, exports, charts, and drilldowns remain pending.
- Bank accounts, transactions, reconciliations, chart of accounts, general ledger, and asset/loan registers. Native actions support chart creation/editing/activation, bank mapping, categorization with project/cost coding, statement creation/close/reopen, and period-close checks/close/reopen. Canonical accounting services recheck every mutation.
- Project photo albums, search, paginated browsing, full-screen image/video viewing, and image upload through the existing daily-log upload service.

Workspace submission and photo uploads require connectivity; they are not queued for offline replay. Generic new-record forms recover locally saved drafts scoped to user, organization, project, and module. Editing/action sheets and the dedicated invoice editor do not yet persist drafts across app termination. Uncertain workspace submissions must not be automatically retried. List search currently searches loaded records. Some underlying services cap lists (e.g., latest 250 bank transactions); these views are not complete exports. Native report tables indicate truncation.

Remaining substantial work includes:

- Preconstruction pricing worksheets, trade-pricing comparison, advanced alternates/grouping and bid/takeoff linking in estimates, proposal photo/presentation editing, builder countersignature and project handoff; signature packet creation and PDF field placement; drawing takeoff and native 3D modeling.
- Production workflows: selections/design-studio authoring, sales/lot/closing workflows, starts scheduling/release management, purchasing/price agreements, and warranty dispatch.
- Financial workflow depth: source-derived billing, full change-order revision/approval/signing, bid invitations/comparison/awards, commitment issuance/execution, vendor bill creation/coding, cost inbox, and T&M ticket authoring.
- Company schedule planning/baselines, advanced labor coding/correction, report packets/exports/charts/drilldowns, company-budget editing, bank-feed onboarding/imports and advanced matching, asset/loan lifecycle actions, and broader administrative settings.
- Release validation: complete signed-in create/edit/attachment flows, offline/reconnect on physical devices, push provisioning/delivery, release signing, accessibility/large-text and performance checks, backend deployment, and TestFlight.

A sidebar entry does not establish feature parity. Use `components/layout/app-sidebar.tsx`, `project-nav-items.ts`, and `books-nav-items.ts` as the coverage checklist. These are still implementation/test builds, not a complete native Arc release.

The native Workspace depends on `/workspace`, `/workspace/{module}`, and `/workspace/{module}/{recordId}` in the versioned mobile API. Photos require the updated project photos route with signed native URLs. Use the matching backend; these local route changes have not been deployed by this task. Simulator builds and automated tests do not establish signed-in production workflow verification.

## Offline behavior

SwiftData stores the authenticated user's last workspace and project snapshots locally. After one successful load, the app can restore that context during a cold launch without connectivity. Feature work can save editable payloads as durable drafts and enqueue API mutations with stable idempotency keys; the sync engine retries transient failures with exponential backoff whenever connectivity returns. A toolbar indicator shows offline, syncing, queued, failed, and up-to-date states.

Large file and photo transfers use a background `URLSession`, allowing iOS to continue uploads after the app leaves the foreground. Individual field features remain responsible for copying selected files into app-owned durable storage before enqueueing a transfer.

Documents support name search within a folder, explicit downloads, a downloaded-only filter, and cached folder listings with an offline notice. Drawing sheets support explicit image downloads and saved sheet details. Downloads are isolated by user and organization in Application Support, excluded from backups, and protected until the first device unlock. The Download Project screen saves a complete document manifest/folder tree and/or the currently published drawing images, with progress, failures, cancellation, and retry. Keep the screen open until completion. It records the last successful snapshot and does not imply continuous/background sync. A newer file or drawing revision needs a fresh download. Documents can search all project folders online or from a previously downloaded manifest. Drawing reads never substitute an older image for a missing current revision.

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

## Verification snapshot — October 1–2, 2026

- Backend mobile regression suite: 60 passing cases; includes native document creation/editing, permission boundaries, project document pagination and isolation, invoice revision and accounting-link preservation.
- Native suite: 43 passing tests on both iPhone and iPad Simulator, including field navigation, local cache/draft isolation, nested folder manifests, repeated form rows, invoice calculations and identity preservation.
- Full repository TypeScript check passed after the preconstruction and PDF changes.
- Signed-in local API reads and native workspace creation forms loaded in iPad Simulator. Simulator automation could not enter text reliably, so these checks do **not** establish end-to-end saved-record verification. No live record was created or message sent in this verification pass.
- Debug and Release simulator builds compile. Matching backend changes are local, not deployed. Debug simulator builds use the running local backend on port 3000.

## Release readiness

Commands currently used for the local release gate:

```sh
npm run test:mobile
npx tsc --noEmit --pretty false
npm run build
xcodebuild test -project ios/Arc/Arc.xcodeproj -scheme Arc -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17,OS=27.0'
xcodebuild build -project ios/Arc/Arc.xcodeproj -scheme Arc -configuration Release -destination 'platform=iOS Simulator,name=iPhone 17,OS=27.0'
```

The destination is matched by name and OS rather than UDID on purpose: simulator
UDIDs are per-machine, so a pinned id fails for everyone but the person who wrote
it. The `OS=` half matters too — with several runtimes installed, a bare device
name is ambiguous and `xcodebuild` refuses with a wall of candidate destinations.
List what this machine actually has and substitute from that output:

```sh
xcrun simctl list devices available
```

If `xcodebuild` hangs and never creates its DerivedData directory, check for a
stuck first-launch install — it needs an admin prompt and holds a lock every
other Xcode tool blocks on:

```sh
ps aux | grep '[r]unFirstLaunch'
sudo xcodebuild -runFirstLaunch
```

A machine with no installed runtimes (`~/Library/Developer/CoreSimulator/Profiles/Runtimes/`
missing) can still type-check against the SDK, which is a useful fallback gate
but is **not** a build and runs no tests:

```sh
xcrun --sdk iphonesimulator swiftc -typecheck -target arm64-apple-ios17.0-simulator $(find ios/Arc/Arc -name '*.swift')
```

For TestFlight, switch the destination to a generic iOS device or archive from Xcode after confirming signing and provisioning.
