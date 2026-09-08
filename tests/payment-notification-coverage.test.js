require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const {
  approvedReleaseSentence,
  paymentRunNotificationCopy,
  readReleaseKind,
} = require("../lib/payments/payment-run-notification-copy")
const { evaluateRunApprovability } = require("../lib/payments/payment-run-approval-policy")
const { resolvePayableDecisionAudience } = require("../lib/payments/payable-notification-audience")

// ---------------------------------------------------------------------------
// Exhaustive wiring check for every payment/AP/vendor notification.
//
// A NotificationType is only real when four separate things are true, and each
// one of them has silently been missing in production at some point:
//
//   (a) it is on EMAIL_NOTIFICATION_TYPES        — otherwise no email ever sends
//   (b) getNotificationRecipients resolves it    — otherwise it notifies nobody
//   (c) it has a case / title                    — otherwise it renders raw snake_case
//   (d) some recordEvent actually emits it       — otherwise it is dead weight
//
// The previous version of this check asserted five hardcoded keys, which is
// exactly how `vendor_payment_relationship_active`, `vendor_recipient_status_
// updated` and `payment_reversed_from_qbo` shipped notifying nobody. This one
// enumerates, so forgetting a step fails the build instead of failing quietly.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, "..")

const notificationsSrc = fs.readFileSync(path.join(ROOT, "lib/types/notifications.ts"), "utf8")
const eventsSrc = fs.readFileSync(path.join(ROOT, "lib/services/events.ts"), "utf8")

/** Every event type in the payment/AP/vendor money domain, by name shape. */
const PAYMENT_DOMAIN_PREFIXES = [
  "payment_",
  "vendor_bill_",
  "vendor_payment",
  "vendor_credit_",
  "vendor_recipient_",
  "vendor_transfer_",
  "vendor_payout_",
  "vendor_remittance_",
  "funding_source_",
  "disbursement_",
]

/** Money-domain types whose names do not carry a payment prefix. */
const PAYMENT_DOMAIN_EXTRAS = new Set(["payable_email_ingest"])

function isPaymentDomain(name) {
  if (PAYMENT_DOMAIN_EXTRAS.has(name)) return true
  return PAYMENT_DOMAIN_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/**
 * Event types produced by a template literal rather than a string constant.
 * The scanner records the literal prefix; these say which concrete types that
 * prefix is allowed to stand in for.
 */
const TEMPLATE_EVENT_PREFIXES = ["vendor_payment_relationship_", "funding_source_change_"]

function sliceBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker)
  assert.notEqual(start, -1, `expected to find ${startMarker}`)
  const end = endMarker ? src.indexOf(endMarker, start + startMarker.length) : -1
  assert.ok(!endMarker || end !== -1, `expected to find ${endMarker} after ${startMarker}`)
  return src.slice(start, end === -1 ? undefined : end)
}

function parseNotificationTypes() {
  const block = sliceBetween(notificationsSrc, "export type NotificationType =", "\n\n")
  return [...block.matchAll(/\| "([^"]+)"/g)].map((match) => match[1])
}

function parseEmailAllowlist() {
  const block = sliceBetween(
    notificationsSrc,
    "export const EMAIL_NOTIFICATION_TYPES = [",
    "] as const satisfies",
  )
  return [...block.matchAll(/key: "([^"]+)"/g)].map((match) => match[1])
}

function parseEmailCategories() {
  const block = sliceBetween(
    notificationsSrc,
    "export const NOTIFICATION_EMAIL_CATEGORIES = [",
    "] as const satisfies",
  )
  return [...block.matchAll(/key: "([^"]+)"/g)].map((match) => match[1])
}

function parseOperationalAllowlist() {
  const block = sliceBetween(
    eventsSrc,
    "export const OPERATIONAL_ONLY_PAYMENT_EVENTS = new Set<string>([",
    "])",
  )
  return new Set([...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]))
}

// Recipient resolution lives in getNotificationRecipients plus the module-level
// Sets it branches on, so both count as "has an audience".
const RECIPIENT_REGION =
  sliceBetween(eventsSrc, "type EventChannel", "export async function recordEvent") +
  sliceBetween(
    eventsSrc,
    "async function getNotificationRecipients",
    "async function getProjectFinancialNotificationRecipients",
  )

