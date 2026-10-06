# Signatures and e-signing assessment

Reviewed October 2, 2026. Baseline: `9f1549af` plus the current, extensively modified working tree. This is an assessment, not an implementation plan or a deployment approval. No application source or production data was changed.

Arc has substantial signing functionality but is not yet ready to promise dependable replacement of a dedicated e-sign provider. The largest gaps concern agreement integrity, recoverability and truthful completion/delivery state. Adding more field types before repairing those foundations would increase exposure.

## Scope and verification

Reviewed the organization signatures page, envelope wizard and field editor, public `/d/[token]` signing/view/download paths, signature persistence and PDF execution, checked-in database policies, reminders, completed-copy delivery, relevant outbox handling, estimate countersigning, waiver integration, and change-order execution effects. Parallel read-only reviews covered engine/security, UI, and integrations; findings below were checked against source by the primary reviewer.

Ran five focused local suites: `node --test --test-reporter=dot tests/waiver-self-signing.test.js tests/invoice-waiver-signing.test.js tests/waiver-signer-request.test.js tests/waiver-document-engine.test.js tests/waiver-recipient.test.js` — 14 tests passed. These do not establish general engine correctness: the self-signing tests mock `submitDocumentSignatureAction`.

Ran an in-memory PDF-generation check using the actual `generateExecutedPdf`: an ASCII name succeeded; a Chinese name failed with a WinAnsi encoding error. No customer files or production services were used.

Not verified: deployed database policy parity, production configuration/retention/backups, email-provider delivery behavior, actual browser/mobile layouts, screen-reader behavior, load/performance measurements, every domain integration, or jurisdiction-specific legal sufficiency. No claim of legal certification is made. Source-derived UI findings are distinguished from runtime checks.

## Already implemented

- Signer/CC recipients; sequential or fully parallel signing; basic recipient-assigned required fields.
- PDF upload and merging, linked-record preparation, draft restoration and source-version context.
- Draw/type/upload signatures, signature reuse, consent checkbox/terms link, and decline with reason.
- Templates, bulk-send UI, reminders/expiry, manual resend, void/new-copy and offline signed-copy upload.
- Sign-myself flow, recipient status, identity-mismatch display, executed download and an appended audit certificate.
- Outbox infrastructure for completed-copy delivery and generic domain effects; atomic request consumption in the general signing path.

These are useful foundations. Their presence should not be confused with verified lifecycle guarantees.

## Prioritized findings

P0 = agreement integrity or replacement-readiness blocker; P1 = essential reliability/usability; P2 = subsequent improvement. Effort includes tests: S = hours, M = roughly 1–2 days, L = multiple days. These are coarse sizing aids, not delivery estimates. Risk describes the change, not the existing defect. Confidence is high unless qualified.

| ID | Priority | Finding and user impact | Effort | Change risk | Confidence |
|---|---|---|---|---|---|
| 01 | P0 | Recipient field ownership is not enforced when values are persisted; later submissions can overwrite another recipient's answers/signature. | M | Low | High |
| 02 | P0 | Checked-in policies allow qualifying members to mutate signature evidence directly. | M–L | Medium | High in repo; live unverified |
| 03 | P0 | Signatures are consumed before PDF/storage completion, without durable artifact recovery; parallel signers can also race finalization. | L | Medium | High |
| 04 | P0 | Sent field definitions can be deleted/replaced, disconnecting previously signed values from final output. | M | Medium | High |
| 05 | P1 | Rendering failures and layout inconsistencies can omit or invalidate the final artifact. | M–L | Medium | High; Unicode reproduced |
| 06 | P1 | Some email failures are recorded as successful; reminders invalidate previously received links. | M | Medium | High |
| 07 | P1 | Downstream change-order work cannot reliably resume after partial success. | L | High | High |
| 08 | P1 | Native estimate countersigning bypasses the atomic path and can publish a certificate-less executed PDF. | L | High | High |
| 09 | P1 | Organization-page project selection resets, blocking standalone preparation/bulk sending. | S | Low | High; source-derived |
| 10 | P1 | Signers cannot properly review populated field values before consenting. | M | Low | High; source-derived |
| 11 | P1 | Consent and source evidence are not bound adequately to what each signer saw. | M–L | Medium | High |
| 12 | P1 | Voiding a request does not revoke access through its source-PDF endpoint. | S–M | Low | High |
| 13 | P1 | Core lifecycle, failure and concurrency tests are missing from inspected coverage. | L | Low | High |
| 14 | P1 | Unsaved placement and signer progress are lost on close/reload; accessible review is incomplete. | L | Medium | High; source-derived |
| 15 | P2 | Hub search and reminder scanning stop at fixed caps, hiding history and potentially starving reminders. | M | Medium | High |
| 16 | P2 | Bulk sending silently drops malformed recipient rows and hides individual outcomes. | M | Medium | High |

