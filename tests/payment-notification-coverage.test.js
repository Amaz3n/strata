const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

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
