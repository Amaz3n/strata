# Native legal entities beneath an Arc organization

Status: architecture decision; implementation and upgrade acceptance incomplete.
Completion packages: B14.1–5, B07 and B00 in Plan 013.

The subsequent legacy review checkpoint adds immutable single-entity assignment
proposals and independent reviews, original document-byte checks in the service,
SQL source population/recheck provenance and schema 19 archive/recovery support.
These are reviewed intents; `approvedForLedgerActivation` remains false. The
entity administration/review workspace and verified frozen-original downloads
are now implemented with scoped SQL/service/route verification. Authenticated
browser acceptance, actual source-to-ledger ownership, separate native
charts/calendars/banks and native concurrency/full upgrade acceptance remain
unfinished. See `docs/books-legacy-ownership-preparation.md` for the current
operation and its scope/capacity limits.

The October 4 legacy preparation checkpoint adds an offline, unreviewed complete
archive population inventory. See `docs/books-legacy-ownership-preparation.md`.
It pins every retained row without assigning an owner or activating a ledger.
Independent ownership proposals and transactional approval were added by the
subsequent schema 19 checkpoint; no source ownership has been committed.
The checkpoint also fixes bigint audit identities in actual export capture;
original numeric database identities survive JSON transport and scoped SQL
restoration without JavaScript rounding. Native full-schema proof remains pending.

An organization is the collaboration and tenant boundary. A legal entity is the
owner of a separate USD ledger beneath that organization. A company record is a
customer/vendor counterparty; an accounting connection is an external transport.
Neither can substitute for the native legal-entity identifier.

The current schema proves why this change is necessary. The Books foundation
(`20260801143926`) makes settings unique by organization, periods unique by
organization/date and journals unique by organization/posting key. Facts and
accounts likewise use organization-scoped identities. Journal-line `company_id`
points to counterparties. The existing `accounting_entity_map` (`20260719011920`)
requires an external connection and maps project/community/division routing. It
does not own native periods, accounts, bank controls or close state. The dimension
loader currently freezes organization/division and unambiguous lot/contract
relationships; it does not establish legal-entity ownership.

One native `legal_entity_id` must follow source, effective ownership version,
fact, journal, accounts, control subledger, funding account, period, statement and
export. Organization remains mandatory on every relationship. Composite foreign
keys must enforce same organization/entity; application authorization additionally
requires entity membership and existing project/division permissions. A shared
organization accountant does not automatically receive every entity's salary or
tax evidence. Maker/checker remains enforced server-side.

Each entity owns its reviewed legal identity, functional currency (USD for this
scope), fiscal calendar, chart/control mappings, tax registrations, banks,
opening balances and official-ledger activation. Entity-specific account codes
and period dates may repeat across entities. Shared directory and construction
collaboration remain organization-wide where permitted. Source workflows display
the owning entity; changing ownership after money exists requires a governed
correction and explicit signed legs, rather than updating historical dimensions.

Every monetary source has one owner. Multi-entity payroll/shared costs are split
into explicit reviewed entity legs before posting, with provider-wide controls
conserved and each bank debit assigned to its actual entity. A source cannot
select an entity through row order, a vendor's `company_id`, an external provider
label or a mutable current project assignment. Reversals and committed retries
inherit the original ownership and receipt.

Intercompany is one reviewed commercial intent linking reciprocal entity journals.
For ledgers in this database, post both sides in one transaction while holding
both entity/period fences in deterministic order. Due-to/due-from and settlements
retain counterparty entity and cutoff ownership. A failed leg cannot be displayed
as a completed pair. Independently reviewed consolidation uses effective group
membership, account mappings and reporting-only eliminations; it never mutates
standalone ledgers or equates summing balances with consolidation.

Legacy ownership is unknown until reviewed. Existing organizations are not
silently relabeled as a legal entity, and provider routing is evidence rather
than a definitive assignment. Migration first inventories the retained ledger
and sources, prepares an explicit default-entity ownership proposal with original
supporting evidence and cutoff, and requires separate approval. The upgrade must
prove balance, source, period, archive and historical-retry conservation before
switching the organization from its legacy single-ledger contract. Ambiguous
multi-entity history receives reviewed allocations and signed corrections. No
second native ledger is advertised as usable before every applicable writer and
reader is entity-aware.

Implementation order:

1. Accept the current isolated schema and preserve a populated upgrade baseline.
2. Add the entity registry, membership and immutable reviewed ownership versions;
   inventory every monetary source and document the required dimension matrix.
3. Add same-entity account/period/bank/source/fact/journal/control relationships,
   migrate uniqueness and fence keys, and prepare/approve legacy assignments.
4. Integrate source workflows, projection, close, reports, payroll, taxes, exports
   and restoration. Verify independent calendars and cross-entity denial.
5. Add reciprocal intents, reconciliation, group membership/eliminations and
   consolidated frozen reports; prove populated upgrade and restored operation.

ENTITY-01, INTERCO-01, CONSOL-01, DIM-01, AUTH-01, RACE-01 and RESTORE-01 must pass
on the current application schema and authenticated workflows. This decision does
not claim any of those scenarios passed, approve legacy ownership, or authorize
production migration. Plan 013's global DoD and G1–G7 remain the finish line.

## Registry implementation checkpoint

The pending migration `20261004170526_books_native_legal_entity_registry.sql`
and `lib/services/books/legal-entities.ts` implement the native setup registry.
No existing organization, project, fact or journal is assigned an entity. Registry
rows remain `setup`; the schema forbids advertising an active ledger. This lets
identity preparation proceed while native replay is unavailable without making
an organization-scoped ledger appear separated.

An entity has an immutable organization/ID/code/creator and explicit membership.
Read, prepare, review and manage grants are separate. Each access change retains
actor, prior/new access, notes and time; revocation preserves history and the last
active manager cannot be removed. Active organization membership is also required.
Organization Books access alone never grants another entity's setup data.

Legal name/form, USD functional currency, recurring fiscal start, effective date,
identity evidence and preparation notes are frozen in revisions. A distinct
active entity reviewer approves the exact revision. Entity-row locks serialize
membership, preparation and approval; stale predecessor branches cannot replace
the reviewed identity. Frozen preparation/approval retries return their original
receipt after newer revisions. The service separately checks organization Books
permission and the identities and contents of returned receipts. Private invoker
RPCs and tables are inaccessible to browser roles.

Eight SQL/service tests pass against a disposable PostgreSQL-compatible fixture
that executes the complete new migration. These are scoped registry proofs,
not native current-schema, populated upgrade, concurrent-session or authenticated
application acceptance. The new pgTAP file adds 18 checks for grants, invoker
functions, RLS, composite lineage and setup/currency constraints; native execution
remains pending.

The current writer inventory establishes the remaining ownership work:

| Boundary                       | Current owner contract                                                                                                                        | Required next integration                                                                                                                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Billing/receivables            | Organization/project invoices, retainage releases, invoice payments, customer deposit receipt/application/reversal and receivable adjustments | Reviewed source entity and signed corrections; income/control accounts, deposit and bank legs in that same entity                                                                                                        |
| Payables/expenses              | Vendor bills, bill payments, AP fees, project/general expenses and payment reversals                                                          | Bill/expense owner, disbursement/funding owner and account/period entity; paying another entity becomes a reciprocal intent                                                                                              |
| Labor/payroll                  | Project job costs/native time, provider imports, payment reviews, posting and correction proposals/receipts                                   | Explicit reviewed entity legs, private membership, original source ownership conserved through corrections and exact retry                                                                                               |
| Construction inventory/closing | Land/lot/home ownership, cost relief, contracts, budgets, change orders and closing sources                                                   | Effective reviewed project/lot ownership; entity chart and inventory/revenue/COGS on every original and relief leg                                                                                                       |
| Period-end/manual accounting   | WIP/POC, loss provisions, adjustments, opening balances, tax workpapers and year-end entries                                                  | Entity-specific settings/policies/calendars, period fences, review and close gates                                                                                                                                       |
| Core ledger                    | Organization-scoped `gl_accounts`, facts, journals, lines and projection receipts                                                             | Composite organization/entity relationships, uniqueness and posting/reversal identity; reviewed legacy cutover                                                                                                           |
| Banks/statements/reports       | Organization-wide bank/reconciliation, AR/AP/control and statement populations                                                                | Funding account entity, entity cutoff and independent reconciled statements; no implicit sum as consolidation                                                                                                            |
| Exports/restoration            | Current schema 17 archive includes payroll history but not the new registry                                                                   | Versioned capture/verification of entities, access history, profiles and reviews, actor dependencies, restored sequences and future source ownership; existing archive versions cannot invent an approved default entity |

