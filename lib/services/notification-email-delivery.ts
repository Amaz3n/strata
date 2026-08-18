import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { AccountingReconciliationEmail } from "@/lib/emails/accounting-reconciliation-email"
import {
  BankChangeReviewEmail,
  PaymentReturnedEmail,
  PaymentRunApprovalEmail,
  type BankChangeKind,
  type PaymentReturnKind,
  type PaymentRunEmailKind,
  type PaymentRunEmailLine,
} from "@/lib/emails"
import {
  escapeHtml,
  getOrgSenderEmail,
  renderEmailTemplate,
  renderStandardEmailLayout,
  sendEmail,
} from "@/lib/services/mailer"
import { formatDigestMoney } from "@/lib/services/books/reconciliation-digest"
import { loadReconciliationDigest } from "@/lib/services/books/reconciliation"
import { EMAIL_NOTIFICATION_TYPES } from "@/lib/types/notifications"

/** How many findings the email lists before it falls back to "+ N more". */
const TOP_FINDINGS_IN_EMAIL = 6

/** How many bills a payment-run email itemizes before it summarizes the rest. */
const TOP_RUN_LINES_IN_EMAIL = 8

type ServiceSupabaseClient = ReturnType<typeof createServiceSupabaseClient>

/**
 * Payment amounts are exact or they are wrong. `formatDigestMoney` rounds to
 * whole dollars, which is fine for a drift summary and unacceptable for the
 * figure someone is about to release from a bank account.
 */
function formatMoneyCents(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
}

function formatDateLabel(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC"
}

function formatDayLabel(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

function readCents(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key]
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function bankLabel(name: unknown, last4: unknown): string | null {
  const bank = typeof name === "string" && name.length > 0 ? name : null
  const digits = typeof last4 === "string" && last4.length > 0 ? last4 : null
  if (bank && digits) return `${bank} ···· ${digits}`
  if (digits) return `···· ${digits}`
  return bank
}

function isEmailEligible(notificationType: string) {
  return EMAIL_NOTIFICATION_TYPES.some((type) => type.key === notificationType)
}

function emailTypeIsEnabled(settings: unknown, notificationType: string) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return true
  }
  return Reflect.get(settings, notificationType) !== false
}

function buildNotificationHref(payload: Record<string, unknown>): string | null {
  // An event that already knows where its notification points says so on the
  // payload. Without this the entity-type switch below is the only router, so an
  // org-scoped notification with no project silently lost its button.
  if (typeof payload.href === "string" && payload.href.startsWith("/")) return payload.href

  const projectId = typeof payload.project_id === "string" ? payload.project_id : null
  const entityType = typeof payload.entity_type === "string" ? payload.entity_type : null
  const entityId = typeof payload.entity_id === "string" ? payload.entity_id : null
  const logId = typeof payload.daily_log_id === "string" ? payload.daily_log_id : null
  const billId = typeof payload.bill_id === "string" ? payload.bill_id : null
  const runId = typeof payload.payment_run_id === "string" ? payload.payment_run_id : null
  const companyId = typeof payload.company_id === "string" ? payload.company_id : null

  if (entityType === "estimate") {
    return typeof payload.prospect_id === "string" ? "/pipeline" : "/estimates"
  }

  // Every payment entity type has to resolve here, before the project guard.
  // These alerts are org-scoped by nature — a returned payout, a stalled run, a
  // funding bank waiting on review — so falling through to `if (!projectId)`
  // stripped the button off the emails that most needed one.
  switch (entityType) {
    case "payment_run":
      return billId ? `/payables?bill=${billId}` : entityId ? `/payables?run=${entityId}` : "/payables"
    case "disbursement":
      // A disbursement has no surface of its own; it resolves to the payable it
      // paid, or to the run that carried it.
      return billId ? `/payables?bill=${billId}` : runId ? `/payables?run=${runId}` : "/payables"
    case "payment_reconciliation_run":
      return "/payables/reconciliation"
    case "payment_recipient_account":
    case "vendor_payment_relationship":
      // The vendor's own record is where readiness, holds, and payout status
      // live for the builder.
      return companyId ? `/directory/${companyId}` : "/payables"
    case "org_funding_source":
    case "payment_control_change":
    case "payment_rail_policy":
      return "/settings?tab=payments"
  }

  if (!projectId) return null

  switch (entityType) {
    case "rfi":
      return `/projects/${projectId}/rfis`
    case "submittal":
      return `/projects/${projectId}/submittals`
    case "invoice":
      return `/projects/${projectId}/invoices`
    case "payment":
      return `/projects/${projectId}/financials/receivables`
    case "change_order":
      return `/projects/${projectId}/change-orders`
    case "file":
      return entityId
        ? `/projects/${projectId}/documents?fileId=${entityId}`
        : `/projects/${projectId}/documents`
    case "drawing_set":
    case "drawing_sheet":
    case "drawing_revision":
      return `/projects/${projectId}/drawings`
    case "task":
      return `/projects/${projectId}/tasks`
    case "daily_log":
      return logId
        ? `/projects/${projectId}/daily-logs?logId=${logId}`
        : `/projects/${projectId}/daily-logs`
    case "vendor_bill":
      return `/payables?bill=${entityId ?? ""}`
    default:
      return `/projects/${projectId}`
  }
}

