# Arc Unified E‑Signature System Gameplan (BYO‑Docs Only, LLM‑Optimized)

Goal: **One signing system** in Arc. Every signature (proposals, change orders, waivers, etc.) routes through the **BYO‑Docs e‑sign portal** (`/d/[token]`) and produces an **executed PDF** + audit trail.

This gameplan is written so we can implement it incrementally without breaking existing workflows.

Related foundation doc (already implemented in repo): `docs/esign-byo-docs-gameplan.md`.

---

## 0) North Star (Product + Systems)

### 0.1 What users should feel
- Builders can click **Request signature** anywhere (Proposal, Change Order, Waiver, etc.) and get the **same** recipient/routing/field‑placement/send/status experience.
- Clients always sign in **one portal** with consistent UI + trust signals.
- The output is always the same: **executed signed PDF** stored in Arc + downloadable + auditable.

### 0.2 Core principles
- **Single signing portal**: `/d/[token]` is the only place external signers can sign.
- **Executed PDF is the artifact of record** (not an interactive UI state).
- **Envelope is first‑class** (send instance, routing, reminders, audit, void/resend history).
- **Org‑scoped, RLS‑safe**: every record is `org_id` scoped and guarded.
- **Contextual start, centralized management**:
  - Start from the page you’re on (Proposal, CO, etc.).
  - Manage from a central “Documents / Signatures” hub (project + org queue).

---

## 1) Terms (keep these consistent)

- **Signable (Entity)**: the business object that needs signature (proposal, change order, lien waiver, selection approval, subcontract agreement, closeout, etc.).
- **Document**: the PDF to be signed + its field placement layout (already: `documents`, `document_fields`).
- **Envelope**: one “send attempt” of a document to recipients with routing rules (new).
- **Recipient**: a person receiving the envelope (external email/contact OR internal org user).
- **Signing Request / Session**: the tokenized link and the signer’s current status (sent/viewed/signed/etc.).
- **Executed PDF**: flattened/stamped output PDF generated when the envelope is fully executed.

---

## 2) Current State (Repo Reality, why we’re changing)

You currently have **three parallel signature capture flows**:

1) **Legacy Proposal Portal** (`/proposal/[token]`)
   - Interactive review + canvas signature capture.
2) **Legacy Change Order Approval Portal** (`/p/[token]/change-orders/[id]`)
   - Approval + canvas signature capture (writes `approvals`).
3) **BYO‑Docs E‑Sign** (`/d/[token]`)
   - Field placement + multi‑signer routing + executed PDF.

Problems:
- Fragmented UX and inconsistent “what counts as signed”.
- Multiple token systems (`PROPOSAL_SECRET` vs `DOCUMENT_SIGNING_SECRET`).
- Legacy signature pad can “emit” a blank PNG on mount (signature can be accidentally “present” without user drawing).
- No first‑class envelope object (group/routing is implicit).

---

## 3) Target Architecture (what we’re building)

### 3.1 Canonical flow (for every signable)
1) Builder generates or uploads a **source PDF** for the signable.
2) Builder opens **Envelope Wizard** (sheet/modal) to:
   - Configure recipients + routing (including optional builder countersign).
   - Place fields (signature/name/date/initials/checkbox/text).
   - Send.
3) Recipients sign only via `/d/[token]`.
4) When all required recipients sign:
   - Generate executed PDF.
   - Store executed PDF in Arc.
   - Update signable business state (proposal accepted, CO approved, waiver signed, etc.).

### 3.2 The missing object: `envelopes`
The envelope sits between “document template/layout” and “signing sessions”.

Envelope responsibilities:
- Who signs + order + required vs optional.
- Message/subject + reminders + expiry.
- Status progression: `draft` → `sent` → `partially_signed` → `executed` (or `voided`/`expired`).
- Canonical audit trail for the send attempt.
- Decouples “document” from multiple send attempts (resend/void/re‑send becomes manageable).

---

## 4) Phased Implementation Plan (do in this order)

### Phase 0 — Lock decisions + acceptance criteria
Decide and document:
- Recipients can be **external** (email/contact) and **internal** (org user) for countersign.
- “Sign completion” event that drives business logic:
  - Proposal: executed envelope triggers “accepted/contract created”.
  - CO: executed envelope triggers “approved”.
  - Waiver: executed envelope triggers “signed”.