Registry UI, tax registrations, entity account/control mappings and funding,
legacy ownership proposals, source-to-ledger enforcement, archive/recovery,
intercompany and consolidation are still required. No package or release gate is
complete because this registry exists.

## Schema 18 archive and scoped recovery checkpoint

The pending follow-up migration
`20261004172415_books_legal_entity_archive_identity.sql` gives memberships, access
events and approvals stable UUID row identities. Access events also retain their
ordered entity sequence. Normal writes continue from the maximum retained sequence
after restoration, rather than depending on reseeding an identity generator.
Existing profile/review values are preserved; additive references pin the actual
historical access events that authorized preparation and review. An upgrade fails
if those historical grants cannot be proven. Such legacy evidence requires review;
the migration does not guess a current grant or invent an approval.

Export schema 18 captures all five setup tables in the existing single statement
snapshot. Complete user exports require active organization membership and explicit
access to every included entity. The manifest retains the included entity IDs.
Download authorization checks those archived IDs against current access before
signing a URL; revoked access, malformed inventory and expired exports fail. Legacy
archive ownership remains unknown and requires access to every current entity.
Completed export proof cannot be rewritten, and browser roles cannot read or mutate
its private manifest directly. The workspace continues serving its existing bounded
export summaries through the permission-checked server.

`legal-entity-archive.ts` verifies stable identities, organization/entity closure,
access event order and prior/current roles, manager authority, creator bootstrap,
profile revision/approved predecessor chains, separate reviewer, pinned preparation
and review authority, recurring calendars and declared document references. Native
entity data cannot be hidden under an older schema version. Source document versions
remain in the existing historical object inventory with original bytes. An older
archive restored into this schema gets empty entity setup tables, never a silently
approved default owner.

Scoped tests execute both actual entity migrations, populate and upgrade reviewed
setup, deny foreign/revoked export access, reject rechecksummed corrupt evidence,
prepare against actual target columns/composite foreign keys with explicit actor
and organization dependencies, restore an empty fixture, re-enable normal guards,
recover historical setup retries and append a new access change. They also prove
missing historical authority aborts upgrade and cannot partially invent evidence.
The supporting-file verifier/extractor supports schema 18, while older payroll
archives and monetary correction/receipt retries remain covered by regressions.

This is not full-schema, authenticated application or full-company recovery
acceptance. Entity ownership, charts/periods/banks, governed manager recovery,
intercompany and consolidation remain absent. B06 additionally retains its larger
work: streaming/capacity, complete role/secret dependency packaging, ordinary-export
TIN/provider-secret classification (including unstructured originals), salary and
private dossier authorization, live private storage and full post-restore financial
operation. An entity membership check alone does not satisfy those requirements.

## Core organization relationship enforcement checkpoint

Pending migration `20261004193127_books_core_ledger_owner_relationships.sql`
adds validated composite organization/ID references for account parents, fact
supersession/reversal, journal facts/periods/reversals, and journal line entries
and accounts. The existing line and period guards remain. Parent organization
identity is now part of the database relationship, including when a parent is
changed; ID-only existence cannot establish that a fact or reversal belongs to
the posting organization.

The transaction does not change IDs, account codes, cents, dates, source
payloads, posting keys, posted state or prior receipts. Valid populated scoped
upgrade preserves all core rows exactly. Existing foreign-organization links
abort the complete migration instead of inventing an owner or silently repairing
posted history. The actual atomic posting RPC rejects a foreign fact and rolls
back its attempted journal; normal same-organization posting remains covered.

This is organization isolation groundwork, not legal-entity ownership. No legacy
row is assigned `legal_entity_id`; source/control ownership, entity-aware writers
and readers, independent calendars/charts/banks/close, intercompany and
consolidation remain required. The row shape and export schema remain unchanged.
The three prepared native pgTAP assertions are unexecuted; scoped PGlite upgrade
and posting results do not establish full native schema, concurrency, populated
company migration or authenticated application acceptance.

## Exact reversal posting checkpoint

Pending migration `20261004194104_books_exact_reversal_posting.sql` closes a
posting-time gap previously detected only by reversal-history reconciliation.
A committed reversal must identify a posted original, use an accounting date on
or after the original, and exactly swap its signed account/project/counterparty/
dimension amounts. Canonical comparison uses PostgreSQL bigint cents and ignores
line ordering and descriptions for economic validation. Descriptions may explain
the reversal; changed descriptions are rejected on a committed intent retry.

Both direct generic posting and the reversal RPC receive these guards. Successful
posting marks the original reversed in the same transaction. One committed child
is enforced even if that child is subsequently reversed. Exact RPC retries retain
the original receipt after its period closes or the reversal itself is reversed;
a changed date, key, memo, versions, source/fact/actor identity or retained lines
cannot masquerade as that retry. Existing corrupt chains abort the upgrade and
require reviewed correction; the migration never silently rewrites prior money
or invents a receipt.

The journal service sends scheduled reversals through the checked reversal RPC,
so a posting-key shortcut cannot hide a mismatched retry. Reversal account lookup
includes inactive original accounts; ordinary posting still requires active
accounts. SQL still requires those exact original account IDs and dimensions.
Other account/chart changes, private operational-register reversal controls and
permission checks retain their existing boundaries.

Scoped tests execute actual posting/reversal SQL, validate amount/dimension/date
failures without partial money, nested reversals, committed retries, valid and
corrupt populated upgrades, inactive accounts and service routing. Full native
schema/concurrency, authenticated scheduled-entry workflows, populated company
recovery and separate legal-entity ownership remain unaccepted.

## Atomic direct adjustment pair checkpoint

Pending migration `20261004195905_books_atomic_adjustment_pair.sql` adds one
private invoker RPC for the direct adjustment and optional automatic reversal.
An active organization actor and the existing Books adjustment permission gate
remain required. The RPC fences membership and the adjustment key; new entries
also fence and require active scoped accounts. A closed reversal period or
failure during the second leg rolls back both new journals and every line.

The existing content posting key and original IDs are preserved. New original
source tags distinguish scheduled and unscheduled intents, so a changed schedule
cannot silently add another leg on retry. Header/actor and complete retained line
signatures are compared before using an existing original. Exact retries return
original IDs after period closure or account deactivation. Legacy null-source
manual originals can receive their missing automatic reversal only when the
current authorized original actor supplies the matching retained entry and lines.
The requested schedule is an authorized completion; the legacy original alone
does not prove a previously intended schedule. Neither original source tagging
nor monetary history is backfilled or rewritten. Existing conflicting child
reversals, wrong money/basis/actor, and schedule changes fail.

`createAdjustingJournal` calls this RPC once and validates its scoped receipt.
Both newly committed journals keep their activity and audit records. Those
auxiliary writes follow the money transaction; durable recovery of a failed
activity/audit append remains unaccepted. The reviewed-proposal path already
posts both legs in one database transaction and remains a distinct workflow.
Its committed review retry behavior still requires further acceptance.

Scoped tests execute the actual pair/posting/reversal SQL and service wiring,
including a closed reversal period, injected second-leg failure, exact retries,
inactive accounts, changed schedule, legacy partial recovery and forged receipt.
No archive table/row shape or schema version changes. Full native concurrency,
authenticated workflows, company restoration and all golden acceptance remain
pending. The existing content-derived key still conflates deliberately identical
new adjustments; explicit client intent identity remains required before full
manual-journal acceptance.

## Independent journal proposal receipt checkpoint

The October 4 proposal-review migration freezes the complete submitted row,
including reversal date, policy version, preparation timestamp and recurring
source linkage. A pending proposal can transition only to a separately reviewed
approval or rejection; a new row cannot arrive already approved. Reviewers must
have current organization membership. New approvals also require a current maker
and active scoped accounts; rejection can resolve proposals from departed makers.

