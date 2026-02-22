import { NextRequest, NextResponse } from "next/server"

import { WeeklyExecutiveSnapshotEmail } from "@/lib/emails/weekly-executive-snapshot-email"
import { renderEmailTemplate, sendEmail } from "@/lib/services/mailer"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  buildWeeklyExecutiveSnapshotForOrg,
  getEligibleWeeklySnapshotPairs,
  getWeeklySnapshotWeekStart,
} from "@/lib/services/weekly-executive-snapshot"

export const runtime = "nodejs"

const CRON_SECRET = process.env.CRON_SECRET

type PreferenceRow = {
  org_id: string | null
  user_id: string | null
  weekly_snapshot_last_sent_for_week: string | null
}

type MembershipRow = {
  org_id: string | null
  user_id: string | null
}

type UserRow = {
  id: string
  email: string | null
  full_name: string | null
}

type OrgRow = {
  id: string
  name: string | null
  logo_url: string | null
}

function isAuthorizedCronRequest(request: NextRequest) {
  const isDev = process.env.NODE_ENV !== "production"
  if (isDev) return true

  const isVercelCron = request.headers.get("x-vercel-cron") === "1"
  const authHeader = request.headers.get("authorization") ?? request.headers.get("Authorization")
  const bearer = typeof authHeader === "string" ? authHeader.trim() : ""
  const legacyHeader = request.headers.get("x-cron-secret")

  const secretOk =
    (!!CRON_SECRET && bearer === `Bearer ${CRON_SECRET}`) ||
    (!!CRON_SECRET && legacyHeader === CRON_SECRET)

  if (CRON_SECRET) {
    return secretOk
  }

  return isVercelCron
}

