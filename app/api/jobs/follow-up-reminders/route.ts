import { NextRequest, NextResponse } from "next/server"

import { FollowUpReminderEmail } from "@/lib/emails/follow-up-reminder-email"
import { renderEmailTemplate, sendEmail, getOrgSenderEmail } from "@/lib/services/mailer"
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

  return NextResponse.json({ ok: true, candidates: due?.length ?? 0, sent, skipped })
}

export async function GET(request: NextRequest) {
  return run(request)
}

export async function POST(request: NextRequest) {
  return run(request)
}