Approval commits the original journal, optional exact scheduled reversal and
independent review receipt in one transaction. The receipt verifies the complete
retained journal headers and economic lines, with composite organization foreign
keys. Existing review history is validated during upgrade and is never synthesized
or rewritten. A pending proposal cannot adopt a previously occupied posting key.
Exact committed retries compare reviewer, decision and normalized note, validate
the retained money receipts, and return the original identifiers after later period
close or account/maker deactivation. Changed retries fail. The service validates
organization/proposal/reviewer/status/identifiers and emits its notification only
for a newly committed review.

This is scoped journal-control evidence, not entity activation or release
acceptance. Durable notification append recovery, explicit client intent identity
and preparation retries, full line/evidence inspection in the authenticated review
UI, native full-schema replay, restore business verification, and the complete
construction/entity/intercompany/consolidation golden scenarios remain required.

## Journal review workspace checkpoint

Journal approvals have their own entry point beside the adjustment editor and
recurring templates. The pending-only queue uses bounded pages with a preparation
timestamp/UUID cursor so older pending work is not hidden behind newer reviewed
history. Permission checks precede reads; labels for accounts (including inactive
ones), projects and companies come from organization-scoped queries.

Reviewers can inspect every proposed line, allocation and dimension, the original
memo/date/maker/preparation timestamp, policy version and automatic reversal date.
Exact decimal-cent strings use bigint arithmetic and formatting; unsafe numeric
JSON is rejected rather than displayed with rounded cents. Approval requires a
positive balanced entry and opening the complete line view. Rejection requires a
reviewer-written note. Maker self-review stays unavailable. An uncertain mounted
review attempt freezes its decision/note and retries the same request; duplicate
clicks coalesce. Reload errors clear old actionable cards, and request sequencing
prevents stale queue responses from replacing newer results.

The original document attachment/evidence workflow, durable recovery across a
browser restart, explicit client preparation intent, authenticated rendered-browser
acceptance and full golden scenarios remain pending. Component callback harnesses
and scoped service-query tests are not authenticated browser or native database
acceptance. This checkpoint does not establish legal-entity ledger ownership.

## Explicit journal preparation intent checkpoint

A fresh maker-generated UUID now identifies each journal proposal submission.
Two legitimate identical adjustments have different posting keys and can both be
independently approved. A lost preparation response retries the same UUID and
compares the complete submitted date, memo, reversal schedule, maker and ordered
lines. A changed retry fails. The RPC locks membership and intent, resolves active
scoped accounts and the current policy only on initial preparation, and stores the
submitted account code alongside the immutable account ID. Exact retries retain
the initial account mapping and policy even after code changes, deactivation or
completed review. Old proposals and content-derived posting keys remain unchanged.

The service requires the UUID, validates the scoped receipt and emits a proposal
notification only for initial creation. The mounted editor freezes its original
request and coalesces clicks until confirmation; the review screen shows retained
submitted account codes. Preparation validates balanced safe integer cents and
same-organization project/company ownership before persisting a pending proposal.
No money is posted until the separate independent approval transaction.

No row columns or tables are added; retained line JSON carries the submitted
account code. Archive schema remains 19. Full native archive/restore acceptance,
client recovery across a browser restart, document attachments, durable event
append recovery, direct non-proposal adjustment intent identity, all entity and
construction scenarios and independent acceptance remain required.

## Browser journal recovery checkpoint

Preparation and independent-review requests are now saved before their server
actions under an organization/user-specific browser key. The saved request includes
its original preparation UUID or proposal/reviewer decision and note. It survives
editor closure and a fresh browser runtime, is never expired or silently erased,
and is cleared only after a matching scoped receipt and verified local cleanup.
Preparation and review share one unresolved-request slot per organization/user;
cross-tab Web Locks serialize saving, sending and clearing that slot. A conflicting
request, unreadable record or unavailable persistence prevents a new send.

The ledger exposes a saved-request recovery panel even when the original approved
proposal has left the pending queue. Makers inspect original accounting lines,
amounts, allocations and reversal date; reviewers inspect the original decision
and note. Uncertain responses and cleanup failures keep the exact request. A newer
request from another tab cannot be cleared by an older result. Storage-change
notifications refresh the panel, and corruption removes old actionable controls.

The workspace supplies the authenticated actor and organization and remounts the
ledger when either changes. Recovery sends both expected identities; service
checks reject an old organization/user before its mutation RPC, in addition to
current Books authorization and the database membership/independent-review gates.
Existing non-browser service callers retain their authorization behavior.

This proves scoped storage, client protocol and component callbacks, not a real
authenticated rendered-browser acceptance scenario. Safe audited abandonment of a
proven-uncommitted request or acknowledgement of a superseded review is still
required; uncertain saved requests currently remain recoverable and cannot be
silently discarded. Supporting documents, durable notification/audit append
recovery, native full-schema and complete archive restoration, entity ledgers,
intercompany/consolidation and full construction golden acceptance remain pending.
No schema columns or archive version change in this checkpoint.

### Journal recovery resolution and schema 20 (October 4, 2026)

This checkpoint supersedes the preceding recovery section's outstanding audited
abandonment item and its statement that the archive version is unchanged.
An actor can cancel an uncommitted preparation or review, or acknowledge the exact
committed review or a superseding review. The browser saves the resolution UUID
and explanation before sending it and retains them across uncertain responses.
Only a matching scoped receipt clears the saved operation. An already committed
preparation cannot be canceled; its original receipt must be recovered instead.

The private invoker resolution RPC records immutable canonical request bytes,
SHA-256, actor, reason, and observed proposal/review evidence. Cancellation and
writers share transaction locks and a private coordination tuple. Its generation
update prevents a stale higher-isolation writer from using a pre-cancellation
snapshot; native concurrent-session verification remains pending. Canceled exact
requests cannot subsequently create a proposal or commit review money. A changed
review decision/note is a separate request. No approval or rejection is undone by
acknowledging it.

Schema 20 captures resolution history in the same database statement snapshot.
Verification checks scope, canonical request hash, cancellation fences, retained
review identity and complete original/reversal journal economics, including
allocations. Historical archives remain historical: no resolution history is
invented for versions below 20. Ephemeral coordination generations are deliberately
excluded from accounting exports; they can be rebuilt from subsequent requests.
Recording recovery acknowledgements does not change the legacy entity source
population, while actual proposals and money still do.

Focused production-SQL fixtures and browser protocol tests cover these controls.
They do not prove authenticated rendered-browser workflows, native simultaneous
sessions or native restoration of the new append-only rows. Normal insert guards
rederive observations and timestamps; a trusted restore path preserving the exact
retained evidence still needs implementation and native verification. No complete
company disaster recovery or QBO replacement readiness is claimed. The migration
is pending human approval for production application. Entity source/ledger
ownership, intercompany, consolidation, construction golden scenarios and actual
builder/independent CPA acceptance remain unfinished.

### Exact journal resolution restoration (October 4, 2026)

The offline `prepare-books-journal-resolution-restore.cjs` command now creates
reviewable SQL for an explicitly identified isolated acceptance database. This
supersedes the preceding section's outstanding implementation item for preserving
resolution observations and timestamps. It does not create a production restore
endpoint or implement the entire company recovery procedure.

The command requires a fully verified schema20 archive and writes a new private
SQL file without changing the archive. Execution checks the exact instance,
project, migration manifest and installed migration versions, requires ordinary
origin trigger mode and disabled scheduled jobs, and refuses existing resolution
history for that organization. It locks and compares the complete restored
proposal, journal, line, chart, period, project and company populations to the
retained archive before importing history.

Only the resolution insert guard is temporarily disabled inside the transaction;
foreign keys and append-only update/delete protection remain enabled. Original
canonical request text/hash, observations, actor, reason and microsecond timestamps
are imported exactly. The script re-enables the guard, compares every imported row
and forces constraints before committing. An error rolls back the rows and the
transactional trigger change. Data in the SQL is hex encoded so an archived quote,
backslash or dollar delimiter cannot escape an administrative DO block.

Actual scoped SQL fixtures prove preserved cancellation and acknowledgement
receipts, exact retries, late canceled-packet refusal after restore, rejected target
identity/migration drift/accounting drift, dependency-failure rollback and enabled
guards afterward. The CLI creates mode0600 output and refuses overwriting it.
Native full-schema, simultaneous-session, authenticated application and complete
company disaster recovery acceptance remain pending. Operational fence generations
are rebuilt by ordinary requests and carry no exported accounting history.

