import { NextRequest, NextResponse } from "next/server"

import { EstimateExpiryEmail } from "@/lib/emails/estimate-expiry-email"
import { FollowUpReminderEmail } from "@/lib/emails/follow-up-reminder-email"
import { escapeHtml, renderEmailTemplate, renderStandardEmailLayout, sendEmail, getOrgSenderEmail } from "@/lib/services/mailer"
import { recordEvent } from "@/lib/services/events"
import { ensurePortalLink } from "@/lib/services/portal-links"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export const runtime = "nodejs"

const CRON_SECRET = process.env.CRON_SECRET
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com").replace(/\/$/, "")
// The app serves a single locale (Naples, FL); show the builder's local time in reminders.
const DISPLAY_TIME_ZONE = "America/New_York"
const BATCH_LIMIT = 200

function isAuthorizedCronRequest(request: NextRequest) {
  if (process.env.NODE_ENV !== "production") return true
  const isVercelCron = request.headers.get("x-vercel-cron") === "1"
  const authHeader = request.headers.get("authorization") ?? request.headers.get("Authorization")
  const bearer = typeof authHeader === "string" ? authHeader.trim() : ""
  const legacyHeader = request.headers.get("x-cron-secret")
  const secretOk =
    (!!CRON_SECRET && bearer === `Bearer ${CRON_SECRET}`) || (!!CRON_SECRET && legacyHeader === CRON_SECRET)
  if (CRON_SECRET) return secretOk
  return isVercelCron
}

function jobsiteLabel(location: any): string | null {
  if (!location || typeof location !== "object") return null
  const parts = [location.street, location.city, location.state].filter(Boolean)
  return parts.length ? parts.join(", ") : null
}

async function run(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceSupabaseClient()
  const nowIso = new Date().toISOString()

  const { data: due, error } = await supabase
    .from("prospects")
    .select(
      `id, org_id, name, status, next_follow_up_at, jobsite_location,
       reminder_user:app_users!prospects_next_follow_up_user_id_fkey(id, full_name, email),
       org:orgs(name, slug, logo_url),
       prospect_contacts(full_name, email, phone, is_primary)`,
    )
    .lte("next_follow_up_at", nowIso)
    .is("next_follow_up_notified_at", null)
    .not("next_follow_up_user_id", "is", null)
    .not("status", "in", '("won","lost")')
    .order("next_follow_up_at", { ascending: true })
    .limit(BATCH_LIMIT)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let sent = 0
  let skipped = 0

  for (const row of (due ?? []) as any[]) {
    const user = row.reminder_user as { full_name?: string | null; email?: string | null } | null
    if (!user?.email) {
      skipped += 1
      continue
    }

    const org = row.org as { name?: string | null; slug?: string | null; logo_url?: string | null } | null
    const contacts = (row.prospect_contacts ?? []) as Array<{
      full_name?: string | null
      email?: string | null
      phone?: string | null
      is_primary?: boolean | null
    }>
    const primary = contacts.find((c) => c.is_primary) ?? contacts[0]

    const dueLabel = new Date(row.next_follow_up_at).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: DISPLAY_TIME_ZONE,
    })

    const html = await renderEmailTemplate(
      FollowUpReminderEmail({
        recipientName: user.full_name ?? null,
        prospectName: row.name,
        dueLabel,
        contactName: primary?.full_name ?? null,
        contactEmail: primary?.email ?? null,
        contactPhone: primary?.phone ?? null,
        jobsite: jobsiteLabel(row.jobsite_location),
        prospectLink: `${APP_URL}/pipeline`,
        orgName: org?.name ?? null,
        orgLogoUrl: org?.logo_url ?? null,
      }),
    )

    const ok = await sendEmail({
      to: [user.email],
      subject: `Follow-up due: ${row.name}`,
      html,
      from: getOrgSenderEmail(org?.slug, org?.name),
    })

    if (!ok) {
      skipped += 1
      continue
    }

    // Mark as notified only after a successful send so failures retry next sweep.
    await supabase.from("prospects").update({ next_follow_up_notified_at: nowIso }).eq("id", row.id)
    sent += 1
  }

  const [expiry, trialAlerts, overdueOps] = await Promise.all([
    sweepExpiringEstimates(supabase, nowIso),
    sweepTrialEndingAlerts(supabase, nowIso),
    sweepOverdueOperationalItems(supabase, nowIso),
  ])

  return NextResponse.json({ ok: true, candidates: due?.length ?? 0, sent, skipped, expiry, trialAlerts, overdueOps })
}