### 01 — Enforce field ownership at the server and database boundary

Evidence: `app/d/[token]/actions.ts:218` filters fields only for required-field checks; `:271` persists the entire supplied values object; `:375` merges all signatures using later values as overrides. A signer must only be able to write their assigned field IDs. Reject unknown/unassigned IDs and invalid value types; bind final merge ownership to frozen assignments. Test a second signer submitting another recipient's field ID, plus unknown fields and malformed values.

### 02 — Make signing evidence append-only

Evidence: `supabase/migrations/20260517092101_remote_schema.sql:12001` defines an all-operations `document_signatures` policy for qualifying members; `:14883` grants authenticated table privileges. Generic signing events use `events`, whose membership-based policy at `:12144` also permits mutation. No later specific restriction was found. Verify live policies before assessing deployed exposure, then restrict evidence writes to trusted, narrow functions. Ordinary members should not fabricate, update or delete signatures via the Data API. Database authorization tests are required; a dedicated append-only signing ledger may be preferable to relying on generic activity events.

### 03 — Make acceptance durable and execution recoverable

Evidence: `app/d/[token]/actions.ts:261` atomically consumes the request before PDF generation at `:404`, upload at `:437` and file/version inserts at `:448`/`:480`. The outbox is only enqueued at `:537`, for downstream effects after the artifact exists. Completion is checked outside the transaction at `:327`; execution has no envelope-level claim. Final document/envelope update errors at `:506`/`:511` are not checked. The signed-request screen at `app/d/[token]/page.tsx:154` reports success even when the executed file is absent.

Accept the signature and enqueue finalization in one transaction. Introduce truthful accepted/processing/ready/retryable-failure states, one finalization identity per envelope revision, and resumable artifact creation. Serialize recipient advancement as well: competing submissions must not issue competing links. Fault-inject every storage/database boundary and concurrent final signers.

### 04 — Freeze sent revisions

Evidence: `lib/services/documents.ts:400` deletes fields and `:432` reinserts them with new IDs; no lifecycle check or transaction protects the replacement. `app/(app)/signatures/actions.ts:398` exposes this service. Signing reads current definitions. Replacing fields after the first signature can cause stored answers to have no corresponding final field.

Replace draft fields transactionally; enforce immutable sent field definitions/source references in both database and service. Corrections require explicit versioning and rules for restarting consent, not silent changes to an active revision.

### 05 — Use one rendering contract from editor through executed PDF

Evidence: any nonempty signature string passes `app/d/[token]/actions.ts:223`, but `lib/pdfs/esign.ts:156` decodes image data later. Helvetica at `:104` cannot represent many names; the failure was reproduced. Text at `:174` is drawn without fitting to its field; nonexistent pages are silently skipped at `:108`. Sender controls at `components/esign/esign-document-viewer.tsx:599`, `:618`, `:641`, `:661` advertise font, signature style and date format settings that execution does not honor.

Validate image format/size and PDF page bounds before acceptance, embed suitable Unicode fonts, and fit/wrap text without obscuring contract content. Preview, signing and execution must consume the same supported metadata. Test long text, non-Latin names, malformed images, page geometry and final visual output. Remove unsupported editor controls until they work.

### 06 — Treat delivery as durable work

Evidence: `lib/services/mailer.ts:201`/`:206` return false on failures. Automatic reminders at `app/api/jobs/esign/route.ts:119` ignore it and record sent at `:125`; executed-copy delivery at `app/api/jobs/process-outbox/route.ts:891` also ignores it. Next-signer email at `app/d/[token]/actions.ts:639` follows the same pattern. The shared initial-delivery helper does check the boolean, so this is inconsistent, not absent everywhere.

`lib/services/signature-delivery.ts:21` and reminder cron `:28` replace the sole token hash before delivery. Thus a reminder invalidates the original invitation and an open session, including when the replacement email fails.

Use durable, idempotent delivery jobs, propagate unsuccessful sends, and retain existing invitation validity until explicit revocation/expiry. Record delivery attempts independently of recipient signing state. Later, ingest provider delivery/bounce events and expose actionable failures to senders.

### 07 — Reconcile business effects independently of envelope completion

