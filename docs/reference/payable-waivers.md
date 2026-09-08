# Payable waiver integration

Incoming trade waivers live in Payables → Waivers and in each payable’s Waivers section.
The project sidebar exposes Payables; `/projects/[id]/financials/waivers` redirects
and preserves filters. The organization register honors the active desk’s project scope.

## Document lifecycle

1. Set the payable’s actual work-through date. Due dates are not coverage dates.
2. Choose a published incoming/both company template for the property state, or upload
   the original signed PDF. Invoice templates default to outgoing unless explicitly shared.
3. Record the contracting parties, property, claimant, signer authority, exceptions,
   explicit progress/final and conditional/unconditional type, and allocated amounts.
   Final and unconditional releases require separate attestations. Unconditional amounts
   cannot exceed recorded payment. Combined requests require one vendor, authorization
   for every project, and an embedded property/payment allocation schedule.
4. Native signing uses the existing document/envelope engine. Only its exact executed
   PDF can complete a waiver. Repeated callbacks do not reset a review. Signed files
   cannot be replaced; a correction creates a new request and preserves history.
5. A bill approver reviews the signed artifact. Signature and accepted payment coverage
   are separate. Offline uploads require the actual signature date and follow the same review.

`lib/lien-waivers/coverage.ts` owns the shared coverage calculation. The register,
bill detail, electronic/manual release gates, and post-payment chase use it. Coverage
checks amount and period; captured economic/party facts prevent reuse after changes.
A partial payment checks the requested amount. Overlapping documents are not summed.
Post-payment unconditional collection is visible separately from money currently held.

## Lower tiers and closeout

Claimant requirements are attached to a commitment, first-tier trade, and work period.
They remain visible before a bill exists. Carry-forward copies the roster, flags the
new amount for review, and never carries forward approval. Staff can edit amounts,
record PDFs, review, remind, and retire with a reason. Portal uploads preserve actual
signature dates and wait for review. Matching checks claimant, type, amount, and period.

Final readiness is derived from accepted unconditional final coverage and remaining
payment/retainage obligations. Closeout displays derived status; closing checks it
both when clearing and when settling. Combined final documents can cover multiple
bill allocations. Retainage release creates a pending payable and follows the normal
approval/conditional-waiver/payment path rather than requiring an unconditional
release before funds are received.

## Templates, exports, and legacy handling

The existing company template library supplies both billing directions. Templates have
applicability, property jurisdiction, immutable revision numbers, preview, import, and
publication review. AI extracts suggestions; it never supplies signature, receipt, or
coverage approval. Prepared documents capture the exact template and input.

The register defaults to all outstanding dates, paginates the visible rows, and computes
totals across the complete filtered scan. CSV export covers all results. PDF packets
include an index and accepted signed PDFs, deduplicated across allocations; drafts,
unreviewed documents, and rejected evidence are excluded. Large packets require narrower filters rather than silent truncation.

Manual “received” updates, generic typed-signature generation, offline evidence without
an original document, and the separate matrix/recording dialog are retired. Historical
PDFs remain available but require human review. Ambiguous legacy `final` records must
be replaced with an explicit type; migration never auto-approves them.

## Release and QA

Applied migration: `supabase/migrations/20260908015053_payable_waiver_lifecycle.sql`.
It expands kinds, preserves multiple document revisions per bill, adds preparation
idempotency/indexes, adds claimant review metadata, protects template revision numbers,
and updates the retainage-release RPC. **Applied to Arc production through Supabase MCP with explicit approval.**
The MCP ledger name is `20260908005314_payable_waiver_lifecycle`; its recorded
version is `20260908015053`, matching the renamed repository file. Constraints,
indexes, metadata, and RPC access were verified with read-only queries.
Authenticated workflow QA remains pending; no test customer records were created.

Before rollout, apply the reviewed migration in an authorized QA environment, publish
incoming templates for supported property jurisdictions, and run authenticated checks:

- Prepare → preview → vendor invitation → execute → review → partial/full payment.
- Upload a signed PDF; reject it, replace it, and accept the replacement.
- Verify changed amount, claimant, period, and reversed payment reinstate the correct hold.
- Prepare one trade’s combined lot waiver; verify each property allocation and permissions.
- Carry forward suppliers, review amounts, upload/review, and reconcile missing claimants.
- Release retainage, collect final evidence, and verify closeout and closing readiness.
- Export filtered CSV/PDF and verify exact signed artifacts, history, and totals.

Automated checks live in `tests/payable-waiver-coverage.test.js`,
`tests/payable-waiver-lifecycle.test.js`, and `tests/waiver-register.test.js`, alongside
the existing company-template, invoice-waiver, financial, and authorization suites.