- We will eliminate legacy signature capture UIs (proposal portal + CO portal) after migration.

Acceptance criteria:
- Team agrees on “executed PDF is the artifact of record”.
- Team agrees on envelope semantics (draft/resend/void/expiry).

Phase 0 implementation log (2026-02-07):
- Added shared code contracts for unified e-sign semantics in `lib/esign/unified-contracts.ts`.
- Added rollout guard via org feature flag `unified_esign` in `lib/services/feature-flags.ts`.
- Added canonical lifecycle event instrumentation (`envelope_*`, `recipient_signed`) through `lib/services/esign-events.ts`.
- Added DB migrations:
  - `supabase/migrations/20260207032238_esign_phase0_contracts.sql`
  - `supabase/migrations/20260207032345_esign_phase0_search_path_fix.sql`
- Applied in Supabase production project (`gzlfiskfkvqgpzqldnwk`) via MCP on 2026-02-07.

---

### Phase 1 — Add first‑class Envelope model (DB + services)
**Objective:** represent envelope send attempts explicitly (org‑scoped).

DB changes (conceptual; implement via Supabase migrations):
- `envelopes`
  - `id uuid pk`
  - `org_id`, `project_id`
  - `document_id`, `document_revision`
  - `source_entity_type text` + `source_entity_id uuid` (or normalized link table; see below)
  - `status text` (`draft`, `sent`, `executed`, `voided`, `expired`)
  - `message`, `subject`, `expires_at`
  - `created_by`, `created_at`, `updated_at`, `sent_at`, `executed_at`, `voided_at`
  - `metadata jsonb`
- `envelope_recipients`
  - `id uuid pk`
  - `org_id`, `envelope_id`
  - `recipient_type text` (`external_email`, `contact`, `internal_user`)
  - `contact_id uuid null`, `user_id uuid null`
  - `name text`, `email citext`
  - `role text` (`signer`, `cc`)
  - `signer_role text` (field filtering key; still useful for layouts)
  - `sequence int`, `required boolean`
  - `created_at`
- Refactor `document_signing_requests` to reference envelope recipient:
  - add `envelope_id uuid`, `envelope_recipient_id uuid`
  - stop relying on `group_id` as “proto-envelope” long‑term
- Optional but recommended: `envelope_events` (append‑only audit stream)

Linking strategy (pick one and standardize):
- **Option A (simple):** `envelopes.source_entity_type + source_entity_id` (polymorphic).
- **Option B (normalized):** `signable_documents` link table with `entity_type/entity_id/document_id/purpose`.

Acceptance criteria:
- Envelope can exist without sending (draft).
- Envelope can have multiple recipients with sequence and required flags.
- Signing requests can be traced to a specific envelope and recipient (no ambiguity).

Phase 1 implementation log (2026-02-07):
- Added DB migration `supabase/migrations/20260207033345_esign_phase1_envelopes.sql`.
  - Created `envelopes`, `envelope_recipients`, and `envelope_events`.
  - Added `document_signing_requests.envelope_id` and `document_signing_requests.envelope_recipient_id`.
  - Backfilled existing signing groups/requests into first-class envelope records.
  - Applied in Supabase production project (`gzlfiskfkvqgpzqldnwk`) via MCP.
- Added envelope service layer in `lib/services/envelopes.ts`:
  - `ensureDraftEnvelopeForDocument()`
  - `replaceEnvelopeRecipients()`
  - `createEnvelopeSigningRequests()`
- Refactored BYO-docs flows to use envelope IDs while preserving legacy `group_id` fallback:
  - `app/(app)/documents/actions.ts`
  - `app/d/[token]/actions.ts`
  - `app/d/[token]/page.tsx`

---

### Phase 2 — Extract a reusable “Envelope Wizard” UI (summon anywhere)
**Objective:** one sheet/modal that any page can open to create/manage an envelope.

Wizard steps (recommended):
1) **Recipients** (add, ordering, required, internal vs external, countersign toggle)
2) **Fields** (open the PDF field placement viewer)
3) **Review & Send** (subject/message/expiry + send)
4) **Status** (sent/viewed/signed + reminders + void/resend + executed download)

