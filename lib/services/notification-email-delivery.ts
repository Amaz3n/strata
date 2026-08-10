import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { AccountingReconciliationEmail } from "@/lib/emails/accounting-reconciliation-email"
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

type ServiceSupabaseClient = ReturnType<typeof createServiceSupabaseClient>

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

  if (entityType === "estimate") {
    return typeof payload.prospect_id === "string" ? "/pipeline" : "/estimates"
  }

  if (entityType === "payment_run") {
    return typeof payload.bill_id === "string"
      ? `/payables?bill=${payload.bill_id}`
      : "/payables"
  }

  if (!projectId) return null

  switch (entityType) {
    case "rfi":
      return `/projects/${projectId}/rfis`
    case "submittal":
      return `/projects/${projectId}/submittals`
    case "invoice":
      return `/projects/${projectId}/invoices`
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

  // Reconciliation drift is the one notification whose entire value is the
  // detail. A count alone cannot tell a bookkeeper whether tonight's findings are
  // a sync that is behind or money that left the bank with no ledger entry, and
  // the generic layout can only restate the count. It renders from the run's own
  // items; a run that has gone missing falls through to the generic layout below
  // so the alert degrades rather than disappears.
  const richHtml =
    notification.notification_type === "accounting_reconciliation_drift"
      ? await renderReconciliationDriftEmail({
          payload,
          orgId: notification.org_id,
          recipientName: user.full_name ?? null,
          orgName: org?.name ?? null,
          orgLogoUrl: org?.logo_url ?? null,
          appUrl,
          queueUrl: `${appUrl}${href ?? "/books/close"}`,
          sentAt: notification.created_at,
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