/**
 * One-shot overdue nudges for operational items (ball-in-court chasing):
 * - Open RFIs past due → email the internal assignee/submitter.
 * - Undecided, current-revision submittals past review due → email the
 *   assigned company's contacts.
 * - Client decisions still pending past due → reminder email to the client.
 * Each row is marked via overdue_notified_at after a successful send so the
 * sweep never repeats; changing the due date does not re-arm on purpose.
 */
async function sweepOverdueOperationalItems(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  nowIso: string,
) {
  const today = nowIso.slice(0, 10)
  const results = { rfis: 0, submittals: 0, decisions: 0, skipped: 0 }

  type OrgInfo = { name?: string | null; slug?: string | null; logo_url?: string | null }
  const orgCache = new Map<string, OrgInfo>()
  const loadOrg = async (orgId: string): Promise<OrgInfo> => {
    const cached = orgCache.get(orgId)
    if (cached) return cached
    const { data } = await supabase.from("orgs").select("name, slug, logo_url").eq("id", orgId).maybeSingle()
    const org: OrgInfo = data ?? {}
    orgCache.set(orgId, org)
    return org
  }

  // --- RFIs ---
  const { data: overdueRfis } = await supabase
    .from("rfis")
    .select("id, org_id, project_id, rfi_number, subject, due_date, assigned_to, submitted_by, project:projects(name)")
    .in("status", ["open"])
    .not("due_date", "is", null)
    .lt("due_date", today)
    .is("overdue_notified_at", null)
    .limit(BATCH_LIMIT)

  for (const rfi of (overdueRfis ?? []) as any[]) {
    const userId = rfi.assigned_to ?? rfi.submitted_by
    if (!userId) {
      results.skipped += 1
      continue
    }
    const { data: user } = await supabase.from("app_users").select("email, full_name").eq("id", userId).maybeSingle()
    if (!user?.email) {
      results.skipped += 1
      continue
    }
    const org = await loadOrg(rfi.org_id)
    const project = Array.isArray(rfi.project) ? rfi.project[0] : rfi.project
    const html = renderStandardEmailLayout({
      title: `RFI #${rfi.rfi_number} is overdue`,
      messageHtml: `<p>RFI #${rfi.rfi_number} — <strong>${escapeHtml(rfi.subject)}</strong>${
        project?.name ? ` on ${escapeHtml(project.name)}` : ""
      } was due ${escapeHtml(rfi.due_date)} and has no answer yet.</p>`,
      buttonText: "Open RFI",
      buttonUrl: `${APP_URL}/projects/${rfi.project_id}/rfis`,
      orgName: org?.name ?? null,
      orgLogoUrl: org?.logo_url ?? null,
      showManageSettings: false,
    })
    const ok = await sendEmail({
      to: [user.email],
      subject: `Overdue RFI #${rfi.rfi_number}: ${rfi.subject}`,
      html,
      from: getOrgSenderEmail(org?.slug, org?.name),
    })
    if (!ok) {
      results.skipped += 1
      continue
    }
    await supabase.from("rfis").update({ overdue_notified_at: nowIso }).eq("id", rfi.id)
    results.rfis += 1
  }

  // --- Submittals ---
  const { data: overdueSubmittals } = await supabase
    .from("submittals")
    .select("id, org_id, project_id, submittal_number, revision, title, due_date, assigned_company_id, project:projects(name)")
    .is("decision_status", null)
    .is("superseded_by_id", null)
    .not("due_date", "is", null)
    .lt("due_date", today)
    .is("overdue_notified_at", null)
    .limit(BATCH_LIMIT)

  for (const submittal of (overdueSubmittals ?? []) as any[]) {
    if (!submittal.assigned_company_id) {
      results.skipped += 1
      continue
    }
    const { data: contacts } = await supabase
      .from("contacts")
      .select("email")
      .eq("org_id", submittal.org_id)
      .eq("primary_company_id", submittal.assigned_company_id)
      .not("email", "is", null)
      .limit(5)
    const recipients = (contacts ?? []).map((c: any) => c.email as string)
    if (recipients.length === 0) {
      results.skipped += 1
      continue
    }
    const org = await loadOrg(submittal.org_id)
    const project = Array.isArray(submittal.project) ? submittal.project[0] : submittal.project
    const numberLabel =
      submittal.revision > 0 ? `#${submittal.submittal_number} Rev ${submittal.revision}` : `#${submittal.submittal_number}`
    const html = renderStandardEmailLayout({
      title: `Submittal ${numberLabel} is overdue`,
      messageHtml: `<p>Submittal ${numberLabel} — <strong>${escapeHtml(submittal.title)}</strong>${
        project?.name ? ` on ${escapeHtml(project.name)}` : ""
      } was due ${escapeHtml(submittal.due_date)}. Please submit the outstanding documents.</p>`,
      orgName: org?.name ?? null,
      orgLogoUrl: org?.logo_url ?? null,
      showManageSettings: false,
    })
    const ok = await sendEmail({
      to: recipients,
      subject: `Overdue submittal ${numberLabel}: ${submittal.title}`,
      html,
      from: getOrgSenderEmail(org?.slug, org?.name),
    })
    if (!ok) {
      results.skipped += 1
      continue
    }
    await supabase.from("submittals").update({ overdue_notified_at: nowIso }).eq("id", submittal.id)
    results.submittals += 1
  }

  // --- Decisions ---
  const { data: overdueDecisions } = await supabase
    .from("decisions")
    .select("id, org_id, project_id, title, due_date, notify_contact_id, project:projects(name, client_id)")
    .eq("status", "pending")
    .not("due_date", "is", null)
    .lt("due_date", today)
    .is("overdue_notified_at", null)
    .limit(BATCH_LIMIT)

  for (const decision of (overdueDecisions ?? []) as any[]) {
    const project = Array.isArray(decision.project) ? decision.project[0] : decision.project
    const contactId = decision.notify_contact_id ?? project?.client_id
    if (!contactId) {
      results.skipped += 1
      continue
    }
    const { data: contact } = await supabase
      .from("contacts")
      .select("email, full_name")
      .eq("id", contactId)
      .maybeSingle()
    if (!contact?.email) {
      results.skipped += 1
      continue
    }
    const org = await loadOrg(decision.org_id)
    const portalLink = await ensurePortalLink({
      supabase,
      orgId: decision.org_id,
      projectId: decision.project_id,
      portalType: "client",
      contactId,
      companyId: null,
      createdBy: null,
      capabilities: { can_submit_selections: true },
      fallbackPath: `/projects/${decision.project_id}/decisions`,
    })
    const html = renderStandardEmailLayout({
      title: `Reminder: decision needed — ${decision.title}`,
      messageHtml: `<p>${contact.full_name ? `Hi ${escapeHtml(contact.full_name)},` : "Hi,"}</p><p>Your builder is still waiting on your decision for <strong>${escapeHtml(
        decision.title,
      )}</strong>${project?.name ? ` on ${escapeHtml(project.name)}` : ""}. It was needed by ${escapeHtml(decision.due_date)} and the schedule may depend on it.</p>`,
      buttonText: "Review & Decide",
      buttonUrl: portalLink.includes("/p/") ? `${portalLink}/decisions` : portalLink,
      orgName: org?.name ?? null,
      orgLogoUrl: org?.logo_url ?? null,
      showManageSettings: false,
    })
    const ok = await sendEmail({
      to: [contact.email],
      subject: `Reminder — decision needed: ${decision.title}`,
      html,
      from: getOrgSenderEmail(org?.slug, org?.name),
    })
    if (!ok) {
      results.skipped += 1
      continue
    }
    await supabase.from("decisions").update({ overdue_notified_at: nowIso }).eq("id", decision.id)
    results.decisions += 1
  }

  return results
}