Implementation design rules:
- The wizard takes a single input: `sourceEntity` (type + id) and `project_id`.
- Wizard loads:
  - existing draft envelope if present (re‑enterable)
  - otherwise creates a draft envelope (document + envelope)
- Wizard is the only place to manage recipients/routing for signing.

Acceptance criteria:
- One component powers envelope creation for proposals and at least one more signable (CO or waiver) before expanding.
- The proposal UI no longer owns envelope logic (it only launches the wizard).

Phase 2 implementation log (2026-02-07):
- Extracted reusable envelope preparation component to `components/esign/envelope-wizard.tsx` (recipients, upload, field placement, send).
- Added generic source-entity draft APIs in `app/(app)/documents/actions.ts`:
  - `getSourceEntityDraftAction()`
  - `saveDocumentDraftEnvelopeAction()`
  - Preserved proposal wrappers (`getProposalDraftAction`, `saveProposalDraftEnvelopeAction`) for compatibility.
- Extended document creation contracts to persist explicit source links:
  - `lib/validation/documents.ts`
  - `lib/services/documents.ts`
  - `app/(app)/documents/actions.ts::createDocumentAction`
- Refactored proposals to launch the shared wizard (no proposal-owned envelope builder logic remains):
  - `components/proposals/proposals-client.tsx`
- Integrated the same wizard into change orders as the second signable entry point:
  - `components/change-orders/change-order-detail-sheet.tsx`

---

### Phase 3 — Canonicalize “Proposal signing” onto BYO‑Docs
**Objective:** proposals stop being “signed” in the interactive `/proposal/[token]` portal.

Recommended product behavior:
- Proposal page stays interactive for drafting internally.
- When builder clicks **Request signature**:
  - Generate the **canonical proposal/contract PDF** (source PDF).
  - Create/update the linked `documents` record.
  - Launch the Envelope Wizard to place fields and send.
- When envelope executes:
  - Update proposal status (e.g. `accepted`) and record signer identity.
  - Create the `contracts` row based on the executed document (and attach executed PDF/file id).

Acceptance criteria:
- No signatures are captured in the legacy proposal portal.
- Proposal acceptance is driven by executed envelope completion.
- Clients sign via `/d/[token]` only.

Phase 3 implementation log (2026-02-07):
- Canonicalized proposal acceptance to execute from BYO-doc signing completion:
  - `app/d/[token]/actions.ts` now triggers proposal-domain acceptance when an executed envelope belongs to a proposal.
  - Added envelope status transitions (`sent`/`partially_signed`/`executed`) in the same signing flow.
- Added idempotent proposal acceptance service for envelope execution:
  - `lib/services/proposals.ts::acceptProposalFromEnvelopeExecution()`
  - Reused a shared acceptance finalizer that:
    - updates proposal status to `accepted`,
    - creates or refreshes the `contracts` row,
    - attaches executed PDF to contract via `file_links` (`link_role = executed_contract`),
    - preserves/extends acceptance event payload with envelope/document provenance.
- Converted legacy proposal portal to view-only with secure-signing CTA:
  - `app/proposal/[token]/page.tsx` now exposes a continuation CTA only when an active signer request exists.
  - `app/proposal/[token]/continue/route.ts` issues the secure `/d/[token]` link on click and redirects to BYO signing.
  - `app/proposal/[token]/proposal-view-client.tsx` removed signature capture UI and now points users to secure signing.
  - `app/proposal/[token]/actions.ts` no longer accepts signatures and explicitly rejects legacy submit attempts.

---

### Phase 4 — Canonicalize “Change Order approval/signature” onto BYO‑Docs
**Objective:** change orders stop using signature pad in `/p/[token]/change-orders/[id]`.

Recommended behavior:
- The CO portal (if you keep a general client portal) can show CO details, but “Approve & Sign” routes to `/d/[token]`.
- When envelope executes:
  - CO status becomes `approved`.
  - Create an `approvals` record (optional) as a derived business event, with envelope/document references in payload for traceability.