// A title comes from an explicit case in either the notification builder or the
// title map. Everything else falls through to `eventType.replace(/_/g, " ")`,
// which renders "vendor payment returned" as the subject line of a money email.
const TITLE_REGION =
  sliceBetween(eventsSrc, "function buildNotificationFromEvent", "/** Merge the bid package") +
  sliceBetween(eventsSrc, "function titleForEventType", null)

const SOURCE_DIRS = ["lib", "app", "components"]
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"])
/** Files that describe notifications rather than emit them. */
const NON_EMITTER_FILES = new Set([
  path.join(ROOT, "lib/types/notifications.ts"),
  path.join(ROOT, "lib/services/events.ts"),
  path.join(ROOT, "lib/services/notifications.ts"),
  path.join(ROOT, "lib/services/notification-email-delivery.ts"),
])

function collectSourceFiles(dir, into) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue
      collectSourceFiles(full, into)
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      into.push(full)
    }
  }
  return into
}

const SOURCE_FILES = SOURCE_DIRS.flatMap((dir) => collectSourceFiles(path.join(ROOT, dir), []))

/** Any module that raises an event or writes a notification directly. */
function isEmitterFile(src) {
  return src.includes("recordEvent(") || src.includes("createAndQueue(")
}

/**
 * The expressions that decide an event's type in one file.
 *
 * `eventType` is not always a string literal: it can be an inline ternary, a
 * template literal, or a variable assigned a few lines above the `recordEvent`
 * call. Both shapes are read, and only the value side — reading a fixed window
 * after the token instead would sweep in table names and audit entity types
 * from the surrounding call. Provider event types are a different namespace.
 */
function eventTypeExpressions(src) {
  const expressions = []
  // Up to the first comma, not the rest of the line: most recordEvent calls are
  // one-liners, so the line also carries entityType and the payload's own
  // strings.
  for (const match of src.matchAll(/\beventType:\s*([^,\n]*)/g)) expressions.push(match[1])
  for (const match of src.matchAll(/\b(?:const|let)\s+([A-Za-z_$]*[eE]ventType)\s*=\s*/g)) {
    if (/provider/i.test(match[1])) continue
    const rest = src.slice(match.index + match[0].length)
    const stop = rest.search(/\n\s*(?:const|let|await|return|export|if\b|\}|\/\/)/)
    expressions.push(stop === -1 ? rest.slice(0, 500) : rest.slice(0, stop))
  }
  return expressions
}

