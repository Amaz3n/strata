# Production detail-page audit

Source workflow review on 2026-10-05 of 11 additional pages. Total 40/181 indexed application pages source-reviewed; 0/50 task and 0/9 release acceptance. These are source findings, not authenticated persona/RLS or deployed behavior proofs.

## app/(app)/sales/[dealId]/page.tsx

Consultant/contract coordinator buyer file with stage action, signing recovery, original lifecycle targets and links to other desks.

- getSalesDeal selects one deal through the original RPC; detail does not depend on presence within the capped Sales board.
- Activity is capped at 60 with a truncation indicator but no continuation route on this page.
- Reservation and contract snapshot query errors are not inspected by getSalesDealDetail; failures can appear as absent deposit/pricing/reservation evidence.
- Team read failures are converted to an empty roster. Page passes no caller sales mutation capabilities to action/history components; direct owner authority and reader persona behavior need end-to-end proof.

Owners: `lib/services/sales-deals.ts`, `components/sales/deal-primary-action.tsx`, `components/sales/deal-actions-menu.tsx`.

## app/(app)/starts/[id]/page.tsx

Search/notification permalink redirects to the original Starts lane and selected package sheet.

- Package detail loads separately through getStartPackage -> listStartPackages(id,pageSize 1), so off-lane records have an original selected owner.
- LaunchLane initializes sheetId from props once without source adoption/key on the page; same-component navigation can retain old selection.
- StartPackageSheet load has no response identity/abort fencing; an older selected-record response or failure can replace/close a newer selection.
- Starts desk explicitly flags truncation at 200 per list, but there is no lane continuation and counters are derived from loaded subsets.

Owners: `components/starts/launch-lane.tsx`, `components/starts/start-package-sheet.tsx`, `lib/services/starts-desk.ts`, `lib/services/starts.ts`.

## app/(app)/purchasing/bids/[packageId]/page.tsx

Purchasing price-agreement bid detail reuses the original bid workbench/actions rather than adding a second writer.

- Page requires bid.read and restricts award_target to price_agreement; authority of child reads must be proven independently of this route.
- Invite/addendum/scope/submission readers return full arrays without page metadata; provider caps and embedded submission rows can silently omit scope/vendors.
- Bid workbench computes canAward from package status/target; page does not pass caller bid write/award capabilities. Documents/read-only controls use package state rather than role.
- Intelligence failures become null; critical source evidence and optional advice must be distinguishable. Full SDK/RLS/award/provider acceptance remains open.

Owners: `lib/services/bids.ts`, `components/bids/bid-package-workbench.tsx`, `app/(app)/bids/actions.ts`.

## app/(app)/design-studio/catalog/history/page.tsx

Catalog manager history and original-scope pending publication recovery behind the existing cutover flag.

- Page binds org/actor/community and keys history to that identity; original service validates bounded history/pending replies.
- Default-off cutover means this cannot count as released recovery.
- History errors are converted to null while pending queue errors propagate; actual UI must distinguish failed history from no history.
- Community query may override ambient scope; original current authority/RPC validation must be proven with real denied/current-JWT cases.

Owners: `lib/services/catalog-publication-history.ts`, `components/design-studio/catalog-publication-history.tsx`.

## app/(app)/design-studio/rules/page.tsx

Studio cutoff rule editor uses original group-page and category-label owners, caller manage capability and actor/scope identity.

- Group discovery has server cursor/next cursor; page binds actor/org/community and passes canManage.
- Atomic branch avoids full option/category loading and reads labels for reviewed page references; original-scope/category recovery work is preserved.
- Legacy flag-off branch still loads catalog options/categories. Flag-off and old writer exposure need full-schema cutover/reconciliation.
- Actual reload/cross-tab/current-authority, selected unavailable labels and desktop/mobile QA remain unaccepted.

Owners: `lib/services/option-catalog.ts`, `lib/services/catalog-group-categories.ts`, `components/design-studio/cutoff-rules.tsx`.

## app/(app)/pipeline/[dealId]/plans/page.tsx

Prospect plans route resolves its original linked project and delegates to the shared drawings owner.

- getPreconProjectId uses workspaceContext and authorizes the actual linked project; a service lookup prevents an RLS-hidden project being treated as an unlinked lead.
- No linked project redirects to the original prospect workspace; this is preconstruction exposure, not the production plan offering owner.
- Production released revision/source provenance and archived/scope-moved documents must be proven through the shared drawings workflow, not this redirect alone.

