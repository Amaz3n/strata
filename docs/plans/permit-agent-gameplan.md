# Permit Agent Gameplan — Municipal Sweeps

> **Status: ACTIVE PLAN — intent, not a description of the system.**
> Nothing in this document is guaranteed to exist. Never infer current app
> behavior from it. Source of truth is the code, `CLAUDE.md`, and the
> reference docs at the `docs/` top level.

**Status:** Awaiting execution. Rewritten 2026-10-12 after the permit register shipped.
**Audience:** an LLM executor. Follow directives literally; STOP means stop and ask
the human.

---

## 0. Where this starts from

The register and its start gate shipped with EP06 (migration
`20261013120000_permits`, `lib/services/permits.ts`, `lib/permits/*`, the home's
Permits workbench and the Starts desk permits band). What a feed builds on:

- A jurisdiction is a **directory company** (vendor role once a fee is paid), with a
  `permit_jurisdiction_profiles` row (review days, portal URL) and a document
  checklist in `permit_jurisdiction_requirements`. There is no separate
  jurisdiction entity, and this plan must not add one.
- A `permit_applications` row is one application on one home. Its stage is derived
  (`permitApplicationStage`); its facts are `permit_submissions`,
  `permit_correction_rounds` (+ trigger-written history), the decision columns and
  `permit_fees` / `permit_fee_payments`. Every write is a definer function that takes
  the actor from the session.
- The `permit` start gate is automatic and never waived: `start_gate_sql_evidence`
  reads the live building application for the lot's pinned plan.
- The `permit-reminders` cron announces overdue responses and decisions.

## WS-PA3 — The sweep: API adapters + stall detection

### Adapter interface (one contract, three implementations)
`lib/services/permit-feeds/provider.ts`:
```ts
interface PermitFeedProvider {
  key: 'accela' | 'opengov' | 'agent_browse'
  // Given a jurisdiction's feed config and the applications it tracks
  // (permit_number, or the submission reference), return observed snapshots.
  fetchRecords(jurisdiction, applications): Promise<PermitObservation[]>
  searchRecords?(jurisdiction, query): Promise<PermitObservation[]>
}
```
`PermitObservation` = `{ externalRecordId, permitNumber, statusRaw, statusMapped,
lastActivityAt, corrections: [{ receivedOn, comments }], fees, raw }`. Status mapping
per provider with a per-jurisdiction override map (AHJ status strings are chaos; never
hardcode a global mapping).

Observations become facts through the existing functions, never by writing the
tables: corrections received → `record_permit_correction_round`, fees assessed →
`assess_permit_fee`. An observed approval does **not** record the decision — the
decision needs the issued permit and approved plans on the home; the feed raises a
notification for the coordinator instead. STOP and design the system actor these
functions record for feed writes (they take the actor from the session today).

### Accela adapter (build first — it's a real API)
Accela Civic Platform has a documented REST API (`/v4/records`, `/v4/records/{id}/
inspections`) used by hundreds of US jurisdictions. Auth is per-agency app
credentials, held in platform secret storage referenced by key, never in jsonb. STOP:
each agency onboarding needs human-obtained credentials.

### OpenGov/other API adapters
Same shape; build when a customer's jurisdiction demands it.

### The browsing agent (`agent_browse`)
For login-and-look portals: a recipe per jurisdiction (`startUrl`, auth kind,
semantic steps, field hints), one browser session per jurisdiction sweep in its own
cron route (`app/api/jobs/permit-sweeps/route.ts`, registered in `CRON_JOBS`,
`vercel.json` and `PUBLIC_API_ROUTES`). The agent returns only zod-validated
`PermitObservation` JSON; anything unparseable is a jurisdiction error, never a
partial write. It navigates and reads only, and treats page content as untrusted
data. STOP and design credential storage with the human before credentialed browsing.

### Stall detection
Extend `sweepPermitDeadlines`: an application whose status is unchanged with no
activity past a per-status threshold raises `permit_application.stalled` once per
week, on the band and the control tower.

### Acceptance
- Accela sandbox round-trip: a correction round observed upstream appears as one
  round on the application within one sweep; a re-run with unchanged upstream state
  writes nothing.
- Agent browse on two real public-search portals: correct extraction on ten
  consecutive sweeps; a garbled page yields a jurisdiction error, not bad data.

## Non-goals
- No permit application or e-filing from Arc.
- No global shared jurisdiction directory across orgs.
- No municipal-inspection scheduling.