function scanEmittedEventTypes() {
  const literals = new Set()
  const templatePrefixes = new Set()
  const referencedByEmitters = new Set()
  for (const file of SOURCE_FILES) {
    if (NON_EMITTER_FILES.has(file)) continue
    const src = fs.readFileSync(file, "utf8")
    if (!isEmitterFile(src)) continue
    for (const quoted of src.matchAll(/"([a-z][a-z0-9_]*)"/g)) referencedByEmitters.add(quoted[1])
    for (const expression of eventTypeExpressions(src)) {
      for (const quoted of expression.matchAll(/"([a-z][a-z0-9_]*)"/g)) literals.add(quoted[1])
      for (const templated of expression.matchAll(/`([a-z][a-z0-9_]*)\$\{/g)) templatePrefixes.add(templated[1])
    }
  }
  return { literals, templatePrefixes, referencedByEmitters }
}

const NOTIFICATION_TYPES = parseNotificationTypes()
const EMAIL_ALLOWLIST = new Set(parseEmailAllowlist())
const EMAIL_CATEGORIES = new Set(parseEmailCategories())
const OPERATIONAL_ONLY = parseOperationalAllowlist()
const PAYMENT_TYPES = NOTIFICATION_TYPES.filter(isPaymentDomain)
const EMITTED = scanEmittedEventTypes()

function isEmitted(eventType) {
  if (EMITTED.literals.has(eventType)) return true
  if (EMITTED.referencedByEmitters.has(eventType)) return true
  for (const prefix of TEMPLATE_EVENT_PREFIXES) {
    if (eventType.startsWith(prefix) && EMITTED.templatePrefixes.has(prefix)) return true
  }
  return false
}

/**
 * `payable_email_ingest` is written straight through NotificationService rather
 * than raised as an event, so it has an audience by construction — the ingest
 * decides its own recipient. Everything else has to come from the event router.
 */
const DIRECT_NOTIFICATION_TYPES = new Set(["payable_email_ingest"])

function hasRecipientSet(type) {
  if (DIRECT_NOTIFICATION_TYPES.has(type)) return true
  return new RegExp(`\\b${type}\\b`).test(RECIPIENT_REGION)
}

test("the payment domain has notification types to check", () => {
  // A parse that silently returns nothing would make every assertion below
  // vacuously true, which is the failure mode this whole file exists to stop.
  assert.ok(PAYMENT_TYPES.length >= 30, `expected the payment domain to be enumerated, got ${PAYMENT_TYPES.length}`)
  assert.ok(EMAIL_ALLOWLIST.size >= 40, `expected a populated email allowlist, got ${EMAIL_ALLOWLIST.size}`)
  assert.ok(OPERATIONAL_ONLY.size > 0, "expected OPERATIONAL_ONLY_PAYMENT_EVENTS to be populated")
  assert.ok(EMITTED.literals.size > 50, `expected recordEvent scanning to find event types, got ${EMITTED.literals.size}`)
})

test("every payment notification type is on the email allowlist", () => {
  const missing = PAYMENT_TYPES.filter((type) => !EMAIL_ALLOWLIST.has(type))
  assert.deepEqual(
    missing,
    [],
    `these payment notification types are declared but can never send email — add them to EMAIL_NOTIFICATION_TYPES: ${missing.join(", ")}`,
  )
})

test("every payment notification type resolves to a recipient set", () => {
  const missing = PAYMENT_TYPES.filter((type) => !hasRecipientSet(type))
  assert.deepEqual(
    missing,
    [],
    `these payment notification types resolve to an empty audience and notify nobody — give them a branch in getNotificationRecipients: ${missing.join(", ")}`,
  )
})

test("every payment notification type has a real title", () => {
  const missing = PAYMENT_TYPES.filter((type) => !TITLE_REGION.includes(`case "${type}":`))
  assert.deepEqual(
    missing,
    [],
    `these payment notification types fall through to a raw snake_case title — add a case to buildNotificationFromEvent or titleForEventType: ${missing.join(", ")}`,
  )
})

test("every payment notification type is actually emitted", () => {
  const orphans = PAYMENT_TYPES.filter((type) => !isEmitted(type))
  assert.deepEqual(
    orphans,
    [],
    `these payment notification types are wired but nothing emits them — delete them or emit them: ${orphans.join(", ")}`,
  )
})

test("every payment notification type belongs to a settings category", () => {
  // Without a category the toggle renders in no group at all, so a bookkeeper
  // cannot find it and cannot turn it off.
  const block = sliceBetween(
    notificationsSrc,
    "export const EMAIL_NOTIFICATION_TYPES = [",
    "] as const satisfies",
  )
  const entries = [...block.matchAll(/key: "([^"]+)",\s*\n\s*category: "([^"]+)"/g)]
  const categoryByKey = new Map(entries.map((match) => [match[1], match[2]]))
  const uncategorized = PAYMENT_TYPES.filter((type) => !categoryByKey.has(type))
  assert.deepEqual(uncategorized, [], `missing a category: ${uncategorized.join(", ")}`)
  for (const [key, category] of categoryByKey) {
    assert.ok(EMAIL_CATEGORIES.has(category), `${key} points at unknown category "${category}"`)
  }
  assert.equal(categoryByKey.size, EMAIL_ALLOWLIST.size, "every allowlist entry needs a category")
})

test("every emitted payment event is notified or explicitly declared operational", () => {
  const emittedPaymentEvents = [...EMITTED.literals].filter(isPaymentDomain)
  const declared = new Set(NOTIFICATION_TYPES)
  const unhandled = emittedPaymentEvents
    .filter((eventType) => !declared.has(eventType) && !OPERATIONAL_ONLY.has(eventType))
    .sort()
  assert.deepEqual(
    unhandled,
    [],
    `these payment events are emitted but neither notified nor declared operational — add a NotificationType, or add them to OPERATIONAL_ONLY_PAYMENT_EVENTS with a reason: ${unhandled.join(", ")}`,
  )
})

test("a payment event cannot be both notified and declared operational", () => {
  const contradictions = NOTIFICATION_TYPES.filter((type) => OPERATIONAL_ONLY.has(type))
  assert.deepEqual(
    contradictions,
    [],
    `declared both notifiable and intentionally silent: ${contradictions.join(", ")}`,
  )
})

test("the operational allowlist stays honest", () => {
  // An entry for an event nobody emits any more is a claim the code no longer
  // makes; it has to be deleted with the emit site, not left as cover.
  const stale = [...OPERATIONAL_ONLY].filter((eventType) => !EMITTED.literals.has(eventType)).sort()
  assert.deepEqual(
    stale,
    [],
    `OPERATIONAL_ONLY_PAYMENT_EVENTS names events nothing emits — delete them: ${stale.join(", ")}`,
  )
})

test("every payment notification links somewhere real", () => {
  const delivery = fs.readFileSync(path.join(ROOT, "lib/services/notification-email-delivery.ts"), "utf8")
  const router = sliceBetween(delivery, "function buildNotificationHref", "/**\n * Render the reconciliation")

  // The entity types payment events attach to. Any of them falling through to
  // the project-scoped switch loses its button, because these alerts are
  // org-scoped and carry no project.
  for (const entityType of [
    "payment_run",
    "disbursement",
    "payment_reconciliation_run",
    "payment_recipient_account",
    "vendor_payment_relationship",
    "org_funding_source",
    "payment_control_change",
    "payment_rail_policy",
  ]) {
    assert.ok(router.includes(`case "${entityType}":`), `${entityType} has no deep link`)
  }

  // Every route the router can produce has to exist as a real page.
  const routes = [...router.matchAll(/["`](\/[a-z0-9\-/?=${}.]*)["`]/g)].map((match) => match[1])
  assert.ok(routes.length > 0, "expected the href router to name routes")
  const knownRoots = new Set([
    "payables",
    "companies",
    "settings",
    "projects",
    "estimates",
    "pipeline",
    "invoices",
  ])
  for (const route of routes) {
    const root = route.split("?")[0].split("/").filter(Boolean)[0]
    if (!root) continue
    assert.ok(knownRoots.has(root), `href router points at an unknown root: ${route}`)
    assert.ok(
      fs.existsSync(path.join(ROOT, "app/(app)", root)),
      `href router points at a route that does not exist: /${root}`,
    )
  }

  // `/payments/{id}` never existed — /payments is a redirect with no [id]
  // segment — so a payment search hit 404'd. It must not come back.
  const searchConfig = fs.readFileSync(path.join(ROOT, "lib/services/search-config.ts"), "utf8")
  assert.doesNotMatch(searchConfig, /hrefTemplate: '\/payments\//)
})

// ---------------------------------------------------------------------------
// Phase F — one emitter per event, and copy that matches what happened.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations")

/**
 * The event types SQL still raises, reading only the definition that survives.
 *
 * A migration file is history: `20260805092000` really does insert
 * `vendor_bill_approved`, and that line cannot be edited away. What matters is
 * the last `create [or replace] function` for each name, because that is the
 * body Postgres is running. Anything else would either fail forever on the past
 * or pass forever by ignoring it.
 */
function scanSqlEventEmitters() {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort()
  const latestBody = new Map()
  for (const file of files) {
    const src = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8")
    for (const match of src.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(public\.[a-z0-9_]+)/gi)) {
      const rest = src.slice(match.index)
      const openQuote = rest.match(/as\s+(\$[a-z_]*\$)/i)
      if (!openQuote) continue
      const bodyStart = rest.indexOf(openQuote[1], openQuote.index) + openQuote[1].length
      const bodyEnd = rest.indexOf(openQuote[1], bodyStart)
      if (bodyEnd === -1) continue
      latestBody.set(match[1].toLowerCase(), { file, body: rest.slice(bodyStart, bodyEnd) })
    }
  }

  const emitters = []
  for (const [functionName, { file, body }] of latestBody) {
    // Comments survive into `pg_get_functiondef`, and this migration's own
    // comment explains why the insert is gone — in the words "insert into
    // public.events". Reading them as code makes a function that raises nothing
    // look like a shadowing emitter, and the assertion pass or fail on prose.
    const code = body.replace(/--[^\n]*/g, "")
    for (const insert of code.matchAll(/insert\s+into\s+(?:public\.)?events\b/gi)) {
      const statement = code.slice(insert.index, code.indexOf(";", insert.index) + 1)
      for (const quoted of statement.matchAll(/'([a-z][a-z0-9_]*)'/g)) {
        emitters.push({ functionName, file, eventType: quoted[1] })
      }
    }
  }
  return emitters
}

const SQL_EVENT_EMITTERS = scanSqlEventEmitters()

test("SQL and TypeScript do not emit duplicate events for the same mutation path", () => {
  // Daily log submission owns its events in the transaction. The photo helper's
  // independent createDailyLog path and ordinary schedule edits have TS emitters.
  // Sharing an event type across distinct mutations is required for subscribers;
  // calling both emitters for one mutation is the defect this guard prevents.
  const projectActions = fs.readFileSync(path.join(ROOT, "app/(app)/projects/[id]/actions.ts"), "utf8")
  const actionStart = projectActions.indexOf("export async function createProjectDailyLogAction")
  const actionEnd = projectActions.indexOf("export async function", actionStart + 1)
  assert.ok(actionStart >= 0 && actionEnd > actionStart)
  const submission = projectActions.slice(actionStart, actionEnd)
  assert.match(submission, /rpc\("create_daily_log_submission"/)
  assert.doesNotMatch(submission, /recordEvent\(|createDailyLog\(|updateScheduleItem\(/)
  assert.match(submission, /for \(const event of events\) await createNotificationsFromEvent/)
  const distinctSubmissionEvent = emitter => emitter.functionName === "public.create_daily_log_submission" &&
    ["daily_log_created", "schedule_item_updated"].includes(emitter.eventType)
  // WS-F1. `approve_vendor_bills_atomic` inserted `vendor_bill_approved` while
  // `approveVendorBillsAtomic` raised the same type through `recordEvent`, so
  // bulk-approving fifty payables produced a hundred events and two
  // notifications per bill — one of them with a payload too thin to find the
  // submitter. One mutation must have exactly one event owner.
  const shadowed = SQL_EVENT_EMITTERS.filter(
    (emitter) =>
      (isPaymentDomain(emitter.eventType) || NOTIFICATION_TYPES.includes(emitter.eventType)) &&
      EMITTED.literals.has(emitter.eventType) && !distinctSubmissionEvent(emitter),
  ).map((emitter) => `${emitter.functionName} (${emitter.file}) → ${emitter.eventType}`)
  assert.deepEqual(
    shadowed,
    [],
    `these SQL functions overlap a TypeScript event emitter without a verified independent mutation path: ${shadowed.join(", ")}`,
  )
})

test("the SQL emitter scan reads code, not the comments about it", () => {
  // Both this scanner and the pgTAP twin first matched the Phase F migration's
  // own explanatory comment, so the check was passing on prose that happened to
  // sit near an unrelated insert.
  const fromBulkApproval = SQL_EVENT_EMITTERS.filter(
    (emitter) => emitter.functionName === "public.approve_vendor_bills_atomic",
  )
  assert.deepEqual(
    fromBulkApproval,
    [],
    `approve_vendor_bills_atomic must raise no events at all: ${fromBulkApproval.map((e) => e.eventType).join(", ")}`,
  )
})

test("the SQL emitter scan actually reads the migrations", () => {
  // The check above is vacuous if the parser stops finding inserts, and it has
  // one live example to prove it does not: retainage release is SQL-only.
  const found = SQL_EVENT_EMITTERS.map((emitter) => emitter.eventType)
  assert.ok(found.includes("vendor_bill_retainage_released"), `expected the scanner to see SQL event inserts, saw ${found.join(", ") || "nothing"}`)
})

test("bulk approval raises one event per bill, with the payload the router needs", () => {
  const service = fs.readFileSync(path.join(ROOT, "lib/services/vendor-bills.ts"), "utf8")
  const bulk = sliceBetween(service, "export async function approveVendorBillsAtomic", "export const vendorBillSelect")
  assert.match(bulk, /eventType: "vendor_bill_approved"/)
  // Without the submitter the decision notification falls back to everyone
  // holding the permission, which is how a bulk approval mailed people who had
  // never seen the invoice.
  assert.match(bulk, /submitted_by_user_id/)
  assert.match(bulk, /amount_cents/)
  assert.match(bulk, /bill_number/)
  assert.match(bulk, /project_id/)
})

test("a quick-capture draft does not page approvers, and completing it does", () => {
  // WS-F2. Every draft used to emit `vendor_bill_submitted` at create — an
  // approval request for a payable nobody could yet approve — and completing it
  // emitted `vendor_bill_updated`, which resolves to no audience at all.
  const service = fs.readFileSync(path.join(ROOT, "lib/services/vendor-bills.ts"), "utf8")
  const create = sliceBetween(service, "export async function createProjectVendorBill", "export async function createProjectVendorCredit")
  assert.match(create, /if \(parsed\.creation_state !== "draft"\) \{[\s\S]*?eventType: "vendor_bill_submitted"/)

  const update = sliceBetween(service, "export async function updateVendorBillStatus", "export async function createProjectVendorBill")
  assert.match(update, /becameReadyForApproval[\s\S]*?\? "vendor_bill_submitted"/)

  const ingest = fs.readFileSync(path.join(ROOT, "lib/services/payables-email-ingest.ts"), "utf8")
  assert.match(ingest, /if \(!extractionIncomplete\) \{[\s\S]*?eventType: "vendor_bill_submitted"/)
})

test("payable approvers are found org-wide, not only through project membership", () => {
  // A controller scoped to every project appears in no `project_members` row, so
  // the person who actually approves the invoices was the one person the
  // approval request never reached.
  assert.match(eventsSrc, /async function getOrgWideCandidates/)
  assert.match(eventsSrc, /policyVersion: "payable-lifecycle-v1",\s*\n\s*includeOrgWide: true,/)
  // null has always meant org-wide; `.neq` would have dropped exactly those rows.
  assert.match(eventsSrc, /row\.project_scope !== "assigned"/)
})

test("a submitted run pages only the approvers who could decide it", () => {
  // WS-F3. The roster was mailed wholesale, so a $10k-ceiling approver was paged
  // about a $400k run and a divisional approver about work outside their
  // division — requests the server would refuse.
  assert.match(RECIPIENT_REGION, /loadPaymentApproverRoster\(orgId\)/)
  assert.match(RECIPIENT_REGION, /evaluateRunApprovability\(\{/)
  assert.match(RECIPIENT_REGION, /getPaymentRunDivisionIds\(supabase, orgId, event\.entity_id\)/)
})

test("a partial approval notifies the preparer only when another approval is possible", () => {
  assert.match(
    RECIPIENT_REGION,
    /payment_run_approval_recorded[\s\S]*?approval_mode_snapshot === "dual"[\s\S]*?status !== "pending_approval"\) return \[\]/,
  )
})

test("evaluateRunApprovability is the one rule the UI and the audience share", () => {
  const roster = [
    { userId: "ceiling", approvalLimitCents: 100_000, divisionId: null },
    { userId: "orgwide", approvalLimitCents: null, divisionId: null },
    { userId: "westside", approvalLimitCents: null, divisionId: "west" },
  ]
  const ask = (viewerId, overrides = {}) =>
    evaluateRunApprovability({
      viewerId,
      requestedBy: "preparer",
      totalDebitCents: 400_000,
      runDivisionIds: [],
      controlSnapshot: {},
      routing: { viewerMayApprove: true, approvers: roster },
      ...overrides,
    }).mayDecide

  assert.equal(ask("ceiling"), false, "an approver under their ceiling must not be paged")
  assert.equal(ask("orgwide"), true)
  assert.equal(ask("westside"), false, "a divisional approver cannot decide an undivisioned run")
  assert.equal(ask("westside", { runDivisionIds: ["west"] }), true)
  assert.equal(ask("westside", { runDivisionIds: ["west", "east"] }), false)
  assert.equal(ask("preparer"), false, "the preparer is never their own approver")
  assert.equal(ask("orgwide", { routing: { viewerMayApprove: false, approvers: roster } }), false)
  assert.equal(
    ask("orgwide", { controlSnapshot: { preferred_approver_ids: ["ceiling"] } }),
    false,
    "a routed run pages the approvers it names",
  )
})

test("an approved run is not told it released when it did not", () => {
  // WS-F4. Every approval said "approved and on its way to the vendor" — for a
  // run scheduled three days out, for one queued because the approver's role
  // cannot move money, and for one a gate stopped outright.
  const released = paymentRunNotificationCopy({
    eventType: "payment_run_approved",
    vendorName: "Acme Concrete",
    billNumber: "1042",
    totalDebitCents: 400_000,
    release: "released",
  })
  assert.match(released.title, /^Payment approved: \$4,000\.00$/)
  assert.match(released.message, /funding started/)

  const scheduled = paymentRunNotificationCopy({
    eventType: "payment_run_approved",
    billCount: 6,
    totalDebitCents: 400_000,
    release: "scheduled",
    releaseScheduledFor: "2026-09-14",
  })
  assert.match(scheduled.title, /approved and scheduled/)
  assert.match(scheduled.message, /September 14, 2026/)
  assert.doesNotMatch(scheduled.message, /funding started/)

  const blocked = paymentRunNotificationCopy({
    eventType: "payment_run_approved",
    totalDebitCents: 400_000,
    release: "blocked",
    releaseReason: "Daily payment limit reached",
  })
  assert.match(blocked.title, /approved but held/)
  assert.match(blocked.message, /Daily payment limit reached/)

  const queued = paymentRunNotificationCopy({
    eventType: "payment_run_approved",
    totalDebitCents: 400_000,
    release: "queued",
    releaseReason: "Releasing money is not part of your role, so Arc sends it on the next release pass.",
  })
  assert.match(queued.message, /next release pass/)
  assert.doesNotMatch(queued.message, /funding started/)

  // A payload from before this shipped carries no `release`, and must not be
  // read as a release that happened.
  assert.equal(readReleaseKind(undefined), "none")
  assert.equal(readReleaseKind("released"), "released")
  assert.equal(readReleaseKind("nonsense"), "none")
  assert.doesNotMatch(approvedReleaseSentence({ eventType: "payment_run_approved" }), /funding started/)
})

test("a partial approval says what is still missing", () => {
  const recorded = paymentRunNotificationCopy({
    eventType: "payment_run_approval_recorded",
    billCount: 3,
    totalDebitCents: 900_00,
  })
  assert.match(recorded.message, /still needs another approval/)
})

test("the approval email and the in-app notice tell the same story", () => {
  const template = fs.readFileSync(path.join(ROOT, "lib/emails/payment-run-approval-email.tsx"), "utf8")
  // The banner said "Payment Released" for every approved run regardless of
  // whether anything released.
  assert.doesNotMatch(template, /approved: "Payment Released"/)
  assert.match(template, /approvedReleaseSentence\(\{/)
  // heroMeta was computed and never rendered, so the body never named the
  // outcome at all.
  assert.match(template, /\{heroMeta\}/)
  const delivery = fs.readFileSync(path.join(ROOT, "lib/services/notification-email-delivery.ts"), "utf8")
  assert.match(delivery, /release: readReleaseKind\(args\.payload\.release\)/)
  assert.match(delivery, /releaseReason: readString\(args\.payload, "release_reason"\)/)
})

test("a return is written to Arc before it is pushed to the accounting provider", () => {
  // WS-F5. The webhook used to call the accounting void inline, so a provider
  // timeout could leave the builder's ledger reversed and their books not — or
  // stop the notification from being sent at all.
  const providerEvents = fs.readFileSync(path.join(ROOT, "lib/services/payment-provider-events.ts"), "utf8")
  assert.doesNotMatch(providerEvents, /voidBillPaymentInAccounting/)
  assert.match(providerEvents, /enqueueBillPaymentVoid\(\{ orgId, paymentId: paymentIdToVoid/)
})

test("every Phase F notification type is wired end to end", () => {
  // The generic sweeps above enumerate; this one names the six types the Phase F
  // review listed, so a rename cannot quietly drop one out of the domain filter.
  const phaseFTypes = [
    "vendor_bill_submitted",
    "vendor_bill_approved",
    "vendor_bill_rejected",
    "payment_run_submitted",
    "payment_run_approved",
    "payment_run_approval_recorded",
    "payment_run_rejected",
    "vendor_payment_paid",
    "vendor_payment_returned",
    "vendor_bill_payment_reversed",
    "payment_run_execution_failed",
  ]
  for (const type of phaseFTypes) {
    assert.ok(NOTIFICATION_TYPES.includes(type), `${type} is not a declared NotificationType`)
    assert.ok(isPaymentDomain(type), `${type} falls outside the payment domain filter`)
    assert.ok(EMAIL_ALLOWLIST.has(type), `${type} can never send email`)
    assert.ok(hasRecipientSet(type), `${type} resolves to no audience`)
    assert.ok(TITLE_REGION.includes(`case "${type}":`), `${type} has no title`)
    assert.ok(isEmitted(type), `${type} is wired but nothing emits it`)
  }
})

test("a submitted run is never left with nobody to tell", () => {
  // Submission already refuses a run nobody can approve, so an empty eligible
  // set means the roster moved under a run that is sitting in pending_approval.
  // Silence there is a payment that ages out unseen.
  assert.match(
    RECIPIENT_REGION,
    /const audience = eligible\.length > 0\s*\n\s*\? eligible\s*\n\s*: roster\.filter\(\(approver\) => approver\.permitted\)/,
  )
})

test("bulk-approving five bills from three submitters reaches those three, each about their own", () => {
  // WS-F1's definition of done, at the level this repo can assert without a
  // live transport: five events, each carrying its own submitter, each
  // resolving to exactly that person. Before Phase F the bulk RPC's event
  // carried no submitter at all, so all five fell through to the whole
  // permission-derived audience — and a second, duplicate event did the same.
  const finance = ["controller", "bookkeeper", "sam", "riley", "jo"]
  const bills = [
    { id: "b1", submitter: "sam" },
    { id: "b2", submitter: "sam" },
    { id: "b3", submitter: "riley" },
    { id: "b4", submitter: "jo" },
    { id: "b5", submitter: "jo" },
  ]
  const delivered = bills.map((bill) => ({
    id: bill.id,
    to: resolvePayableDecisionAudience({ eligibleRecipients: finance, payloadSubmitterId: bill.submitter }),
  }))
  assert.equal(delivered.length, 5, "one notification per approved bill")
  for (const [index, row] of delivered.entries()) {
    assert.deepEqual(row.to, [bills[index].submitter], `${row.id} must reach only its submitter`)
  }
  assert.deepEqual([...new Set(delivered.flatMap((row) => row.to))].sort(), ["jo", "riley", "sam"])

  // A submitter who lost access to the bill is not mailed a link to it.
  assert.deepEqual(
    resolvePayableDecisionAudience({ eligibleRecipients: ["controller"], payloadSubmitterId: "departed" }),
    [],
  )
  // An older payable whose decision event carries no submitter falls back to
  // the original submission's actor, and only then to the whole audience —
  // silence is the worse failure.
  assert.deepEqual(
    resolvePayableDecisionAudience({ eligibleRecipients: finance, submissionActorId: "riley" }),
    ["riley"],
  )
  assert.deepEqual(resolvePayableDecisionAudience({ eligibleRecipients: finance }), finance)
})