Evidence: `lib/services/change-orders.ts:1218` returns early once the matching envelope has approved the change order. Approval is written at `:1288` before executed-file attachment at `:1298`, budget posting at `:1309`, and SOV work at `:1332`. A failure after approval is therefore not repaired by retrying.

Use a transaction where possible and idempotent, independently recorded effects elsewhere. Already-approved must not mean all required work completed. Test interruption after each stage and verify exactly one budget/SOV impact and the correct executed attachment. This is especially important to Arc's promise: a signed change order must agree with the project's financial state.

### 08 — Consolidate estimate countersigning onto the same lifecycle

Evidence: the public page routes estimates to a separate client at `app/d/[token]/page.tsx:246`. `lib/services/estimate-portal.ts:2449` inserts signatures directly, then marks the request signed at `:2485`; document/envelope writes at `:2498`/`:2503` are unchecked and estimate execution comes later at `:2543`. An already-signed request is rejected at `:2377`. Certificate generation at `:972`–`:991` deliberately falls back to the base PDF.

Keep the tailored estimate presentation but share acceptance, evidence and finalization guarantees. Preserve accepted signatures when rendering fails and show processing/recovery state. Do not silently downgrade the evidence of an artifact labeled executed.

### 09 — Fix the main-page project selection

Evidence: `components/esign/signatures-hub-client.tsx:409` resets project selection whenever it changes in organization scope, used by `app/(app)/signatures/page.tsx:23`. Bulk send requires that value at `:715`; the wizard receives it at `:1092` and rejects missing standalone project context at `components/esign/envelope-wizard.tsx:1388`.

Separate initialization from user selection. Verify project selection through both standalone packet preparation and bulk sending. Linked records can carry their own project and should not be assumed equally blocked.

### 10 — Let signers see what they are signing

Evidence: `app/d/[token]/components/pdf-field-viewer.tsx:177` shows prior recipients' non-signature fields as labels/checkmarks instead of values. `:295` does the same for the current signer's inactive completed fields. `components/review-step.tsx:60` supplies a completion message, not a value summary.

Show actual values in all completed overlays, including prior recipients' values, and provide review matching the executed PDF. A green checkmark establishes completion, not informed review.

### 11 — Bind consent and source bytes to the signing session

Evidence: `app/d/[token]/actions.ts:116` only checks submitted consent text is nonempty, then `:270` stores it while claiming a fixed version at `:243`. Presentation time at `:244` is actually submission time. Source bytes are first hashed at finalization (`:379`–`:384`).

Own consent text/version on the server, require explicit acceptance of that version, and record presentation separately. Freeze source object/version/hash at sending and bind each acceptance to that hash. This strengthens the evidence record; it is not a claim about legal validity.

### 12 — Apply revocation consistently to file access

Evidence: `app/d/[token]/file/route.ts:51` selects expiration but not status; it serves the source after checking expiry at `:78`. `app/(app)/signatures/actions.ts:2897` voids active requests without replacing their token hashes. The landing page blocks voided requests, but the file endpoint does not.

Enforce one shared token-access policy on page, submission and file paths, with explicit distinctions for completed-party access. Test revoked and expired tokens against each endpoint.

### 13 — Establish real engine verification

The inspected tests do not directly exercise general signature submission, the atomic SQL function, PDF execution, automatic reminders or concurrent finalization. `tests/waiver-self-signing.test.js:57` mocks the submission action. The inspected `e2e` directory has navigation coverage rather than signing-flow coverage.

Add isolated DB concurrency/authorization tests, deterministic PDF fixtures, and browser tests from invitation through final download. Required failures: duplicate submission, concurrent recipients, decline/void versus signing, invalid fields, expired tokens, provider failure, storage failure and downstream retry. This suite is a prerequisite for the lifecycle refactor, not a request for indiscriminate coverage.

### 14 — Preserve progress and make review accessible

Evidence: `components/esign/envelope-wizard.tsx:803` clears unsaved placement state on close. `app/d/[token]/document-signing-client.tsx:62` keeps unsigned field progress only in component state. `components/pdf-field-viewer.tsx:145` disables PDF text and annotation layers; checkbox buttons at `:220` lack named checkbox semantics and active inputs at `:258` lack associated labels.

Add dirty-state protection/autosave for preparation, securely scoped unsigned save/resume for recipients, and a readable accessible document path with named controls. Verify keyboard and screen-reader review rather than treating keyboard field navigation as sufficient. Progress persistence needs clear retention and ownership rules.

### 15 — Remove silent history and reminder caps