Owners: `lib/services/precon-workspace.ts`, `components/drawings/project-drawings-page.tsx`.

## app/(app)/schedule/trades/page.tsx

Starts/trade coordinator company-grouped production look-ahead and original send action.

- Page requests pageSize 100 and ignores total; it has no page/search controls. Groups after 100 are undiscoverable from this route.
- Page does not consume ambient community context, so changing the shared lens does not narrow this desk.
- Original service applies org/projectorg/production/active/division predicates, but reads up to 100,001 schedule/PO rows then groups and slices in memory; company payloads are unbounded within the page.
- UI always renders Send; service requires start.write. Action validates outside ActionResult run and accepts only weeks, not reviewed community scope.
- UI claims daily deduplication and shows sent success even when original service returns sent:false. Read-event-before-provider-send is not atomic deduplication or durable delivery recovery.
- Expansion uses clickable table rows without keyboard controls; items do not link to canonical home/schedule owner.

Owners: `lib/services/trade-lookahead.ts`, `components/schedule/trade-lookahead-client.tsx`, `app/(app)/schedule/trade-actions.ts`.

## app/(app)/settings/starts/page.tsx

Starts manager gate definitions with explicit role-safe settings UI and original definition writer.

- Page supplies canManage from effective start.release/admin grants; reader remains inspection-only in GateSettingsClient.
- Original list requires start.read; original save requires start.release, validates input and emits audit.
- List reads all definitions without page/exhaustion metadata; large/legacy duplicate datasets and source failure/permission revocation need real QA.
- Gate definition save/audit remain separate requests with no reviewed source revision/exact request receipt; released-home policy version and competing edits remain open.

Owners: `lib/services/starts.ts`, `components/starts/gate-settings-client.tsx`.

## app/(app)/settings/warranty/page.tsx

Warranty manager program/coverage/SLA configuration with org-default vocabulary and existing-home usage counts.

- Both original reads require warranty.manage; absence of a client canManage flag is not proof that a denied user can reach editing controls.
- Both read owners call ensureWarrantyDefaults, so opening settings can perform writes. Read-only inspection and explicit preparation lifecycle are missing.
- Original upsert clears defaults, updates/inserts program, deletes terms and reinserts them as separate requests. Some write errors are ignored; partial failure can leave no default or lost coverage terms.
- Program usage counts are checked exact HEAD counts; row/cost source failure is not zero. Program list itself remains full-array/provider-cap dependent.
- Org tier is used for settings vocabulary; mixed-posture coverage administration must preserve all home programs and source terms under publication/reload/races.

Owners: `lib/services/warranty-operations.ts`, `app/(app)/settings/warranty/warranty-settings-client.tsx`, `app/(app)/warranty/actions.ts`.

## app/(app)/warranty/accounting/page.tsx

Controller adjustment-permission cost approval/reversal using original Books actions and integer-cent source allocation.

- Page checks Books adjust access and service requires books.adjust. Reader approval controls are not exposed through this route.
- Workspace service-role reads exhaust completed visit/source arrays but only apply org and optional home filters; actual-home/division authority must be validated before privileged reads.
- Client loads all visits manually with no search/paging; late-home discovery and payload bounds remain missing.
- Client source/visit responses have no actor/home/selection fence; approval/reversal generates fresh bodies with no predispatch immutable request/recovery status.
- Original financial RPC owns domain operation but TS audit/event follow separately; full-schema/current permission/concurrency/source allocation/restore acceptance is required.

Owners: `components/books/warranty-accounting.tsx`, `lib/services/books/warranty-accounting.ts`, `app/(app)/books/actions.ts`.

## app/(app)/projects/[id]/schedule/page.tsx

Home schedule/dependencies read and original ScheduleView mutation callbacks.

- Page resolves project first, then direct action reads. Reads themselves require only org context rather than explicit actual-home schedule permission.
- getProjectScheduleAction loads dependencies for the entire org before home items; child ancestry/completeness/provider caps are unproven.
- Both schedule/dependency read errors log and return[], presenting failed evidence as an empty schedule.
- ProjectScheduleClient initializes rows/dependencies once and supplies all editing callbacks without capability. New server data/home context can retain stale local state.
- Canonical focused item query is passed to ScheduleView, but off-page data/keyboard/read-only/mixed-posture/RLS and independent schedule writer races remain unaccepted.

Owners: `app/(app)/projects/[id]/actions.ts`, `app/(app)/projects/[id]/schedule/project-schedule-client.tsx`.

Evidence and source fingerprints.