async function executeSnapshotJob(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const force = request.nextUrl.searchParams.get("force") === "1"
  const now = new Date()
  const isFridayUtc = now.getUTCDay() === 5
  if (!force && !isFridayUtc) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "not_friday_utc",
      today_utc_day: now.getUTCDay(),
    })
  }

  const weekStart = getWeeklySnapshotWeekStart(now)
  const nowIso = now.toISOString()
  const appBaseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://arcnaples.com").replace(/\/$/, "")

  const supabase = createServiceSupabaseClient()

  const { data: prefRows, error: prefError } = await supabase
    .from("user_notification_prefs")
    .select("org_id, user_id, email_enabled, weekly_snapshot_enabled, weekly_snapshot_last_sent_for_week")
    .eq("email_enabled", true)
    .eq("weekly_snapshot_enabled", true)

  if (prefError) {
    return NextResponse.json({ error: `Failed to load snapshot preferences: ${prefError.message}` }, { status: 500 })
  }

  const pendingPrefs = ((prefRows ?? []) as PreferenceRow[]).filter(
    (row) => row.weekly_snapshot_last_sent_for_week !== weekStart,
  )
  if (pendingPrefs.length === 0) {
    return NextResponse.json({ ok: true, week_start: weekStart, recipients: 0, sent: 0, failed: 0 })
  }

  const orgIds = Array.from(new Set(pendingPrefs.map((row) => row.org_id).filter(Boolean) as string[]))
  const userIds = Array.from(new Set(pendingPrefs.map((row) => row.user_id).filter(Boolean) as string[]))
  if (orgIds.length === 0 || userIds.length === 0) {
    return NextResponse.json({ ok: true, week_start: weekStart, recipients: 0, sent: 0, failed: 0 })
  }

  const [membershipsRes, usersRes, orgsRes] = await Promise.all([
    supabase
      .from("memberships")
      .select("org_id, user_id")
      .eq("status", "active")
      .in("org_id", orgIds)
      .in("user_id", userIds),
    supabase
      .from("app_users")
      .select("id, email, full_name")
      .in("id", userIds),
    supabase
      .from("orgs")
      .select("id, name, logo_url")
      .in("id", orgIds),
  ])

  if (membershipsRes.error || usersRes.error || orgsRes.error) {
    const message =
      membershipsRes.error?.message ||
      usersRes.error?.message ||
      orgsRes.error?.message ||
      "Failed to resolve recipients"
    return NextResponse.json({ error: message }, { status: 500 })
  }

  const eligiblePairs = getEligibleWeeklySnapshotPairs({
    activeMemberships: (membershipsRes.data ?? []) as MembershipRow[],
    enabledPrefs: pendingPrefs,
  })

  if (eligiblePairs.length === 0) {
    return NextResponse.json({ ok: true, week_start: weekStart, recipients: 0, sent: 0, failed: 0 })
  }

  const userById = new Map(
    ((usersRes.data ?? []) as UserRow[]).map((row) => [row.id, row]),
  )
  const orgById = new Map(
    ((orgsRes.data ?? []) as OrgRow[]).map((row) => [row.id, row]),
  )

  const groupedByOrg = new Map<string, Array<{ org_id: string; user_id: string }>>()
  for (const pair of eligiblePairs) {
    const existing = groupedByOrg.get(pair.org_id) ?? []
    existing.push(pair)
    groupedByOrg.set(pair.org_id, existing)
  }

  let sent = 0
  let failed = 0
  const failures: Array<{ org_id: string; user_id: string; error: string }> = []

  for (const [orgId, recipients] of groupedByOrg.entries()) {
    let snapshot: Awaited<ReturnType<typeof buildWeeklyExecutiveSnapshotForOrg>>
    try {
      snapshot = await buildWeeklyExecutiveSnapshotForOrg({ supabase, orgId, asOf: now })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown snapshot build error"
      for (const recipient of recipients) {
        failed += 1
        failures.push({ org_id: orgId, user_id: recipient.user_id, error: message })
      }
      continue
    }

    const orgMeta = orgById.get(orgId)
    const orgName = orgMeta?.name ?? "Arc"
    const orgLogoUrl = orgMeta?.logo_url ?? null

    for (const recipient of recipients) {
      const user = userById.get(recipient.user_id)
      const email = user?.email ?? null
      if (!email) {
        failed += 1
        failures.push({ org_id: orgId, user_id: recipient.user_id, error: "User email not found" })
        continue
      }

      try {
        const html = await renderEmailTemplate(
          WeeklyExecutiveSnapshotEmail({
            weekLabel: snapshot.weekLabel,
            generatedAtLabel: snapshot.generatedAtLabel,
            orgName,
            orgLogoUrl,
            recipientName: user?.full_name ?? null,
            controlTowerLink: appBaseUrl,
            metrics: snapshot.metrics,
            watchlist: snapshot.watchlist,
            decisions: snapshot.decisions,
            drift: snapshot.drift,
            executiveNotes: snapshot.executiveNotes,
          }),
        )

        const ok = await sendEmail({
          to: [email],
          subject: `${orgName} Weekly Executive Snapshot · ${snapshot.weekLabel}`,
          html,
        })

        if (!ok) {
          failed += 1
          failures.push({ org_id: orgId, user_id: recipient.user_id, error: "Email provider rejected request" })
          continue
        }

        const { error: updateError } = await supabase
          .from("user_notification_prefs")
          .update({
            weekly_snapshot_last_sent_for_week: weekStart,
            updated_at: nowIso,
          })
          .eq("org_id", orgId)
          .eq("user_id", recipient.user_id)

        if (updateError) {
          failed += 1
          failures.push({ org_id: orgId, user_id: recipient.user_id, error: updateError.message })
          continue
        }

        sent += 1
      } catch (error) {
        failed += 1
        failures.push({
          org_id: orgId,
          user_id: recipient.user_id,
          error: error instanceof Error ? error.message : "Unknown delivery error",
        })
      }
    }
  }

  return NextResponse.json({
    ok: true,
    week_start: weekStart,
    recipients: eligiblePairs.length,
    sent,
    failed,
    failures: process.env.NODE_ENV === "production" ? undefined : failures,
  })
}

export async function GET(request: NextRequest) {
  return executeSnapshotJob(request)
}

export async function POST(request: NextRequest) {
  return executeSnapshotJob(request)
}