const EXPIRY_WINDOW_DAYS = 3

/**
 * Nudges the builder once per estimate when a sent (or changes-requested)
 * estimate is within 3 days of its valid-until date, or has passed it without
 * a signature. The one-shot marker lives in estimate metadata so a re-send or
 * revision (fresh row) re-arms the reminder naturally.
 */
async function sweepExpiringEstimates(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  nowIso: string,
) {
  const windowEnd = new Date(Date.now() + EXPIRY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const { data: estimates, error } = await supabase
    .from("estimates")
    .select(
      `id, org_id, title, status, total_cents, valid_until, created_by, metadata,
       prospect:prospects(name),
       recipient:contacts(full_name),
       org:orgs(name, slug, logo_url)`,
    )
    .in("status", ["sent", "changes_requested"])
    .eq("is_current_version", true)
    .not("valid_until", "is", null)
    .not("created_by", "is", null)
    .lte("valid_until", windowEnd)
    .is("metadata->expiry_notified_at", null)
    .order("valid_until", { ascending: true })
    .limit(BATCH_LIMIT)

  if (error) {
    return { error: error.message, sent: 0, skipped: 0 }
  }

  const rows = (estimates ?? []) as any[]
  if (rows.length === 0) return { candidates: 0, sent: 0, skipped: 0 }

  const creatorIds = Array.from(new Set(rows.map((row) => row.created_by as string)))
  const { data: creators } = await supabase
    .from("app_users")
    .select("id, full_name, email")
    .in("id", creatorIds)
  const creatorById = new Map((creators ?? []).map((user: any) => [user.id as string, user]))

  let sent = 0
  let skipped = 0

  for (const row of rows) {
    const creator = creatorById.get(row.created_by) as { full_name?: string | null; email?: string | null } | undefined
    if (!creator?.email) {
      skipped += 1
      continue
    }

    const org = row.org as { name?: string | null; slug?: string | null; logo_url?: string | null } | null
    const expired = row.valid_until < nowIso
    const expiresLabel = new Date(row.valid_until).toLocaleDateString("en-US", {
      dateStyle: "medium",
      timeZone: DISPLAY_TIME_ZONE,
    })

    const html = await renderEmailTemplate(
      EstimateExpiryEmail({
        recipientName: creator.full_name ?? null,
        estimateTitle: row.title,
        prospectName: row.prospect?.name ?? null,
        recipientContactName: row.recipient?.full_name ?? null,
        expiresLabel,
        expired,
        totalLabel:
          row.total_cents != null
            ? (row.total_cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
            : null,
        pipelineLink: `${APP_URL}/pipeline`,
        orgName: org?.name ?? null,
        orgLogoUrl: org?.logo_url ?? null,
      }),
    )

    const ok = await sendEmail({
      to: [creator.email],
      subject: expired ? `Estimate expired unsigned: ${row.title}` : `Estimate expiring soon: ${row.title}`,
      html,
      from: getOrgSenderEmail(org?.slug, org?.name),
    })

    if (!ok) {
      skipped += 1
      continue
    }

    await supabase
      .from("estimates")
      .update({ metadata: { ...(row.metadata ?? {}), expiry_notified_at: nowIso } })
      .eq("id", row.id)
      .eq("org_id", row.org_id)
    sent += 1
  }

  return { candidates: rows.length, sent, skipped }
}

const TRIAL_ALERT_WINDOW_DAYS = 5
const PLATFORM_ALERTS_EMAIL = process.env.PLATFORM_ALERTS_EMAIL || "support@arcnaples.com"

async function sweepTrialEndingAlerts(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  nowIso: string,
) {
  const windowEnd = new Date(Date.now() + TRIAL_ALERT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from("subscriptions")
    .select("id, org_id, trial_ends_at, org:orgs(name, slug, logo_url)")
    .eq("status", "trialing")
    .is("plan_code", null)
    .gte("trial_ends_at", nowIso)
    .lte("trial_ends_at", windowEnd)
    .order("trial_ends_at", { ascending: true })
    .limit(BATCH_LIMIT)

  if (error) {
    return { error: error.message, sent: 0, skipped: 0 }
  }

  let sent = 0
  let skipped = 0

  for (const row of (data ?? []) as any[]) {
    if (!row.org_id || !row.trial_ends_at) {
      skipped += 1
      continue
    }

    const { data: existing } = await supabase
      .from("events")
      .select("id")
      .eq("org_id", row.org_id)
      .eq("event_type", "trial_ending_alert_sent")
      .eq("payload->>trial_ends_at", row.trial_ends_at)
      .limit(1)
      .maybeSingle()

    if (existing?.id) {
      skipped += 1
      continue
    }

    const org = row.org as { name?: string | null; slug?: string | null; logo_url?: string | null } | null
    const endsLabel = new Date(row.trial_ends_at).toLocaleDateString("en-US", {
      dateStyle: "medium",
      timeZone: DISPLAY_TIME_ZONE,
    })
    const orgName = org?.name ?? "Client org"
    const html = renderStandardEmailLayout({
      title: `${orgName} trial ends ${endsLabel}`,
      messageHtml: `<p>${orgName} trial ends ${endsLabel} and no price has been set.</p><p>Activate billing from the customers desk.</p>`,
      buttonText: "Open customers",
      buttonUrl: `${APP_URL}/admin/customers`,
      orgName: "Arc",
      showManageSettings: false,
    })

    const ok = await sendEmail({
      to: [PLATFORM_ALERTS_EMAIL],
      subject: `${orgName} trial ends ${endsLabel} - no price set`,
      html,
      from: getOrgSenderEmail(org?.slug, org?.name),
    })

    if (!ok) {
      skipped += 1
      continue
    }

    await recordEvent({
      orgId: row.org_id,
      eventType: "trial_ending_alert_sent",
      entityType: "subscription",
      entityId: row.id,
      payload: {
        trial_ends_at: row.trial_ends_at,
        org_name: orgName,
        recipient: PLATFORM_ALERTS_EMAIL,
      },
      channel: "notification",
    })
    sent += 1
  }

  return { candidates: data?.length ?? 0, sent, skipped }
}

export async function GET(request: NextRequest) {
  return run(request)
}

export async function POST(request: NextRequest) {
  return run(request)
}