Evidence: `app/(app)/signatures/actions.ts:2376` and `:2384` cap history/drafts at 500; `components/esign/signatures-hub-client.tsx:423` searches only those returned rows. Reminder cron at `app/api/jobs/esign/route.ts:44` takes an unordered 250 open envelopes across organizations, then filters enabled reminders at `:51`.

Use server-side search/pagination and independent counts. Schedule reminder-enabled due work directly with stable order, claiming and fair pagination. Verify older agreement retrieval and more than 250 open envelopes with mixed reminder settings.

### 16 — Make bulk-send outcomes actionable

Evidence: `components/esign/signatures-hub-client.tsx:700` splits comma-separated lines and discards rows without an `@`; `:736` reports aggregate results and closes the dialog. Invalid or failed recipients can disappear from the sender's workflow.

Preview every row with validation, parse supported CSV correctly, persist per-recipient results, and retry failed rows with stable operation identities. Fix project selection first. Avoid adding bulk scale before safe retries exist.

## Missing capabilities to prioritize separately

These are product choices, distinct from defects. Docusign's published [feature overview](https://www.docusign.com/products/electronic-signature/features) describes authentication choices, tamper-evident documents, completion certificates, routing and reminders. Arc should prioritize the subset its construction customers actually need rather than recreate the entire suite.

1. **Trust and portable evidence — essential replacement work, L.** Add configurable recipient authentication such as access codes or OTP for sensitive agreements, server-owned consent, frozen source evidence, and independently verifiable artifact integrity. Current generic submission accepts an identity mismatch and merely records it (`app/d/[token]/actions.ts:248`); the certificate is ordinary PDF text (`lib/pdfs/esign.ts:184`), with no digital seal/verification flow found. Design PDF sealing, key custody, timestamps and evidence export deliberately. Identity assurance should be configurable by agreement risk. This does not imply every agreement requires government-ID verification.
2. **Sender correction and operational control — essential, M–L.** Add auditable correction of recipient email/name, controlled reassignment, delivery/bounce visibility, recovery actions and custom subject/message. The wizard sends no subject/message (`components/esign/envelope-wizard.tsx:1329`) despite schema support (`lib/validation/documents.ts:99`). Existing void/new-copy is useful but costly for a simple typo. Define which changes preserve signatures and which require a new version. Grow templates into a managed library with editing, versions and clear recipient roles.
3. **Complete, resilient signing experience — essential, L.** Faithful preview/review, saved progress, accessible fields/document review, Unicode, and robust mobile interruption recovery come before ornamental polish. Named multi-document packets would preserve boundaries currently lost by merging uploads into one PDF; prioritize when real contract/exhibit workflows need separate management and downloads.
4. **Construction-specific forms and routing — customer-driven next stage, L.** The model has six field types and signer/CC roles (`lib/validation/documents.ts:32`, `:111`); the wizard offers fully serial or fully parallel signing (`components/esign/envelope-wizard.tsx:1300`). Inventory actual customer packets before adding dropdown/radio fields, validated amounts/email, conditional fields, signer attachments, approval-only recipients, or mixed routing. Focus on contracts/exhibits, subcontracts, change orders, waivers and buyer agreements. This is where native Arc context can provide more value than generic DocuSign parity.

Defer broad CLM, public form builders, advanced identity checks for every document, notary features and a large external integration marketplace until validated demand. They do not solve the current reliability issues.

## Recommended order and acceptance standard

1. Characterize the current engine and add failing regression tests; fix field ownership, evidence write authorization, and sent-revision immutability. The main-page selection and delivery-result fixes can land as small independent changes.
2. Build durable envelope execution/routing and delivery, then move estimate countersigning onto those guarantees. Domain effects must reconcile independently before financial automation is considered reliable.
3. Repair PDF fidelity, consent/source evidence, signer review, accessibility and saved progress. Define the portable evidence/sealing standard in parallel, but implement it over immutable artifacts.
4. Add correction, delivery recovery, managed templates, searchable history and trustworthy bulk operations; expand fields/routing based on representative customer packets.

Replacement-readiness requires a realistic multi-party packet to survive duplicate clicks, concurrent signatures, a closed browser, email/storage outages and worker retries; produce one correct executed artifact; deliver recoverable copies; and update the related business record exactly once. An authorized signer must not alter anyone else's fields, and ordinary application users must not rewrite signing evidence. The sender must be able to find older agreements and resolve a wrong email or delivery failure.

## Findings considered and rejected or qualified