/**
 * Render the reconciliation drift email from the run that produced it.
 *
 * Null means "this pass has nothing worth a bespoke email" — a missing run, or a
 * queue that has since been emptied — and the caller falls back to the generic
 * layout rather than dropping the notification.
 */
async function renderReconciliationDriftEmail(args: {
  payload: Record<string, unknown>
  orgId: string
  recipientName: string | null
  orgName: string | null
  orgLogoUrl: string | null
  appUrl: string
  queueUrl: string
  sentAt: string
}): Promise<string | null> {
  const runId = typeof args.payload.entity_id === "string" ? args.payload.entity_id : null
  if (!runId) return null

  const digest = await loadReconciliationDigest({
    orgId: args.orgId,
    runId,
    newCount:
      typeof args.payload.new_discrepancy_count === "number" ? args.payload.new_discrepancy_count : 0,
    topItemLimit: TOP_FINDINGS_IN_EMAIL,
  })
  if (!digest || digest.openCount === 0) return null

  // A notification written before the count was carried on the payload still has
  // a real queue behind it; reporting the open total beats reporting zero.
  const newCount = digest.newCount > 0 ? digest.newCount : digest.openCount

  return renderEmailTemplate(
    AccountingReconciliationEmail({
      orgName: args.orgName,
      orgLogoUrl: args.orgLogoUrl,
      recipientName: args.recipientName,
      runDateLabel: `Nightly pass · ${new Date(args.sentAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })}`,
      headline: `${newCount} new finding${newCount === 1 ? "" : "s"}`,
      metrics: [
        { label: "New tonight", value: String(newCount) },
        { label: "Open total", value: String(digest.openCount) },
        {
          label: "Critical",
          value: String(digest.criticalCount),
          tone: digest.criticalCount > 0 ? "critical" : "neutral",
        },
        {
          label: "Unexplained",
          value: digest.exposureCents > 0 ? formatDigestMoney(digest.exposureCents) : "—",
          tone: digest.exposureCents > 0 ? "critical" : "neutral",
        },
        { label: "Cleared", value: String(digest.resolvedCount) },
      ],
      findings: digest.topItems.map((item) => ({
        label: item.label,
        severity: item.severity,
        description: item.description,
        projectName: item.projectId,
        amountLabel: item.amountCents ? formatDigestMoney(item.amountCents) : null,
        // Item hrefs are app-relative; an email link has to be absolute.
        href: item.href ? `${args.appUrl}${item.href}` : null,
      })),
      remainingCount: Math.max(0, digest.openCount - digest.topItems.length),
      groups: digest.groups.map((group) => ({
        label: group.label,
        severity: group.severity,
        countLabel: String(group.count),
        amountLabel: group.amountCents > 0 ? formatDigestMoney(group.amountCents) : null,
      })),
      coverageNotes: digest.coverageNotes,
      queueUrl: args.queueUrl,
    }),
  )
}

const PAYMENT_RUN_EMAIL_KIND: Record<string, PaymentRunEmailKind> = {
  payment_run_submitted: "awaiting",
  payment_run_approved: "approved",
  payment_run_rejected: "rejected",
  payment_run_approval_recorded: "recorded",
}