Trigger handling follows PostgreSQL's explicit per-trigger administrative control:
[ALTER TABLE](https://www.postgresql.org/docs/17/sql-altertable.html).

### Entity fiscal calendars and schema 21 (October 4, 2026)

Entity setup now retains its own fiscal calendar years, twelve original periods
per year, and independent calendar reviews. The calendar freezes the exact
approved legal profile, preparation/review access events, actors, notes and dates.
It belongs to the native legal entity and organization through composite foreign
keys. This adds persisted entity calendar ownership; it does not assign sources,
activate a ledger, post journals, close a period or change the legacy organization
calendar.

The year label is the calendar year in which the fiscal year starts. Monthly
boundaries retain the configured fiscal start day, clip short months, then resume
the original anchor. For a January 31 start, a leap February starts on February 29
and March resumes March 31. All twelve periods and the year boundary are derived
from the original reviewed profile. A deferred constraint refuses incomplete years
at commit. Review rejects the maker, inactive authority, changed applicable
identity, overlapping approved years and unexplained gaps between approved years.
A later profile review cannot rewrite an already retained calendar. Fresh review
must use the reviewed identity applicable at the original start date; committed
exact retries preserve original preparation and approval receipts.

Books manage authorization and explicit entity preparation/review access both
apply. SQL holds entity and active organization membership locks for fresh writes.
Calendar readers require Books read and entity read access, paginate at fifty
years with up to six hundred periods per page, and return no activated-ledger
claim. The existing entity page offers preparation, the original twelve-period
inspection, independent review and retained reviewed identity selection. Client
retry IDs remain stable for unchanged forms while mounted; uncertain responses
can be retried or checked by refreshing retained calendar records. Reload-persistent
client recovery and authenticated rendered-browser acceptance remain pending.
The entity workspace remounts when organization or actor changes.

Schema 21 captures all calendar history in the same statement snapshot. Its
verifier checks original profile applicability at preparation/review time, pinned
access chronology, every boundary/period, independence, overlaps and gaps, even
when archive checksums are recomputed. Older archives cannot invent this history;
restore planning supplies only empty current calendar tables when the old archive
predates them. Calendar setup records do not change the legacy monetary ownership
population. Populated scoped SQL restoration preserves dates, access evidence,
exact preparation/review retries and supports the following fiscal year after
normal guards are re-enabled. Journal-resolution restoration accepts schema 20
and 21 without changing that earlier history contract.

The pending migration is
`20261004215338_books_entity_fiscal_calendars.sql`. Native replay and concurrent
sessions remain unverified because Docker's version endpoint still returns invalid
JSON. Source ownership, entity charts/settings/banks, posting and close integration,
intercompany, consolidation and full company/real-builder/independent CPA acceptance
remain unfinished. Calendar transitions requiring short years or 52/53-week rules
are not implemented; they must not be represented as a reviewed complete date
range. The monthly boundary policy also needs the independent accounting signoff
required by Plan 013. No package, golden scenario or release gate is accepted by
these scoped checks.

### Entity chart versions and canonical accounts (partial checkpoint)

The pending `20261004222659_books_entity_chart_versions.sql` introduces canonical
entity account IDs independent of the legacy organization-wide `gl_accounts`.
Two entities may have the same account code with different account IDs. An
immutable chart version retains names, classifications, hierarchy, cash-flow
categories, original definition bytes and hash, and all control mappings. Future
versions reuse account IDs by entity/code without rewriting earlier definitions.
The classification policy is explicitly version 1 and retained as static data;
changing a global template cannot silently reinterpret archived classifications.

Preparation records the applicable reviewed legal profile, latest reviewed
predecessor, live maker authority and original notes. Review locks the entity,
requires a different active reviewer and active maker, and rechecks the profile,
predecessor and complete original account/control rows. Deferred constraints
prevent partial charts; private invoker readers check entity access and return
bounded pages or one complete chart. Exact retries return retained receipts.
No ledger is activated by preparing or approving this setup record.

The entity setup workspace supports initial construction-template preparation,
original account/control inspection, independent review and paging. Custom chart
editing, preparation of revised charts in this workspace, historical profile
selection and reload-persistent form recovery are unfinished. Services and SQL
already support reviewed revisions, including preserved canonical account IDs.
Callback tests exercise uncertain retries, self-review suppression and revoked
read refresh; authenticated rendered-browser verification remains pending.

Export schema 22 captures all five chart tables in the statement snapshot.
Independent archive validation checks frozen content, all relational definitions
and controls, historical applicable profiles, original access events, canonical
account creation and independent review/predecessor chronology. Pre-22 archives
may receive empty target chart tables; they cannot invent chart history. A scoped
isolated relational restore preserves original IDs/receipts and permits a new
reviewed revision afterward. This is not full company restore acceptance.

Native schema and race acceptance remain unexecuted: Docker's version endpoint
returned empty/invalid JSON even outside the sandbox. Actual construction source,
fact and journal ownership; entity-native posting, reporting, settings, banks,
close/cutover; intercompany and consolidation remain unfinished. The current
implementation must not be presented as independent entity ledgers or a release
ready QBO replacement. Plan 013 packages, goldens and release gates remain open.

### Configurable entity chart workspace (partial checkpoint)

The entity setup workspace now supports custom charts and reviewed revisions.
Preparation starts from the actual latest reviewed chart, independently of UUID
history paging, or from the construction template for an entity's first chart.
Users can edit account codes/names/classifications, parent hierarchy and cash-flow
categories; add or remove unbound accounts; and select compatible control mappings.
Code changes update draft parent/control references, and the UI explains that a
new code creates a new canonical account identity. Original committed IDs and
version definitions stay immutable. Shared parent datalists avoid rendering a
full account-option list for every account row.

The pending `20261004230553_books_entity_chart_editor_context.sql` provides a
private invoker statement-snapshot reader for the authoritative reviewed chart
head and paginated retained reviewed legal profiles. The service checks scopes,
profile ordering/uniqueness and cursors. Historical chart preparations can select
an earlier applicable reviewed identity without dropping later retained profiles.
Preparation continues to revalidate the effective profile and reviewed predecessor
inside the existing SQL transaction. A competing review cannot silently redirect
an unchanged retry to a newer predecessor.

The editor validates complete frozen classifications, controls and hierarchy,
disables edits while a request runs, and preserves mounted unchanged-request UUIDs
on uncertain outcomes. It clears stale preparation controls after revoked context
reads. Exact preparation receipts are still available through the existing
retained UUID contract. Reload-persistent draft/request recovery and authenticated
rendered-browser evidence remain unfinished.

This completes additional chart configuration capability, not entity-native money
posting. The projector currently uses organization-wide account code resolution.
Actual source/fact/journal ownership, entity-specific account resolution, reports,
bank/settings/close/cutover, intercompany and consolidation remain required. Native
schema/replay/races and full-company construction acceptance remain unaccepted.

### Actual project ownership boundary (SQL foundation, partial)

`20261004231952_books_project_legal_ownership.sql` establishes an immutable,
independently reviewed legal owner linked to the actual organization/project row
through composite foreign keys. This is an authoritative project-owner relation,
not an external-accounting transport map or a vendor/customer company ID. A
reviewed proposal retains its effective legal profile, original project name,
explicit single-entity rationale, original document version metadata, original
maker/reviewer access events and notes. Exact scoped retries return original
receipts. Competing proposals cannot produce two reviewed owners for one project.

Fresh ownership requires no retained accounting fact or journal-line history.
The history check includes nested project/labor/settlement references and actual
invoice/bill/expense/payment parent relationships. Existing money requires the
separate reviewed legacy adoption/correction path, which remains unfinished.
Project/org reassignment of native-owned invoice, vendor-bill, expense and payment
records is rejected through ordinary edits. Payment document reassignment is also
rejected when either side belongs to an owned project. A governed correction
workflow for such moves remains unfinished.

Legacy fact and journal-line insertion lock the referenced project and refuse
native-owned projects. This deliberately holds those sources for entity-native
posting instead of silently putting them into the organization-wide ledger.
Ordinary unowned project posting remains available. Fact project resolution uses
structured nested UUID values/keys and actual root/payment parents, with indexed
project lookup rather than scanning every project for every fact. Other source
families and explicit entity split legs still need complete authoritative handling.

Scoped actual-SQL tests verify real project linkage, maker/checker, immutable
receipts, foreign organization rejection, preserved ordinary legacy posting,
existing history exclusion, altered originals/revoked maker rejection, competing
owners, nested evidence, actual payment ancestry and ordinary-edit fences. Native
multiple-session race proof remains unexecuted; these checks are not its substitute.

This SQL foundation has no user-facing ownership assignment action yet. Typed
service/project authorization, verification of original document bytes, ownership
capture/archive/business validation/restoration, complete source coverage,
entity-native journal/account/period routing, official activation, reports and
construction workflow integration remain unfinished. These tables are currently
missing from the archive, so this foundation must not be released or applied as a
complete ownership/migration capability. The pending migration has not been
applied to production. Plan 013 remains active; no package or golden is accepted.

### Project ownership archive and legacy population contract (schema23, partial)

The pending `20261004233548_books_project_owner_archive.sql` captures immutable
project ownership proposals and reviews. Schema23 validates organization/project
relationships, original supporting versions and embedded bytes, applicable
reviewed identity, pinned historical access, independent review and the absence
of incompatible legacy facts or journals for reviewed native-owned projects.
Checksums alone cannot authorize a corrupted assignment. Earlier archives may
restore empty ownership tables; they cannot invent assignments.

A populated isolated SQL fixture restores retained owner records and verifies
original preparation/review retries, immutability, posting guards after restore,
and a subsequent independent assignment. This is scoped recovery evidence;
complete company restoration and native multiple-session races remain unaccepted.

New legacy ownership proposals use population contract2, which includes project
ownership evidence and rejects mixed project owners. Any project ownership change
invalidates a pending review. Contract1 preserves original historical bytes:
fresh review and current-status comparison may omit the two new empty tables only
while no project ownership exists. Already committed exact review retries retain
their original receipts. Archive validation checks completeness at original
capture and review times, allowing ownership created after the historical review.

The earlier archive omission is addressed in this checkpoint. The project-owner
workflow services/UI and original-byte checks before assignment, actual native
source/fact/journal/account/period routing, governed ownership corrections and
full acceptance still remain required before release. Neither migration has been
applied to production. No package, golden or release gate is accepted here.

### Authorized project ownership service and request recovery (partial)

`lib/services/books/project-entity-ownership.ts` and the pending private invoker
reader in `20261005000141_books_project_owner_workflow_reads.sql` provide typed
preparation, independent review and original request recovery. The server requires
an enabled Books workspace, organization-wide Books read/manage authorization,
project read/manage authorization and current entity operation access before
loading selected evidence. The SQL reader returns one statement snapshot scoped
to organization, entity, actual project, proposal and authenticated server actor.
It cannot be invoked by browser credentials.

New preparation/review streams original document version bytes and verifies exact
size/SHA. The caller's RLS client must resolve each supporting file, and document
read permission is checked against that file's actual project before privileged
storage reads. Review compares prepared original metadata with the selected
version and rejects metadata drift. Preparation compares the returned frozen
metadata with the originals verified before the SQL write. Exact committed
preparation/review retries preserve original receipts after later document changes;
SQL still checks current entity authority and immutable request identity. Provider
storage failures produce a safe error and cannot create an ownership record.

Server actions revalidate the actual project workflow after ownership changes.
Scoped actual-SQL service tests cover foreign projects, permission denial, inactive
membership, entity review revocation during verification, original byte/metadata
failures, forged scope/receipts and exact recovery. Permission and storage adapters
are explicit fixture seams; this does not establish authenticated product rendering,
full RLS/native replay, multiple-session races or storage-provider immutability.

User-facing ownership selection/review and durable browser intent recovery are
still unfinished. Entity-native monetary posting/activation is also unfinished:
reviewed ownership continues to hold covered sources from the legacy ledger. No
release-ready native ledger, complete entity workflow, package or golden is claimed.
The migration remains pending and production has not been modified.

### Project ownership workspace reader (partial)

The pending `20261005001726_books_project_owner_workspace.sql` provides a private,
invoker statement-snapshot workspace reader for the actual project. It independently
pages readable legal entities and scoped ownership proposals, retains the approved
owner independently of the current proposal page, and verifies active organization
membership plus selected entity read access. Original supporting evidence remains
in the separately authorized proposal detail. A revoked entity reader can see that
an owner exists but cannot retrieve its retained approval/proposal through this
workspace.

The typed service validates organization/project/actor/selected-entity scope,
row uniqueness/order, exact cursors and owner/proposal relationships. Preparation
and review capabilities combine organization-wide Books manage, actual project
manage and entity operation grants; read-only Books/project users do not gain write
capabilities from an entity grant alone. Populated scoped tests exercise 28 entity
choices and 28 proposals, continuation cursors, approved-owner retention across
pages, revoked entity evidence and forged responses. These are not authenticated
browser/RLS/native race acceptance.

The shared server action is ready for integration into project financial workflows.
The project-facing controls, durable browser intent recovery and actual entity-native
monetary routing/activation remain unfinished. No package, construction golden or
release gate is accepted, and production has not been modified.

### Embedded ownership controls and durable browser request recovery (partial)

Billing, Payables and Expenses now share an embedded ownership panel when Books
is enabled. The panel loads the actual project workspace, independently pages
entity/proposal choices, selects reviewed identities and readable original document
versions, prepares ownership evidence and supports a separate reviewer. It shows
that ownership review and native posting activation are separate. Covered source
posting continues to be held until entity-native accounting is implemented.

Ownership mutations now require the client's expected organization and actor to
match the authenticated context. The browser stores the complete canonical request
before sending it, keyed by organization/actor/project. Web Locks serialize tabs;
missing lock support or storage failure refuses submission. Unknown responses do
not expire or overwrite the request. A receipt must match original scope, actor,
identity/date/evidence/notes or review proposal/notes before acknowledgement can
clear it. Cross-tab storage changes are surfaced. Client validation is isomorphic:
shared ownership schemas no longer pull Node accounting hash dependencies into
the browser graph.

The new project-scoped original endpoint requires Books/entity/project access,
caller file visibility and actual file-project download permission. It stages and
verifies the frozen prepared bytes before returning a private, uncached attachment,
checks entity authority again afterward, propagates request cancellation to staging,
and returns safe errors. Current file/version metadata cannot substitute for the
prepared original. Document choices use caller visibility and document read
permissions without requiring unrelated whole-ledger export authority.

Focused actual-SQL/service/storage/recovery tests and static server rendering pass.
These do not prove authenticated browser interaction, full production RLS, native
multiple-session races or complete company recovery. The component is not a claim
of native monetary activation or readiness to replace QBO.

A saved uncommitted request with a permanently invalid original/profile cannot yet
be safely canceled or replaced: it remains visible for exact retry until a governed
server resolution is implemented. That resolution, authenticated browser acceptance,
actual native entity source/fact/journal/account/calendar routing, complete corrections,
intercompany/consolidation and full construction acceptance remain required. Existing
SQL migrations remain pending; production has not been changed.

### Governed project ownership request resolution (schema24, partial)

Pending migration `20261005005818_books_project_owner_request_resolutions.sql`
adds private, append-only cancellation receipts and operational generation fences.
Preparation, review, direct inserts and resolution share the entity → active
membership → project → request nonce lock order. Updating the nonce generation
is designed to force stale higher-isolation writers to serialize or fail; native
multi-session race acceptance remains outstanding.

Resolution validates the complete saved request and current actor/entity/project
scope. An exact committed preparation or review returns its original receipt and
creates no cancellation. A committed receipt with different scope/content rejects.
An absent request receives a permanent nonce cancellation; late RPC/direct inserts
cannot resurrect it. Canceling one absent review does not undo another review's
established owner. Invalid/missing supporting versions or target proposals may be
canceled because the cancellation approves no ownership, profile or money.

Billing, Payables and Expenses use the same embedded controls. A resolution UUID
and reason are retained with the complete saved request before the network call,
under the existing cross-tab Web Lock. A lost response replays that exact decision;
new request bodies, changed reasons and changed resolution IDs remain blocked until
an exact committed receipt or matching cancellation is acknowledged. The service
requires Books management and actual project management, matches authenticated
actor/organization, enforces current entity authority through the private INVOKER
RPC, and validates the returned request text, scope and raw SHA-256. Resolving a
failed request does not read broken supporting bytes or bypass file authorization
for ordinary preparation/review/downloads.

Schema24 exports cancellation history with pinned access events and observed
proposal provenance. Business verification rejects cancelled nonces that also have
committed receipts, altered scope/actor/request digests, stale authority, invalid
observations and version downgrades. Restoring older archives adds only an empty
cancellation family. Operational generation counters have no accounting meaning
and rebuild lazily; restored immutable cancellations continue fencing new writers.
Cancellation provenance is excluded from retained legacy population contracts1/2,
so adding it does not rewrite or invalidate their frozen source evidence.

Scoped SQL/service/browser-storage tests and static rendering are implementation
proof only. Production migration application, authenticated interactive browser
acceptance, native race/RLS evidence, complete company restoration and entity-native
monetary routing remain unaccepted. Reviewed ownership continues to hold covered
legacy posting until actual entity accounting is implemented and accepted. No
package, construction golden or release gate is promoted to DONE by this change.

### Source-aware native posting plans (partial; journals not yet written)

Pending migration `20261005012051_books_native_project_posting_context.sql`
adds a private INVOKER, statement-snapshot reader for actual invoice, vendor bill
and project expense roots. It resolves the project's reviewed owner, verifies its
ownership date, requires the current actor's entity preparation access, and selects
applicable reviewed USD identity, entity chart and fiscal period. The service checks
expected actor/organization and Books management before caller-RLS source metadata,
then actual project management before the privileged snapshot. Overhead, payments,
payroll, land/closing and other source families still need their native ownership
and context contracts; this reader does not claim to cover them.

`native-posting-plan.ts` validates the complete returned scope, original chart SHA,
canonical account identities/classification/parents and all control mappings.
Actual identity/chart/calendar approval receipts and chronology are pinned, alongside
owner approval, source snapshot/hash, chart/calendar/period and USD cents. Journal
plans require exact source/date agreement, balanced integer cents and same-project
lines. Explicit semantic account roles map existing construction posting decisions
to the selected entity's reviewed control codes; supplied native custom codes must
exist in that chart. No organization `gl_accounts` ID can substitute for the native
account identity. A two-entity fixture uses different AR/revenue codes and January
versus April fiscal starts and proves distinct canonical accounts and periods.

These modules currently produce plans only (`posted:false`, `ledgerActivated:false`).
They are not wired into the production projector and do not append facts, journal
headers or legs. The next implementation must persist and independently validate
source-specific economic evidence in an atomic native writer, with source ownership,
funding/dimension proof, closed-period enforcement, exact committed retries and
reversal/replacement behavior. That writer must revalidate pinned snapshot inputs
under transaction fences; a prior read/plan is not authority to post after drift.
The existing hold on owned project legacy posting remains. Native SQL replay,
authenticated source-to-ledger flows and complete acceptance are still outstanding.

### Independently reviewed native project adjustments (October 5)

The pending native adjustment ledger migration now retains immutable prepared
facts, separate independent approve/reject receipts, canonical entity journal
headers and exact balanced integer-cent legs. Approval writes all money in one
transaction; deferred completeness constraints prevent a review or header from
committing without its complete declared journal. Injected second-leg failure
rolls back approval, header and legs. Exact committed retries preserve the
original receipt, including after later source changes or period holds. Current
entity access still governs recovery.

These are explicit accountant adjusting entries associated with an actual invoice,
vendor bill or project expense. They do not derive invoice revenue or payable
recognition from an arbitrary balanced draft. Automatic operational projection
requires separate economic contracts and remains unfinished. Server services
require Books adjustment permission and actual project read access; private
invoker SQL enforces current entity preparation/review authority, separate maker
and reviewer, source ownership, unchanged reviewed definitions, canonical accounts
and supported project/cost-code/counterparty dimensions.

Append-only period holds freeze new native adjustment preparation and approval;
another entity manager must release a hold. They are posting controls, not the
complete official close/reopen workflow. Entity transaction fences are designed
to reject stale concurrent snapshots when definitions change. Native multi-session
Read Committed/Repeatable Read/Serializable proof remains required.

Schema25 captures and independently validates all five financial history families
against original request and validation digests, actual source/project identities,
retained owner/profile/chart/calendar definitions, authority history, complete
journal legs and historical period hold chains. Coordination fences are not
business archive records. Old archives may supply only empty new families and
cannot invent native money. Legacy population contracts retain their frozen table
inventories. Scoped populated restoration preserves exact receipts and holds,
reactivates immutable guards and permits fresh money after independent release.
Two actual entities post to distinct AR/revenue accounts and January/April
calendars, and holding one leaves the other available.

This remains a backend foundation. Accountant UI with durable request recovery,
shared construction posting status, automatic economic source projection,
reversal/replacement, official close/activation, reports and the remaining source
families still require implementation. Full native replay, authenticated workflows,
whole-company restoration and external builder/CPA acceptance are outstanding.
The fresh 542-migration/56-pgTAP acceptance attempt failed before database creation:
Docker's version endpoint returned empty or invalid JSON. Existing Arc databases
were not modified. No package, golden scenario or release gate is accepted.

### Native invoice economic witness (October 5)

The pending `books_native_invoice_economic_context` migration captures actual
invoice/header/line pricing, original and released retainage, project financial
settings/contracts, active approved organization policy, completed closing
settlement and current period hold in the same statement snapshot as reviewed
native ownership/chart/calendar routing. It is a private, STABLE, INVOKER reader.
The service requires caller-visible actual invoice metadata, expected organization
and actor, Books management and actual project management before the one private
snapshot. The read-only action returns a derived preview, not posted money.

The pure invoice builder accepts economic source evidence rather than a supplied
journal draft. It validates policy approval independence/chronology, row and
cost-code scopes, duplicate inventories and exact decimal price evidence. Native
income selections must use canonical account IDs in the owner's reviewed income
chart. A saved organization GL account selection requires explicit native review;
matching a legacy account code is not authority to adopt its identity.

Issued progress billings reconstruct gross from net invoice plus original
retainage, credit contract liabilities and separately book sales/use tax. Priced
lines must tie exactly to gross excluding tax and retainage presentation. Closing
revenue requires the actual closed settlement, original signed agreement evidence,
matching invoice/closing/date, reconciled final price and the existing frozen
settlement verifier. Retainage release invoices move original project retainage
to collectible AR without crediting revenue twice. Earnest deposit requests
produce no AR/revenue journal; cash receipt is a separate future source event.
Closed posting holds block new money plans. The monetary posting fingerprint
excludes snapshot timestamps and harmless operational notes, while the complete
captured witness retains them separately.

This is operational economic planning, not automatic native posting or official
activation. Atomic operational persistence/revalidation and replacement/reversal,
source status/drill-through in project billing, native income selection UX, every
other monetary source, standalone/general invoice ownership and explicit reviewed
entity/project service/T&M/cost-plus recognition exceptions remain unfinished.
The current project billing-basis choke point and approved organization policy are
captured; they do not replace a complete native policy governance workflow.
No new financial history family or archive schema version is introduced here.
The current 543-migration/57-pgTAP isolated attempt again failed at Docker engine
readiness before database creation. Scoped SQL/service/economic checks passed;
native authentication, races, full-company restoration and goldens remain pending.

## Pending native operational invoice persistence

The pending `20261005023412_books_native_invoice_atomic_posting.sql` adds an
immutable invoice source receipt and extends the existing native journal with
exclusive operational-source versus independently reviewed adjustment origins.
The writer revalidates actual source economics and derives journal legs inside
the transaction. It accepts no caller-supplied financial draft. Deferred
completeness checks and injected later-leg failures prove atomic receipt/header/
leg behavior in the scoped PGlite fixture. Exact committed request retries return
original money even after permitted payment-state or label changes.

Posted economic fields are guarded against unreviewed changes; later retainage
release remains possible and produces AR against original retainage rather than
new income. SQL billing-model fallback agrees with the application policy across
196 model/snapshot/contract-type combinations. Closing validation rejects unsafe
or fractional individual monetary components, even when they cancel to an
apparently valid total. The typed receipt verifier independently reconstructs
source money and rejects a rehashed balanced draft on the wrong account.

This migration remains pending and must not be activated or released yet.
Schema25 archive contracts do not yet support its new source-receipt family or
operational journal origins; schema26 financial closure, lossless restore and
populated continuation acceptance are required next. Typed authorized service,
durable billing request recovery, native account selector/status, governed
reversal/replacement and official native reports/close also remain unfinished.
Scoped fixture tests are not authentication, concurrent transaction, full-company
or production acceptance. The 544-migration/58-pgTAP isolated Docker attempt
failed before database creation; no production migration was applied.

## Native invoice archive closure and recovery — schema26

Schema26 includes `books_native_invoice_postings` alongside the existing shared
native journal. Verification reconstructs each initial invoice entry from its
original and validated economic witnesses, checks the exact receipt/header/leg
relationship, and consumes every shared journal entry and leg exactly once.
Neither an orphan operational receipt nor money attached to both a manual and
operational origin can pass. Downgrading populated operational history is rejected.

Historical closure ties owner/profile/chart/calendar/control/account definitions
and historical access to the retained approvals at capture/posting time. Actual
invoice amounts/date/project, priced line identity/quantity/unit/coding, original
retainage amounts, completed closing settlement and used policy bodies must still
agree. Later paid status, labels, policy supersession and legitimate retainage
release remain compatible with the original posted history. Posting holds and
independent releases are checked at the historical preparation/posting cutoff.

The full offline bundle verifier also checks original ownership supporting bytes.
A populated scoped restore preserves exact original receipt retries and ordinary
immutability, refuses fresh money during a retained hold, then permits new
retainage-release money after independent release. Schema25 restore preparation
uses the actual scoped target column/foreign-key catalog and records the explicit
null operational origin for older manual entries and empty new source family,
without modifying the original checksummed archive. Older archive versions remain
supported; transport fixtures exclude the new native family from legacy ownership
inventories.

This supersedes the preceding schema25 integration gap, but not the release
restrictions. Authorized operational services, integrated billing/account selection/
request recovery/status, governed reversal/replacement, full native source coverage
and official report/close lifetime remain unfinished. The scoped PGlite recovery
is not full-company/native authentication/concurrency acceptance. Current Docker
bootstrap again failed before database creation, so full native replay/pgTAP remains
unverified. No production database was modified or official native activation enabled.

## Authorized native project invoice service

The server service and thin Books actions now accept a complete saved invoice
request, including fixed receipt/header identities, original economic witness,
expected organization/actor and explanation. Books management, caller-visible
invoice metadata and management of the actual project precede the private writer.
The service does not reload economic snapshots during an exact retry. This allows
committed old requests to recover after later paid-status/label or approved-policy
supersession, while the database still requires current entity and organization
authority. Returned original witness, nonce, header, scope, actor, explanation and
all source-derived journal money are independently checked before success.

Detail reads require Books read, caller-visible invoice and actual project read,
then the scoped native entity reader. A different authorized reader can inspect
the original maker's receipt. A missing detail returns no money and is not a
cancellation or permission to forget an uncertain request. Revoked entity access
and inactive organization membership prevent both committed retry and detail
recovery. Moving a source after caller preflight cannot create money in the saved
project. A simulated lost write response commits once and recovers the same header.

These are scoped service adapters over actual SQL; they are not native RLS/auth or
browser acceptance. No UI submits these actions yet and native activation remains
false. Before exposing the workflow, add durable browser request ownership and
atomic server resolution of uncertain/abandoned nonces: absence of a receipt must
never be interpreted as cancellation while an older write can still commit.
Integrated native account selection/status, governed economic correction and all
remaining original scope stay required. Current full-schema acceptance remains
unexecuted because Docker readiness failed; no production database was modified.

## Native invoice request resolution — schema27

The scoped resolver and writer now coordinate through the native entity/source
locks and a mutated global nonce generation tuple. Resolution returns one exact
original committed source receipt/header/complete journal, or retains one immutable
cancellation that prevents the same nonce being posted later. Writer RPC and direct
receipt-insert guards both enforce cancellation. Cancelled requests can be stale;
resolution does not approve their economics. Retried resolution must preserve its
identity, complete original request and explanation. Current entity/organization
preparation authority remains required even when returning an earlier outcome.

Schema27 captures cancellation receipts and checks request/digest/actor/source/
entity/project, historical access and exclusivity with committed source money.
Cancelled source amounts are not financial facts and need not agree with later
mutable prices. Earlier schemas cannot contain populated cancellation history;
restore preparation adds an empty family for older archives. Operational nonce
fences are coordination data rather than exported financial history. The retained
cancellation itself reestablishes the guard after restoration. Offline bundle and
populated scoped restore tests preserve original supporting bytes, exact cancellation
retries, the cancelled nonce, and fresh normal posting under a new request identity.

The service and thin action apply Books management, caller-visible invoice and
actual original project management before resolution. Simulated lost cancellation
responses recover the same retained decision; forged output is rejected. No UI
submits these actions yet. Durable browser request ownership/recovery and integrated
billing/native account selection/status remain next. Recovery of moved source
projects or requests from departed/revoked makers requires an administrative
resolution workflow and remains an explicit gap; ordinary resolution currently
requires the saved source/project and original actor's current authority.

These scoped tests do not prove native authentication/RLS, multi-session isolation
races or full company acceptance. Current Docker bootstrap failed before database
creation. The broader financial run has one unrelated concurrent inspections
notification-coverage failure; it is not represented as green. Native activation
remains false and no production migration was applied.

## Native invoice durable browser recovery

The browser saves the complete original request before transport and serializes
operations with Web Locks. Storage failure, a corrupt saved request, a different
actor/scope, or an unsupported locking environment prevents submission. An uncertain
request cannot be replaced by a new identity. Cancellation saves its exact decision
identity and explanation before transport and prevents ordinary submission until
the decision is resolved.

Acknowledgement independently checks original request identity, scope, economics,
receipt hashes, native accounts and every balanced ordered journal leg. A missing,
truncated or forged receipt keeps the request pending. A verified terminal summary
must be saved and reread before pending data is removed; a storage or removal failure
leaves exact recovery available. Browser validation complements the server's
source-derived economic verification rather than replacing it.

An isolated in-app browser exercised actual scoped SQL posting and cancellation,
deliberately discarded each committed response, refreshed the page, and recovered
the original identities. The final counts remained one posting and one cancellation,
with no pending request and native activation false. Five regression scenarios also
cover quota/no-op storage, missing locks, cross-tab intent collisions, forged replies,
lost cancellation responses and terminal persistence failures. The client transport
adapter calls the existing authorized Books actions, but the browser fixture does
not execute Next.js authentication or that adapter.

Integrated project billing controls and native coding/status still remain required.
Moved-source/departed-maker administrative recovery, governed corrections, native
multi-session race proof, complete company acceptance and all release gates remain
unfinished. No production migration was applied by this verification.

## Native invoice workbench integration

The invoice inspector's Accounting tab now mounts the native invoice workbench.
Its workspace service checks Books read, caller-visible actual invoice/project,
reviewed project ownership and current entity access before disclosing a native
posting. Lookup identities are followed by the private reader and independent
receipt verification; ambiguous or different-entity/project receipts fail closed.
Write controls combine project/Books management and the entity's preparation
capability, while every action still repeats authoritative authorization.

Accountants can review a source-derived journal with native account codes/names,
enter a posting explanation and submit the exact saved request. The same invoice
shows original verified journal status and retained uncertain-request controls.
Refresh, cross-tab storage changes and invoice-scoped notifications reload status.
Resolution retains the original decision and cannot silently replace it.

The actual React component and browser recovery adapter were bundled into the
disposable SQL fixture with explicit action-transport replacements. Review, a lost
committed response, page refresh, and exact recovery retained the same journal ID
and one posting. This proves component/adapter behavior against scoped SQL, not
Next.js authentication, native RLS, full application styling or native concurrent
transaction acceptance. Service fixtures cover visibility and permission denial,
entity revocation, inactive membership, owner drift and ambiguous receipt identities.

Native income-account selection and governed corrections remain unfinished, along
with administrative recovery, remaining monetary source families, complete native
reporting/activation/close, intercompany/consolidation and full original acceptance.
Existing legacy posting status remains distinct from native journal preparation.

## Native invoice income-selection backend

Pending migration `20261005040543_books_native_invoice_income_selection.sql`
adds private append-only selection receipts and one atomic writer. A complete
original economic snapshot, full priced-line assignment inventory and explanation
are bound to an immutable request identity. Every choice is a canonical account
from the owner's independently reviewed applicable income chart; null explicitly
selects its construction-revenue control. Retainage presentation rows cannot be
recoded. Only the two Books income-selection metadata keys change, preserving
prices, dimensions, other metadata and all other source evidence.

Entity/source generation locks coordinate selection with native posting. New
selection is rejected after posting; exact old committed requests remain recoverable
without applying them again or adopting later economics. A failure on a later line
rolls back earlier changes and the receipt together. Direct receipt inserts run the
same guard. New native posting with an explicit entity account requires a matching
authorized selection receipt, so valid account IDs injected into ordinary source
metadata cannot bypass the coding workflow. Original pre-migration posted journals
remain unchanged.

Typed services reuse Books management, caller-visible actual invoice and project
management authorization. Returned original request, scope, receipt/result hashes
and exact metadata-only transition are independently verified. Scoped SQL/service
tests cover exact/lost retries, foreign/nonincome/generated/duplicate/missing lines,
stale evidence, post-selection posting, posted immutability, atomic failure,
entity/organization revocation and rehashed forged result evidence. The eight ACL,
invoker and trigger catalog conditions execute against the scoped SQL fixture;
they do not represent native pgTAP acceptance.

This remains a backend prerequisite. The new receipt family is not yet registered
in complete export/restore, and durable client selection/recovery and income-picker
UI are not yet implemented. They are required before shipping the feature. Native
authentication, multi-session concurrency and company/golden acceptance remain
unverified. Full-schema bootstrap failed at Docker readiness; an out-of-sandbox
read-only probe also returned empty/invalid version JSON. No production migration
was applied and native activation remains disabled.

## Schema28 income-selection provenance and recovery

The following checkpoint supersedes the backend-only export limitation above.
Pending migrations now bind every priced source line to its exact selection receipt,
including explicit default selections. The source identity is immutable after native
posting. A scoped invoice revision ordinal orders selections under the existing
entity/source lock; restoration continues that history without reseeding a sequence.
New journals retain the latest authorized selection through an organization/entity
foreign key. Existing journals without selection history retain a null origin.

Schema28 captures the complete immutable coding family in the same export snapshot.
Independent verification checks original intent, metadata-only transition, contiguous
revisions and chronology, frozen reviewed owner/chart/calendar/account definitions,
historical preparation authority and period holds. A journal must reference the
latest preceding selection, with matching account and selection identities on every
priced line. Recomputed manifest checksums do not excuse missing or altered witnesses.
Server receipt and browser acknowledgement checks also bind the frozen source identity
to the retained journal pointer; an invalid response leaves recovery pending.

Populated scoped SQL restorations preserve exact original coding and posting retries,
reject new recoding after money, and permit unposted restored sources to append a new
revision and post normally. Older schema27 archives adapt only an empty coding family
and null origin; they never manufacture selection history. These drills use isolated
privileged fixture restoration, not a complete application-company restoration.

The broader financial/Books regression run passed 3,538 tests. Current focused SQL,
service, archive and browser-contract tests pass; twelve catalog conditions execute
against PGlite. Repository TypeScript, scoped lint and formatting pass. Native current
migration replay/pgTAP/RLS/concurrent sessions and authenticated application acceptance
remain unverified. Durable selection cancellation/recovery and the workflow income
picker remain required before shipping, along with every original goal requirement.

## Schema29 income intent resolution and browser ownership

Pending migration `20261005044458_books_native_invoice_income_resolutions.sql`
adds exact committed-original recovery or an immutable absent-request cancellation.
The resolver, selector and direct inserts use the same entity/source/nonce generation
fences. Cancellation does not evaluate current prices or require an open posting
period: it settles an original unused intent without changing invoice metadata.
Every later insert of that request identity rejects before the source-edit guard.
Original committed selections recover unchanged after later coding or posting; an
exact cancellation retry must preserve the original decision and explanation.

Current Books/project management, actual caller-visible invoice and current native
preparation authority gate the service. Original receipt/request/hash/result scope is
independently checked, including lost responses and forged returned decisions. Direct
SQL cancellations retain actual source scope, historical access event and original
capture chronology. Moved-source/departed-maker administrative recovery is still
required; ordinary recovery does not bypass these current authority checks.

Schema29 exports and verifies the cancellation family, its frozen definition graph,
historical preparation authority, nonce uniqueness and exclusivity with committed
coding. Populated scoped restoration preserves permanent cancellation, exact original
retries and subsequent new coding/posting. Older archives may adapt an empty family
only. This is scoped SQL restoration, not full application/storage/company acceptance.

The browser-only coding contract saves and rereads original requests before transport,
retains one resolution decision before sending it, and verifies original intent,
raw receipt hashes and exact account-only source transitions before acknowledgement.
Terminal confirmation is durable before pending intent is removed. Coding and money
share the existing invoice Web Lock; either saved uncertain intent blocks a new intent
of the other kind. Maximum supported original requests leave room for a saved decision.
Node-executed browser-contract tests cover lost replies, corrupt/foreign scope,
storage failure, rehashed altered pricing, concurrent waiting and capacity boundaries.
They do not establish actual browser or authenticated application acceptance.

The workflow account picker and browser adapter/action journey remain unfinished.
Native ledger activation remains disabled. Full current migration replay, native
RLS/pgTAP/concurrent sessions, company goldens, intercompany/consolidation and external
CPA/real-builder acceptance remain required. The acceptance-table parser now tolerates
Markdown column padding while retaining all 25 required golden scenario identities.

## Integrated invoice income account picker

The invoice Accounting tab now offers reviewed native income accounts for every
priced line, identifies its quantity/rate and the actual chart default, and requires
an explanation. Generated retainage lines are excluded. Choosing an income account
does not change revenue timing: progress invoices retain the deferred billing journal.
Unsaved choices block posting. Saving invalidates the prior preview and explanation,
so the user reviews current economics before posting. Invoice changes clear draft
explanations and choices; immutable saved intents remain scoped to their original
organization, actor and invoice.

The actual browser adapter now submits coding and resolution actions through the
durable contracts. Pending selection and decision controls live beside the invoice,
survive reload and prevent another posting until verified recovery. Source-specific
storage and same-window events refresh the workbench. Read-only users cannot submit
or recover preparations; server Books/project/entity/current-source gates still apply.

Actual React/component-adapter verification against two disposable SQL fixtures
demonstrates lost coding and posting replies, exact recovery with one original receipt
and journal, unsaved-choice posting denial, an uncommitted failed selection, a lost
cancellation reply and fresh coding after recovery. The verified picker displays the
retained 4900 account. Browser error logs were empty. Evidence and screenshots are
retained in `docs/books-native-invoice-income-picker-evidence.json`. This uses explicit
fixture action aliases, not the complete authenticated Next.js application or its CSS.

Twenty-four focused render/workspace/service/recovery tests, repository TypeScript,
scoped lint and formatting pass. The pending posting guard also rejects a dangling
default-account selection reference when the current entity has no matching receipt,
before committing any money; an authorized selection repairs the reference. Scoped
guard/archive/service regressions verify this case. The preceding 3,564-test
financial/Books run remains historical broad evidence. Native current-schema
replay/RLS/pgTAP/concurrent sessions, full styling/mobile/auth journeys, governed
corrections, remaining monetary families/reporting/close/activation, company goldens,
intercompany/consolidation and independent CPA/real-builder acceptance remain required.

Native invoice correction proposal checkpoint (schema30): immutable preparatory
receipts now retain the exact original request, original native journal and SQL
reversal derivation. Private INVOKER insertion derives evidence itself, current
authority/actual source/period checks precede preparation, and exact saved retries
do not recapture changed source labels. Export validation closes original journal,
frozen definitions, historical preparation access and period holds. Populated
scoped recovery preserves original retries and permits fresh preparation; older
schema29 archives adapt an empty family without invented history. No approval,
correction journal, source revision or native activation is implemented by this
checkpoint. Separate review, atomic reversal/replacement, dependency/payment
history, durable resolution and integrated workflow remain required. Existing
strict shared journal origins and posted source protections remain in force.

Native invoice correction pair calculation checkpoint: an explicit internal
replacement calculation separates the correction posting date from the original
invoice/policy/contract/signed-closing date. Ordinary initial posting still requires
the original issue date. Prospective price and income-account choices carry the
correction identity; original income-selection receipts and journal legs stay intact.
The SQL helper independently revalidates current source/authority and derives both
legs without changing source or money. Existing reversal-only proposal history is
not reinterpreted as replacement approval. Explicit pair persistence, independent
review, atomic money/source revision and full workflow/recovery remain unfinished.