Acceptance criteria:
- CO signatures are recorded as envelope signatures (executed PDF exists).
- CO approval status is consistent and auditable.

Phase 4 implementation log (2026-02-07):
- Canonicalized change-order completion from BYO signing execution:
  - `app/d/[token]/actions.ts` now calls change-order domain approval when an executed envelope belongs to a `change_order`.
  - `lib/services/change-orders.ts::approveChangeOrderFromEnvelopeExecution()` added as an idempotent approval bridge.
- Change-order approval bridge behavior:
  - sets `change_orders.status = approved` (if not already),
  - writes envelope provenance in metadata (`approved_envelope_id`, `approved_document_id`, `approved_executed_file_id`),
  - inserts derived `approvals` record for envelope-based approval transitions,
  - applies financial impact updates,
  - links executed PDF to change order via `file_links` (`link_role = executed_change_order`).
- Converted legacy change-order portal signature capture to secure-signing redirect:
  - `app/p/[token]/change-orders/[id]/approval-client.tsx` is now view-only + “Continue to secure signing” CTA.
  - `app/p/[token]/change-orders/[id]/page.tsx` now enables CTA only when an active signer request exists.
  - `app/p/[token]/change-orders/[id]/continue/route.ts` issues `/d/[token]` link on click and redirects.
  - `app/p/[token]/change-orders/[id]/actions.ts` rejects legacy signature submissions.

---

### Phase 5 — Add the next signables (waivers, selections, subcontract docs, closeout)
**Objective:** expand the same envelope wizard + signing portal to other signables.

Suggested order (highest ROI):
1) **Lien waivers** (already signature‑shaped in schema; converge tokens + executed PDFs)
2) **Selections approvals** (high‑frequency, lightweight)
3) **Subcontractor agreements / POs** (external company signers)
4) **Closeout + warranty acceptance**

Each signable must define:
- Source PDF generation strategy
  - Upload BYO PDF OR generate PDF from Arc data
- Who signs (roles + countersign rules)
- What “executed” triggers in the business domain

Acceptance criteria:
- At least one non‑proposal/non‑CO signable fully migrated end‑to‑end.

Phase 5 implementation log (2026-02-07):
- Added DB migration `supabase/migrations/20260207113000_esign_phase5_selection_metadata.sql`.
  - Added `project_selections.metadata jsonb not null default '{}'::jsonb` for envelope execution provenance.
  - Applied in Supabase production project (`gzlfiskfkvqgpzqldnwk`) via MCP.
- Added selection-domain envelope execution bridge:
  - `lib/services/selections.ts::confirmSelectionFromEnvelopeExecution()`
  - idempotent confirmation handling, status transition to `confirmed`, provenance metadata write, executed PDF linkage via `file_links` (`link_role = executed_selection`), and domain event emission.
- Wired `/d` envelope completion to selection business state:
  - `app/d/[token]/actions.ts` now detects `selection` source entities and invokes the selection confirmation bridge when envelopes execute.
- Added builder entry point for selection signatures:
  - `components/selections/selections-client.tsx` now exposes **Request signature** per selection and launches the shared `EnvelopeWizard` with `sourceEntity.type = "selection"`.

---

### Phase 6 — Add centralized “Documents / Signatures” hub (management + queue)
**Objective:** a single place to manage all envelopes.

Views:
- Org‑level queue: “Waiting on client”, “Executed this week”, “Expiring soon”.
- Project‑level: all documents + envelopes for the project (history, downloads, audit).

Actions:
- remind next active signer
- void envelope
- resend (new envelope instance, preserving document layout)
- download executed

Acceptance criteria:
- Builders can manage signing without hunting through proposal/CO pages.

Phase 6 implementation log (2026-02-07):
- Added centralized signatures hub actions in `app/(app)/documents/actions.ts`:
  - `listSignaturesHubAction()` (org/project queue + envelope progress summaries)
  - `voidEnvelopeAction()` (void + token invalidation + status sync)
  - `resendEnvelopeAction()` (new envelope instance with recipient copy + first-sequence dispatch)
  - `getEnvelopeExecutedDownloadUrlAction()` (executed PDF retrieval by envelope)
