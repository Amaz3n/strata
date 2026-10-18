# Field and handoff page source audit

2026-10-04. Source assessment only; no authenticated persona, full-schema, device or release acceptance. These findings extend F01; they do not reduce the national-builder contract.

## app/(app)/documents/page.tsx

Intentional redirect to /projects; project-scoped Documents is the workbench.

- This route is not a missing global document desk. Document ownership and production exposure must be assessed at the project browser and direct file/report/action surfaces.

Next: Audit the actual project browser, folder sharing, source contexts and archive/report owners; preserve the intentional desk rule.

## app/(app)/projects/[id]/documents/page.tsx

Shared ProjectDocumentsPage resolves the home, loads a 100-file page with exact count/hasMore/folder state, and DocumentsContext implements load-more paging.

- listFilesWithUrls catches source-context lookup failure and supplies an empty mapping; the visible provenance can disappear during a source outage.
- The first-page and load-more plumbing are present, but current JWT/folder access, selected file discovery, archive/recovery, keyboard/mobile and large installed document sets remain unaccepted.

Next: Verify original file/folder/download owners and provenance errors on actual authorized and denied home/folder users.

## app/(app)/projects/[id]/punch/page.tsx

Project punch workbench provides company/team/location context, a selected-item query and PDF export; its client resets on project change.

- listProjectPunchItemsAction is an unpaged project/org query and returns [] on read error. It does not prove source exhaustion or distinguish unavailable work from no work.
- The reviewed list/create actions lack an explicit actual-home permission assertion; the page project lookup and asynchronous layout identity are not evidence for independent action calls or current JWT/RLS.
- The client receives location-management capability but no punch write capability. Reviewed create/assignment/dispatch operations are separate writes and need original-request/orphan recovery; intermediate inspection corrections therefore remain unaccepted.

Next: Complete actual-home read/write gates, complete bounded item/selected-item reads, reader-safe controls, transaction-backed corrective assignment/resolution/dispatch and source-bound acceptance.

## app/(app)/projects/[id]/safety/page.tsx

Existing incident/toolbox/observation workbench and offline-draft UI; the page aggregates the three original safety owners.

- Both PROJECT_MODULES and project navigation restrict Safety to commercial posture. Production homes do not receive its normal navigation entry; mixed production orgs can expose it on commercial projects. This is a production field-workflow discovery gap, not an org-tier capability gate.
- Incident/toolbox lists cap at250 and observations at500 with no completeness/pagination metadata returned. Incidents check organization safety.read, while the reviewed toolbox/observation reads show only org/project filters.
- The page passes location-management capability but no safety write capability; create/edit controls are rendered without a caller-specific safety write flag.

Next: Reconcile intended production posture exposure, current actual-home safety authority, bounded history/selected records and reader-safe controls before field/device acceptance.

## app/(app)/projects/[id]/closeout/page.tsx

Project closeout combines checklist, separate financial/vendor/schedule/field readiness, waivers and optional GMP settlement.

- getCloseoutPackage authorizes closeout.read then calls ensurePackage, which inserts the package and defaults on a read. Default-item insert errors are not checked. A reader can therefore enter a source path that writes before explicit preparation.
- GMP summary errors are caught as null, so failed optional financial evidence is hidden.
- ProjectCloseReadiness scans multiple growing project collections without source-exhaustion pagination; it surfaces query errors but has only organization permission checks in its reviewed entry.
- Final inspection sign-off is a titled closeout item; the new required inspection acceptance contract is wired to Closing and does not yet establish every closeout readiness/mutation writer.

Next: Move package preparation to an authorized explicit owner action, preserve failed optional evidence, complete scoped paged readiness and bind accepted inspection obligations across generic closeout completion/exports/recovery.

The project layout resolves identity in a separate Suspense child alongside page children. Every independent owner needs its own actual-resource authorization; layout presence is not its proof. Verify current JWT/RLS and all action/portal/report/SQL paths before declaring scope isolation.