/**
 * Render a payment run's approval email from the run itself.
 *
 * The highest-stakes approval in the product cannot be a one-line "a payment run
 * needs approval" — an approver who has to open the app to learn the amount will
 * eventually approve without opening it. The run is read fresh rather than
 * trusted from the payload so the figures in the email are the figures in the
 * database at send time.
 *
 * Null falls back to the generic layout: a run that has since been deleted still
 * deserves its notification, just without the detail.
 */
async function renderPaymentRunEmail(args: {
  supabase: ServiceSupabaseClient
  payload: Record<string, unknown>
  notificationType: string
  orgId: string
  recipientName: string | null
  orgName: string | null
  orgLogoUrl: string | null
  actionUrl: string
}): Promise<string | null> {
  const kind = PAYMENT_RUN_EMAIL_KIND[args.notificationType]
  const runId = readString(args.payload, "entity_id")
  if (!kind || !runId) return null

  const { data: run } = await args.supabase
    .from("payment_runs")
    .select(
      "id, total_debit_cents, vendor_amount_cents, processor_fee_cents, platform_fee_cents, payment_count, required_approvals, requested_by, funding_source_id, scheduled_for",
    )
    .eq("org_id", args.orgId)
    .eq("id", runId)
    .maybeSingle()
  if (!run) return null

  const [{ data: items }, { data: approvals }, { data: preparer }, { data: funding }] = await Promise.all([
    args.supabase
      .from("payment_run_items")
      .select("bill_id, project_id, vendor_amount_cents")
      .eq("org_id", args.orgId)
      .eq("run_id", runId)
      .order("vendor_amount_cents", { ascending: false })
      .limit(TOP_RUN_LINES_IN_EMAIL),
    args.supabase.from("payment_run_approvals").select("id").eq("org_id", args.orgId).eq("run_id", runId),
    run.requested_by
      ? args.supabase.from("app_users").select("full_name").eq("id", run.requested_by).maybeSingle()
      : Promise.resolve({ data: null }),
    run.funding_source_id
      ? args.supabase
          .from("org_funding_sources")
          .select("bank_name, last4")
          .eq("org_id", args.orgId)
          .eq("id", run.funding_source_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const itemRows = items ?? []
  const billIds = itemRows
    .map((item) => item.bill_id)
    .filter((value): value is string => typeof value === "string")
  const projectIds = [
    ...new Set(itemRows.map((item) => item.project_id).filter((value): value is string => typeof value === "string")),
  ]

  const { data: bills } = billIds.length > 0
    ? await args.supabase
        .from("vendor_bills")
        .select("id, bill_number, company_id")
        .eq("org_id", args.orgId)
        .in("id", billIds)
    : { data: [] }
  const billRows = bills ?? []
  const companyIds = [
    ...new Set(billRows.map((bill) => bill.company_id).filter((value): value is string => typeof value === "string")),
  ]

  const [{ data: companies }, { data: projects }] = await Promise.all([
    companyIds.length > 0
      ? args.supabase.from("companies").select("id, name").eq("org_id", args.orgId).in("id", companyIds)
      : Promise.resolve({ data: [] }),
    projectIds.length > 0
      ? args.supabase.from("projects").select("id, name").eq("org_id", args.orgId).in("id", projectIds)
      : Promise.resolve({ data: [] }),
  ])

  const billById = new Map(billRows.map((bill) => [bill.id, bill]))
  const companyById = new Map((companies ?? []).map((company) => [company.id, company.name]))
  const projectById = new Map((projects ?? []).map((project) => [project.id, project.name]))

  const lines: PaymentRunEmailLine[] = itemRows.map((item) => {
    const bill = typeof item.bill_id === "string" ? billById.get(item.bill_id) : undefined
    const vendorName =
      bill?.company_id && companyById.get(bill.company_id) ? String(companyById.get(bill.company_id)) : "Vendor"
    return {
      vendorName,
      billLabel: bill?.bill_number ? `Invoice ${bill.bill_number}` : "Invoice —",
      projectName: typeof item.project_id === "string" ? (projectById.get(item.project_id) ?? null) : null,
      amountLabel: formatMoneyCents(Number(item.vendor_amount_cents ?? 0)),
    }
  })

  const vendorCount = new Set(lines.map((line) => line.vendorName)).size
  const paymentCount = Number(run.payment_count ?? lines.length)
  const feeCents = Number(run.processor_fee_cents ?? 0) + Number(run.platform_fee_cents ?? 0)

  return renderEmailTemplate(
    PaymentRunApprovalEmail({
      orgName: args.orgName,
      orgLogoUrl: args.orgLogoUrl,
      recipientName: args.recipientName,
      kind,
      totalDebitLabel: formatMoneyCents(Number(run.total_debit_cents ?? 0)),
      vendorAmountLabel: formatMoneyCents(Number(run.vendor_amount_cents ?? 0)),
      feeLabel: feeCents > 0 ? formatMoneyCents(feeCents) : null,
      paymentCount,
      vendorCount: vendorCount > 0 ? vendorCount : paymentCount,
      preparerName: preparer?.full_name ?? null,
      fundingLabel: bankLabel(funding?.bank_name, funding?.last4),
      scheduledLabel: formatDayLabel(run.scheduled_for),
      approvalsRequired: Number(run.required_approvals ?? 1),
      approvalsRecorded: (approvals ?? []).length,
      lines,
      remainingCount: Math.max(0, paymentCount - lines.length),
      reason: readString(args.payload, "reason"),
      actionUrl: args.actionUrl,
    }),
  )
}

const PAYMENT_RETURN_EMAIL_KIND: Record<string, PaymentReturnKind> = {
  vendor_payment_returned: "vendor_returned",
  vendor_transfer_needs_attention: "transfer_blocked",
  vendor_bill_payment_reversed: "vendor_unrecorded",
  payment_reversed: "customer_reversed",
  payment_reversed_from_qbo: "qbo_reversed",
}

/**
 * Render the "money came back" email.
 *
 * These four events are the only ones in the rail where a builder's bank balance
 * disagrees with what Arc previously told them, so the email leads with the
 * amount and says explicitly who does or does not have the money.
 */
async function renderPaymentReturnEmail(args: {
  supabase: ServiceSupabaseClient
  payload: Record<string, unknown>
  notificationType: string
  orgId: string
  recipientName: string | null
  orgName: string | null
  orgLogoUrl: string | null
  actionUrl: string
  sentAt: string
}): Promise<string | null> {
  const kind = PAYMENT_RETURN_EMAIL_KIND[args.notificationType]
  if (!kind) return null

  const amountCents = readCents(args.payload, "amount_cents")
  // A disbursement-scoped event names its bill on the payload; a bill-scoped one
  // IS the bill.
  const billId =
    readString(args.payload, "bill_id") ??
    (args.payload.entity_type === "vendor_bill" ? readString(args.payload, "entity_id") : null)
  const invoiceId = readString(args.payload, "invoice_id")

  let counterpartyName: string | null = null
  let documentLabel: string | null = null
  let projectName: string | null = null

  if (billId) {
    const { data: bill } = await args.supabase
      .from("vendor_bills")
      .select("bill_number, company_id, project_id")
      .eq("org_id", args.orgId)
      .eq("id", billId)
      .maybeSingle()
    if (bill) {
      documentLabel = bill.bill_number ? `Invoice ${bill.bill_number}` : null
      const [{ data: company }, { data: project }] = await Promise.all([
        bill.company_id
          ? args.supabase.from("companies").select("name").eq("org_id", args.orgId).eq("id", bill.company_id).maybeSingle()
          : Promise.resolve({ data: null }),
        bill.project_id
          ? args.supabase.from("projects").select("name").eq("org_id", args.orgId).eq("id", bill.project_id).maybeSingle()
          : Promise.resolve({ data: null }),
      ])
      counterpartyName = company?.name ?? null
      projectName = project?.name ?? null
    }
  } else if (invoiceId) {
    const { data: invoice } = await args.supabase
      .from("invoices")
      .select("invoice_number, project_id")
      .eq("org_id", args.orgId)
      .eq("id", invoiceId)
      .maybeSingle()
    if (invoice) {
      documentLabel = invoice.invoice_number ? `Invoice ${invoice.invoice_number}` : null
      if (invoice.project_id) {
        const { data: project } = await args.supabase
          .from("projects")
          .select("name")
          .eq("org_id", args.orgId)
          .eq("id", invoice.project_id)
          .maybeSingle()
        projectName = project?.name ?? null
      }
    }
  }

  // Nothing loaded and no amount means the generic layout says as much as this
  // template would, with less ceremony.
  if (amountCents === null && !documentLabel && !counterpartyName) return null

  return renderEmailTemplate(
    PaymentReturnedEmail({
      orgName: args.orgName,
      orgLogoUrl: args.orgLogoUrl,
      recipientName: args.recipientName,
      kind,
      amountLabel: amountCents !== null ? formatMoneyCents(amountCents) : null,
      counterpartyName,
      documentLabel,
      projectName,
      reason: readString(args.payload, "reason") ?? readString(args.payload, "error"),
      occurredLabel: formatDateLabel(args.sentAt),
      actionUrl: args.actionUrl,
    }),
  )
}

const BANK_CHANGE_EMAIL_KIND: Record<string, BankChangeKind> = {
  funding_source_review_requested: "funding_review",
  vendor_payout_destination_changed: "payout_destination",
}

/**
 * Render the bank-change review email.
 *
 * Deliberately never offers an approve/confirm action from the email itself:
 * a one-click confirmation in a message a phisher can imitate is worse than no
 * message at all. The only link goes to a screen behind a sign-in.
 */
async function renderBankChangeEmail(args: {
  supabase: ServiceSupabaseClient
  payload: Record<string, unknown>
  notificationType: string
  orgId: string
  recipientName: string | null
  orgName: string | null
  orgLogoUrl: string | null
  actionUrl: string
}): Promise<string | null> {
  const kind = BANK_CHANGE_EMAIL_KIND[args.notificationType]
  if (!kind) return null

  if (kind === "funding_review") {
    const fundingSourceId = readString(args.payload, "funding_source_id")
    if (!fundingSourceId) return null
    const { data: funding } = await args.supabase
      .from("org_funding_sources")
      .select("bank_name, last4, created_by")
      .eq("org_id", args.orgId)
      .eq("id", fundingSourceId)
      .maybeSingle()
    if (!funding) return null
    const { data: requester } = funding.created_by
      ? await args.supabase.from("app_users").select("full_name").eq("id", funding.created_by).maybeSingle()
      : { data: null }
    return renderEmailTemplate(
      BankChangeReviewEmail({
        orgName: args.orgName,
        orgLogoUrl: args.orgLogoUrl,
        recipientName: args.recipientName,
        kind,
        bankLabel: bankLabel(funding.bank_name, funding.last4),
        requestedByName: requester?.full_name ?? null,
        effectiveLabel: formatDateLabel(args.payload.apply_after),
        actionUrl: args.actionUrl,
      }),
    )
  }

  const recipientAccountId = readString(args.payload, "entity_id")
  let vendorName: string | null = null
  if (recipientAccountId) {
    const { data: relationship } = await args.supabase
      .from("vendor_payment_relationships")
      .select("company_id")
      .eq("org_id", args.orgId)
      .eq("recipient_account_id", recipientAccountId)
      .limit(1)
      .maybeSingle()
    if (relationship?.company_id) {
      const { data: company } = await args.supabase
        .from("companies")
        .select("name")
        .eq("org_id", args.orgId)
        .eq("id", relationship.company_id)
        .maybeSingle()
      vendorName = company?.name ?? null
    }
  }

  return renderEmailTemplate(
    BankChangeReviewEmail({
      orgName: args.orgName,
      orgLogoUrl: args.orgLogoUrl,
      recipientName: args.recipientName,
      kind,
      vendorName,
      // Masked only. A full account or routing number never reaches an email.
      bankLabel: bankLabel(args.payload.bank_name, args.payload.bank_last4),
      previousBankLabel: bankLabel(null, args.payload.previous_bank_last4),
      effectiveLabel: formatDateLabel(args.payload.locked_until),
      actionUrl: args.actionUrl,
    }),
  )
}

/**
 * Deliver one durable in-app notification by email.
 *
 * Provider rejection throws so callers can leave the outbox job retryable.
 * The notification id is the provider idempotency key: an immediate attempt
 * racing a reaped job cannot produce two messages.
 */
export async function deliverNotificationEmail(
  notificationId: string,
  supabase: ServiceSupabaseClient = createServiceSupabaseClient(),
): Promise<"sent" | "skipped"> {
  const { data: notification, error: notificationError } = await supabase
    .from("notifications")
    .select("id, org_id, user_id, notification_type, payload, created_at")
    .eq("id", notificationId)
    .maybeSingle()

  if (notificationError || !notification) {
    throw new Error(
      `Notification not found (${notificationError?.message ?? "unknown error"})`,
    )
  }

  if (!isEmailEligible(notification.notification_type)) return "skipped"

  const { data: preferences } = await supabase
    .from("user_notification_prefs")
    .select("email_enabled, email_type_settings")
    .eq("org_id", notification.org_id)
    .eq("user_id", notification.user_id)
    .maybeSingle()

  if (preferences?.email_enabled === false) return "skipped"
  if (
    preferences &&
    !emailTypeIsEnabled(
      preferences.email_type_settings,
      notification.notification_type,
    )
  ) {
    return "skipped"
  }

  const [{ data: user, error: userError }, { data: org }] = await Promise.all([
    supabase
      .from("app_users")
      .select("email, full_name")
      .eq("id", notification.user_id)
      .maybeSingle(),
    supabase
      .from("orgs")
      .select("name, logo_url, slug")
      .eq("id", notification.org_id)
      .maybeSingle(),
  ])

  if (userError || !user?.email) throw new Error("User email not found")

  const payload =
    notification.payload &&
    typeof notification.payload === "object" &&
    !Array.isArray(notification.payload)
      ? (notification.payload as Record<string, unknown>)
      : {}
  const title =
    typeof payload.title === "string"
      ? payload.title
      : `Arc: ${notification.notification_type}`
  const message = typeof payload.message === "string" ? payload.message : ""
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com").replace(
    /\/$/,
    "",
  )
  const href = buildNotificationHref(payload)
  const recipientName = user.full_name ?? null
  const orgName = org?.name ?? null
  const orgLogoUrl = org?.logo_url ?? null

  // A handful of notifications carry money decisions, and for those the generic
  // layout can only restate the title. Each renderer reads the record fresh and
  // returns null when there is nothing left to describe, so a deleted run or a
  // drained queue degrades to the generic layout instead of disappearing.
  const richHtml =
    notification.notification_type === "accounting_reconciliation_drift"
      ? await renderReconciliationDriftEmail({
          payload,
          orgId: notification.org_id,
          recipientName,
          orgName,
          orgLogoUrl,
          appUrl,
          queueUrl: `${appUrl}${href ?? "/books/close"}`,
          sentAt: notification.created_at,
        })
      : notification.notification_type in PAYMENT_RUN_EMAIL_KIND
        ? await renderPaymentRunEmail({
            supabase,
            payload,
            notificationType: notification.notification_type,
            orgId: notification.org_id,
            recipientName,
            orgName,
            orgLogoUrl,
            actionUrl: `${appUrl}${href ?? "/payables"}`,
          })
        : notification.notification_type in PAYMENT_RETURN_EMAIL_KIND
          ? await renderPaymentReturnEmail({
              supabase,
              payload,
              notificationType: notification.notification_type,
              orgId: notification.org_id,
              recipientName,
              orgName,
              orgLogoUrl,
              actionUrl: `${appUrl}${href ?? "/payables"}`,
              sentAt: notification.created_at,
            })
          : notification.notification_type in BANK_CHANGE_EMAIL_KIND
            ? await renderBankChangeEmail({
                supabase,
                payload,
                notificationType: notification.notification_type,
                orgId: notification.org_id,
                recipientName,
                orgName,
                orgLogoUrl,
                actionUrl: `${appUrl}${href ?? "/settings?tab=payments"}`,
              })
            : null

  const html =
    richHtml ??
    renderStandardEmailLayout({
      title,
      messageHtml: `Hi ${escapeHtml(user.full_name || "there")},<br/><br/>${escapeHtml(message)}`,
      buttonText: "View in Arc",
      buttonUrl: href ? `${appUrl}${href}` : undefined,
      orgName: org?.name,
      orgLogoUrl: org?.logo_url,
      appUrl,
    })

  const sent = await sendEmail({
    to: [user.email],
    subject: richHtml && org?.name ? `${org.name} · ${title}` : title,
    html,
    from: getOrgSenderEmail(org?.slug, org?.name),
    idempotencyKey: `notification-${notification.id}`,
  })
  if (!sent) throw new Error("Email provider did not accept the notification")
  return "sent"
}