- Added org-level signatures hub page:
  - `app/(app)/documents/page.tsx`
  - unified queue view for “Waiting on client”, “Executed this week”, and “Expiring soon”.
- Replaced project document page with project-scoped signatures management:
  - `app/(app)/projects/[id]/documents/page.tsx`
  - now loads the same hub with project filtering.
- Added reusable signatures management UI:
  - `components/esign/signatures-hub-client.tsx`
  - supports reminder, void, resend, and executed download actions directly from queue rows.

---

### Phase 7 — Remove legacy signing portals + cleanup
**Objective:** delete/disable old signing entry points and consolidate secrets/tokens.

What to remove/retire (after migrations are stable):
- `/proposal/[token]` signature capture flow
- `/p/[token]/change-orders/[id]` signature capture flow
- `components/portal/signature-pad.tsx` usage for legal signatures

Token strategy:
- Standardize on `DOCUMENT_SIGNING_SECRET` for all public signing.
- Any remaining entity links should be “view only” and contain a CTA: “Continue to signing”.

Acceptance criteria:
- No production path captures signatures outside the BYO‑Docs signing portal.

Phase 7 implementation log (2026-02-07):
- Removed legacy signature submission endpoints:
  - `app/proposal/[token]/actions.ts`
  - `app/p/[token]/change-orders/[id]/actions.ts`
- Removed deprecated legal-signature UI component:
  - `components/portal/signature-pad.tsx`
- Removed legacy portal acceptance code paths in domain services:
  - `lib/services/proposals.ts::acceptProposal()`
  - `lib/services/change-orders.ts::approveChangeOrderFromPortal()`
- Retained public proposal/change-order pages only as view + “Continue to secure signing” entry points, with all signature execution constrained to `/d/[token]`.
- Consolidation status: `DOCUMENT_SIGNING_SECRET` is the only secret used for signing tokens; `PROPOSAL_SECRET` remains only for proposal view-link token resolution.

---

## 5) Required Capability Improvements (make the system defensible)

### 5.1 Certificate / audit artifact (recommended)
When generating executed PDFs, append or stamp a certificate containing:
- envelope id, document id, revision
- list of recipients + signer identities
- signed timestamps, signer IP, user agent (where available)
- hash of source PDF bytes
- hash of executed PDF bytes (optional but useful)

### 5.2 Freeze layout at send time
Rule:
- The envelope signs against a specific `document_revision`.
- If the PDF or fields change after sending, create a **new revision** and a **new envelope**.

### 5.3 Internal countersign UX
Support internal org members as signers:
- “Sign now” inside the app (authenticated) OR
- send an email link that still resolves to `/d/[token]` but is tied to an internal recipient record.

### 5.4 Void / resend rules
Define consistent semantics:
- Void kills the envelope and invalidates tokens.
- Resend creates a new envelope instance (history preserved).
- Reminder sends only to the “next active required signer(s)”.

---

## 6) Data + UX Contracts (standard payloads to reuse everywhere)

Standardize these payloads so every module uses the same shapes:
- `Recipient`: `{ type, name, email, contact_id?, user_id?, role, signer_role, sequence, required }`
- `Field`: `{ id, page_index, field_type, label?, required, signer_role, x, y, w, h, metadata? }`
- `SignatureSubmission`: `{ signerName, signerEmail?, consentText, values }`
- `EnvelopeStatus`: `{ envelope, recipients[], summary, executed_file_id?, next_required_sequence? }`

---

## 7) Rollout Strategy (minimize risk)

Recommended rollout mechanics:
- Feature flag: “Unified E‑Sign” (per org).
- Start with one pilot org.
- Instrument events:
  - envelope_created / envelope_sent / envelope_viewed / recipient_signed / envelope_executed / envelope_voided
- Add a kill switch to revert “Request signature” buttons back to legacy flows during rollout (temporary).

---

## 8) Definition of Done (Unified Signing)

You are “done” when:
- Every signable type uses the Envelope Wizard + `/d/[token]` for signatures.
- Every signature produces an executed PDF stored in Arc.
- Envelope history is visible and manageable from a hub.
- Countersign is supported (internal signer as last recipient).
- Legacy signing portals are removed or strictly view‑only with redirect to `/d`.
