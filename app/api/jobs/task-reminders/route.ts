import { NextRequest, NextResponse } from "next/server"

import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { getOrgSenderEmail, renderStandardEmailLayout, sendEmail } from "@/lib/services/mailer"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export const runtime = "nodejs"

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com").replace(/\/$/, "")
const BATCH_LIMIT = 200

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

// Frequent sweep: email each task creator their due self-reminders, then stamp
// reminder_sent_at so a reminder fires exactly once. Runs every 15 min so it can
// land near the chosen time. Vercel Cron issues GET, so GET === POST below.
async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceSupabaseClient()
  const nowIso = new Date().toISOString()

  const { data: tasks, error } = await supabase
    .from("tasks")
    .select("id, org_id, title, description, created_by, reminder_at, project:projects(name)")
    .lte("reminder_at", nowIso)
    .is("reminder_sent_at", null)
    .neq("status", "done")
    .order("reminder_at", { ascending: true })
    .limit(BATCH_LIMIT)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!tasks || tasks.length === 0) {
    return NextResponse.json({ processed: 0, sent: 0 })
  }

  const userIds = Array.from(new Set(tasks.map((task) => task.created_by).filter(Boolean))) as string[]
  const orgIds = Array.from(new Set(tasks.map((task) => task.org_id).filter(Boolean))) as string[]

  const [usersResult, orgsResult] = await Promise.all([
    userIds.length
      ? supabase.from("app_users").select("id, email, full_name").in("id", userIds)
      : Promise.resolve({ data: [] as { id: string; email: string | null; full_name: string | null }[] }),
    orgIds.length
      ? supabase.from("orgs").select("id, name, slug, logo_url").in("id", orgIds)
      : Promise.resolve({ data: [] as { id: string; name: string | null; slug: string | null; logo_url: string | null }[] }),
  ])

  const userById = new Map((usersResult.data ?? []).map((user) => [user.id, user]))
  const orgById = new Map((orgsResult.data ?? []).map((org) => [org.id, org]))

  const stampSent = (taskId: string) =>
    supabase
      .from("tasks")
      .update({ reminder_sent_at: new Date().toISOString() })
      .eq("id", taskId)
      .is("reminder_sent_at", null)

  let sent = 0

  for (const task of tasks) {
    const creator = task.created_by ? userById.get(task.created_by) : null

    // No inbox to reach — stamp it so the sweep doesn't keep reconsidering it.
    if (!creator?.email) {
      await stampSent(task.id)
      continue
    }

    const org = task.org_id ? orgById.get(task.org_id) : null
    const project = one(task.project) as { name?: string } | null

    const messageHtml = `
      <p style="margin:0 0 14px 0;">Here's your reminder${project?.name ? ` for <strong>${escapeHtml(project.name)}</strong>` : ""}:</p>
      <p style="margin:0 0 ${task.description ? "12px" : "0"} 0; font-size:16px; font-weight:700; color:#111111;">${escapeHtml(task.title)}</p>
      ${task.description ? `<p style="margin:0; color:#555555;">${escapeHtml(task.description)}</p>` : ""}
    `

    const html = renderStandardEmailLayout({
      title: "Task reminder",
      messageHtml,
      buttonText: "Open tasks",
      buttonUrl: `${APP_URL}/tasks`,
      orgName: org?.name ?? null,
      orgLogoUrl: org?.logo_url ?? null,
    })

    const ok = await sendEmail({
      to: [creator.email],
      subject: `Reminder: ${task.title}`,
      html,
      from: getOrgSenderEmail(org?.slug ?? null, org?.name ?? null),
    })

    // Leave reminder_sent_at NULL on failure so the next sweep retries it.
    if (ok) {
      await stampSent(task.id)
      sent += 1
    }
  }

  return NextResponse.json({ processed: tasks.length, sent })
}

export const POST = withCronRun("task-reminders", handler)
export const GET = POST
