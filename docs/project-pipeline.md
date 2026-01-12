 Here’s a streamlined contract pipeline for a builder using what’s now in place:

  - Capture the project: create the project (status planning/bidding), add client contact
    and location via Project Settings.
  - Estimate → Proposal: build estimate, generate/send proposal to the client (existing
    flow).
  - Proposal acceptance → Contract: when a proposal is accepted, the system auto-creates
    the contract record (per lib/services/proposals.ts), including snapshot, retainage
    settings, etc.
  - Sharing for client review/signature: use Sharing sheet to generate a client portal
    link; client reviews proposal/contract and signs (existing proposal signing; contract
    viewing now available via Financials → View Contract).
  - Contract visibility: Financials tab shows contract summary; Contract Detail Sheet
    shows terms and signature data.
  - Payment structure: create draw schedule (manual today) and track retainage; Financials
    tab surfaces draws/retainage status.
  - Post-signature: project team + directory (subs/vendors) added under Team; portal
    tokens can be issued for clients/subs.