- Missing templates, reminders, decline, offline copies, multiple signers or completion certificates: rejected; these exist, although some need hardening.
- All signing email failures are ignored: rejected; the shared initial-delivery helper checks failure, but cron/next-signer/completed-copy paths do not consistently do so.
- No atomic signature protection: rejected for general request consumption; the gap is subsequent execution/routing and the alternate estimate path.
- Missing source-PDF integrity solely because a hash is absent: qualified; hashes exist, but are computed late and stored without the independently verifiable sealing flow described above.
- Proven deployed RLS vulnerability or legal noncompliance: not claimed; deployed policies and jurisdiction-specific requirements were not verified.
- Full DocuSign feature parity as the immediate roadmap: rejected; prioritize trustworthy native construction workflows.

## Implementation follow-through — October 3, 2026

The implementation now addresses the sixteen concrete findings above, with regression coverage. Core changes: server-owned field values/consent; frozen source bytes before display; immutable signature evidence and issued lifecycle state; transactional acceptance, routing, cancellation and offline execution; leased, retryable PDF publication; durable invitations/reminders/copies; stable links and corrected-recipient revocation; resumable domain effects; Unicode and rotated/cropped PDF support; visible populated fields and final review; opt-in unsigned session recovery; bounded history pagination and CSV retry reservations.

Sender capabilities added include subject/message, mixed routing stages, recipient access codes, correction, execution retry, delivery status, template rename/archive, pre-send review and portable evidence downloads. Native estimate signing uses persisted evidence and the issued PDF; the legacy consent-bypassing countersign helper is disabled.

### Deployment gates

No production data was changed, migration applied, key provisioned, or real invitation sent. Apply the e-sign migrations in timestamp order through the normal approved release process; deploy application and worker code together after schema readiness. Other migrations in this dirty workspace belong to separate work: do not use a blanket migration push.

- `20261003004822_esign_durable_execution_and_evidence.sql`: atomic lifecycle, immutable evidence, client mutation guards, leases, routing, access attempts, offline publication.
- `20261003010417_esign_template_reservations.sql`: retry-safe bulk reservations and template archive state.
- `20261003010841_esign_delivery_observability.sql`: provider acceptance, delivery event reconciliation, manual reminder receipts.
- `20261003013101_esign_atomic_resend.sql`: atomic replacement envelopes retaining old evidence, with fresh expiry and duplicate-resend protection.

Keep existing signing/outbox cron schedules operational and monitor failed outbox jobs after release. Configure the existing authenticated Resend webhook endpoint to also receive `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, and `email.failed`. Without subscriptions, delivery tracking stops at provider acceptance.

`ESIGN_EVIDENCE_PRIVATE_KEY_PEM` is optional Ed25519 PKCS#8 PEM (escaped newlines supported). Provision it through secret management, retain historical public keys, and publish their fingerprints through an independent trusted channel. Without a key, exports truthfully identify unsigned manifests. The portable JSON signature is an application signature, **not** an Adobe-trusted PDF seal, qualified signature, or trusted timestamp.

Before production rollout, verify one isolated QA-org flow from invitation through concurrent signing, PDF download, corrected email, access code, bounce and worker retry. No authenticated browser journey against the production-backed local environment was attempted. Legacy in-flight documents with accepted signatures but no frozen source fail closed and need a sender-created replacement; existing historical downloads remain available.

### Scope still outside this implementation

The customer-driven expansion ideas remain distinct work: named multi-document packets, conditional/radio/dropdown fields, signer attachments, approval-only recipients, template version history, SMS/OTP or identity-provider verification, and qualified PDF sealing/timestamp custody. This implementation is not a claim of complete DocuSign parity or jurisdiction-specific legal certification. Access codes, mixed-stage routing, validated email/number text fields, template management and signed evidence manifests cover the concrete replacement essentials implemented here.


### Verification record

- Focused e-sign and related waiver tests: 102 passed at the final integrated run (real PGlite migrations/lifecycle, PDF rendering, worker failures/retries, access proof, delivery correction races, bulk reservations and React review helpers).
- `pnpm typecheck`: passed after integration; earlier unrelated accounting type error was resolved elsewhere in the shared workspace.
- Scoped ESLint for e-sign routes, services, UI and tests: passed.
- `pnpm test:bun`: 121 passed, zero failures.
- Whole-repository Node test run: four failures outside this change, in payment notification coverage for concurrent document migrations, document upload permission guardrail, purchasing pagination, and window-jamb geometry. Whole-repository lint reported 24 existing/concurrent mobile `module` variable rule violations. These are not represented as passing checks.
- No production-backed authenticated browser mutations, migration deployment, or CI-only build was run. PDF output was raster-reviewed locally; browser/mobile acceptance remains a rollout gate.
