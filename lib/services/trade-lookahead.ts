import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

import { escapeHtml, getOrgSenderEmail, renderStandardEmailLayout, sendEmail } from "@/lib/services/mailer"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { lookaheadSchema } from "@/lib/validation/starts"

export interface TradeLookaheadRow {
  companyId: string | null
  companyName: string
  trade: string | null
  items: Array<{
    scheduleItemId: string
    projectId: string
    lotLabel: string
    communityName: string
    name: string
    startDate: string
    endDate: string
    status: string
    confirmation: "unsent" | "sent" | "confirmed" | "declined"
  }>
}

function one(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value
  return row && typeof row === "object" ? row as Record<string, unknown> : null
}

async function companyRecipients(supabase: SupabaseClient, orgId: string, companyId: string) {
  const { data, error } = await supabase.from("contacts").select("email").eq("org_id", orgId).eq("company_id", companyId).not("email", "is", null).limit(50)
  if (error) throw new Error(`Failed to load trade contacts: ${error.message}`)
  return Array.from(new Set((data ?? []).flatMap((contact) => contact.email ? [contact.email] : [])))
}

export async function getTradeLookahead(
  input: { weeks: 2 | 3 | 4; communityId?: string; companyId?: string; page?: number; pageSize?: number },
  orgId?: string,
): Promise<{ rows: TradeLookaheadRow[]; total: number }> {
  const parsed = lookaheadSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("start.read", context)
  const start = new Date().toISOString().slice(0, 10)
  const endDate = new Date()
  endDate.setUTCDate(endDate.getUTCDate() + parsed.weeks * 7)
  const end = endDate.toISOString().slice(0, 10)
  let itemsQuery = context.supabase.from("schedule_items").select(`
    id,project_id,name,trade,status,start_date,end_date,cost_code_id,
    project:projects!inner(property_type,status),
    assignments:schedule_assignments(company_id,confirmed_at,company:companies(name)),
    lot:lots!lots_project_id_fkey(lot_number,block,community_id,community:communities(name))
  `).eq("org_id", context.orgId).eq("project.property_type", "production").eq("project.status", "active")
    .gte("start_date", start).lte("start_date", end).order("start_date").limit(5000)
  if (parsed.communityId) itemsQuery = itemsQuery.eq("lot.community_id", parsed.communityId)
  const { data: items, error } = await itemsQuery
  if (error) throw new Error(`Failed to load trade look-ahead: ${error.message}`)
  const unresolved = (items ?? []).filter((item) => !(item.assignments ?? []).some((assignment: { company_id?: string | null }) => assignment.company_id) && item.cost_code_id)
  const projectIds = Array.from(new Set(unresolved.map((item) => item.project_id)))
  const costCodeIds = Array.from(new Set(unresolved.flatMap((item) => item.cost_code_id ? [item.cost_code_id] : [])))
  const vendorByProjectCost = new Map<string, { id: string; name: string }>()
  if (projectIds.length && costCodeIds.length) {
    const { data: commitments } = await context.supabase.from("commitment_lines").select("project_id,cost_code_id,commitment:commitments!inner(company_id,company:companies(name),commitment_type)")
      .eq("org_id", context.orgId).in("project_id", projectIds).in("cost_code_id", costCodeIds).eq("commitment.commitment_type", "purchase_order").limit(5000)
    for (const line of commitments ?? []) {
      const commitment = one(line.commitment)
      const company = one(commitment?.company)
      if (commitment?.company_id) vendorByProjectCost.set(`${line.project_id}:${line.cost_code_id}`, { id: String(commitment.company_id), name: String(company?.name ?? "Trade company") })
    }
  }
  const groups = new Map<string, TradeLookaheadRow>()
  for (const item of items ?? []) {
    const assignment = (item.assignments ?? []).find((row: { company_id?: string | null }) => row.company_id)
    const assignedCompany = assignment ? one(assignment.company) : null
    const fallback = item.cost_code_id ? vendorByProjectCost.get(`${item.project_id}:${item.cost_code_id}`) : undefined
    const companyId = assignment?.company_id ?? fallback?.id ?? null
    if (parsed.companyId && companyId !== parsed.companyId) continue
    const companyName = assignedCompany?.name ? String(assignedCompany.name) : fallback?.name ?? "Unassigned"
    const key = `${companyId ?? "unassigned"}:${item.trade ?? ""}`
    const lot = one(item.lot)
    const community = one(lot?.community)
    const row: TradeLookaheadRow = groups.get(key) ?? { companyId, companyName, trade: item.trade, items: [] }
    row.items.push({
      scheduleItemId: item.id, projectId: item.project_id,
      lotLabel: lot?.block ? `${lot.block}-${lot.lot_number}` : String(lot?.lot_number ?? "Lot"),
      communityName: String(community?.name ?? "Community"), name: item.name, startDate: item.start_date,
      endDate: item.end_date ?? item.start_date, status: item.status,
      confirmation: assignment?.confirmed_at ? "confirmed" : "unsent",
    })
    groups.set(key, row)
  }
  const all = Array.from(groups.values()).sort((a, b) => a.companyName.localeCompare(b.companyName))
  const offset = (parsed.page - 1) * parsed.pageSize
  return { rows: all.slice(offset, offset + parsed.pageSize), total: all.length }
}

export async function sendTradeLookahead(
  companyId: string,
  opts: { weeks: 2 | 3 | 4; communityId?: string },
  orgId?: string,
) {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.write", context)
  const today = new Date().toISOString().slice(0, 10)
  const { count: alreadySent } = await context.supabase.from("events").select("id", { count: "exact", head: true })
    .eq("org_id", context.orgId).eq("event_type", "trade_lookahead.sent").eq("payload->>company_id", companyId).gte("created_at", `${today}T00:00:00.000Z`)
  if ((alreadySent ?? 0) > 0) return { sent: false }
  const result = await getTradeLookahead({ ...opts, companyId, pageSize: 100 }, context.orgId)
  const row = result.rows.find((candidate) => candidate.companyId === companyId)
  if (!row?.items.length) throw new Error("No scheduled work is available for this trade.")
  const recipients = await companyRecipients(context.supabase, context.orgId, companyId)
  if (!recipients.length) throw new Error("This trade company has no email contacts.")
  const [{ data: org }, { data: token }] = await Promise.all([
    context.supabase.from("orgs").select("name,slug,logo_url").eq("id", context.orgId).maybeSingle(),
    context.supabase.from("portal_access_tokens").select("token").eq("org_id", context.orgId).eq("company_id", companyId).eq("portal_type", "sub").is("revoked_at", null).limit(1).maybeSingle(),
  ])
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://arcnaples.com").replace(/\/$/, "")
  const lines = row.items.map((item) => `<tr><td style="padding:6px;border-bottom:1px solid #ddd">${escapeHtml(item.lotLabel)} · ${escapeHtml(item.communityName)}</td><td style="padding:6px;border-bottom:1px solid #ddd">${escapeHtml(item.name)}</td><td style="padding:6px;border-bottom:1px solid #ddd">${escapeHtml(item.startDate)} – ${escapeHtml(item.endDate)}</td></tr>`).join("")
  const html = renderStandardEmailLayout({
    title: `${opts.weeks}-week trade look-ahead`,
    messageHtml: `<p>Upcoming scheduled work for ${escapeHtml(row.companyName)}.</p><table style="width:100%;border-collapse:collapse">${lines}</table>`,
    buttonText: token ? "Open trade portal" : undefined, buttonUrl: token ? `${appUrl}/s/${token.token}` : undefined,
    orgName: org?.name, orgLogoUrl: org?.logo_url, showManageSettings: false,
  })
  await sendEmail({ to: recipients, subject: `${opts.weeks}-week trade look-ahead`, html, from: getOrgSenderEmail(org?.slug, org?.name) })
  const event = await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "trade_lookahead.sent", entityType: "company", entityId: companyId, payload: { company_id: companyId, recipients: recipients.length, item_count: row.items.length } })
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "trade_notice", entityId: event.id, source: "trade_notice", after: { company_id: companyId, item_count: row.items.length } })
  return { sent: true }
}

export async function enqueueTradeScheduleChange(input: {
  orgId: string
  actorId: string
  companyId: string
  projectId: string
  scheduleItemId: string
  oldStart: string | null
  newStart: string | null
}) {
  const supabase = createServiceSupabaseClient()
  // Outbox dedupe keys are permanently unique, so include the coalescing
  // window while retaining company/project identity inside that window.
  const bucket = Math.floor(Date.now() / (15 * 60_000))
  const dedupeKey = `trade_schedule_change_notice:company_id:${input.companyId}|project_id:${input.projectId}|bucket:${bucket}`
  const { data: existing } = await supabase.from("outbox").select("id,payload").eq("org_id", input.orgId).eq("dedupe_key", dedupeKey).eq("status", "pending").maybeSingle()
  const change = { schedule_item_id: input.scheduleItemId, old_start: input.oldStart, new_start: input.newStart }
  if (existing) {
    const payload = existing.payload && typeof existing.payload === "object" ? existing.payload as Record<string, unknown> : {}
    const changes = Array.isArray(payload.changes) ? payload.changes.filter((item) => one(item)?.schedule_item_id !== input.scheduleItemId) : []
    await supabase.from("outbox").update({ payload: { ...payload, actor_id: input.actorId, changes: [...changes, change] }, run_at: new Date(Date.now() + 15 * 60_000).toISOString() }).eq("id", existing.id)
    return
  }
  await supabase.from("outbox").insert({
    org_id: input.orgId, job_type: "trade_schedule_change_notice", dedupe_key: dedupeKey,
    payload: { company_id: input.companyId, project_id: input.projectId, actor_id: input.actorId, changes: [change] },
    run_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  })
}

export async function sendScheduleChangeDigestJob(supabase: SupabaseClient, job: { org_id: string; payload: Record<string, unknown> }) {
  const companyId = typeof job.payload.company_id === "string" ? job.payload.company_id : null
  const projectId = typeof job.payload.project_id === "string" ? job.payload.project_id : null
  if (!companyId || !projectId) throw new Error("Schedule digest is missing company or project")
  const changes = Array.isArray(job.payload.changes) ? job.payload.changes.map(one).filter((item): item is Record<string, unknown> => Boolean(item)) : []
  const ids = changes.flatMap((change) => typeof change.schedule_item_id === "string" ? [change.schedule_item_id] : [])
  if (!ids.length) return
  const [recipients, itemsResult, orgResult, companyResult, tokenResult] = await Promise.all([
    companyRecipients(supabase, job.org_id, companyId),
    supabase.from("schedule_items").select("id,name").eq("org_id", job.org_id).in("id", ids),
    supabase.from("orgs").select("name,slug,logo_url").eq("id", job.org_id).maybeSingle(),
    supabase.from("companies").select("name").eq("org_id", job.org_id).eq("id", companyId).maybeSingle(),
    supabase.from("portal_access_tokens").select("token").eq("org_id", job.org_id).eq("project_id", projectId).eq("company_id", companyId).eq("portal_type", "sub").is("revoked_at", null).limit(1).maybeSingle(),
  ])
  if (!recipients.length) return
  const names = new Map((itemsResult.data ?? []).map((item) => [item.id, item.name]))
  const lines = changes.map((change) => `<li>${escapeHtml(names.get(String(change.schedule_item_id)) ?? "Scheduled work")}: ${escapeHtml(String(change.old_start ?? "unscheduled"))} → ${escapeHtml(String(change.new_start ?? "unscheduled"))}</li>`).join("")
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://arcnaples.com").replace(/\/$/, "")
  const html = renderStandardEmailLayout({ title: "Schedule dates changed", messageHtml: `<p>${escapeHtml(companyResult.data?.name ?? "Trade partner")}, these dates changed:</p><ul>${lines}</ul>`, buttonText: tokenResult.data?.token ? "Open trade portal" : undefined, buttonUrl: tokenResult.data?.token ? `${appUrl}/s/${tokenResult.data.token}` : undefined, orgName: orgResult.data?.name, orgLogoUrl: orgResult.data?.logo_url, showManageSettings: false })
  await sendEmail({ to: recipients, subject: "Schedule dates changed", html, from: getOrgSenderEmail(orgResult.data?.slug, orgResult.data?.name) })
  const actorId = typeof job.payload.actor_id === "string" ? job.payload.actor_id : null
  const event = await recordEvent({ orgId: job.org_id, actorId, eventType: "trade_schedule_change_notice.sent", entityType: "project", entityId: projectId, payload: { project_id: projectId, company_id: companyId, change_count: changes.length } })
  await recordAudit({ orgId: job.org_id, actorId: actorId ?? undefined, action: "insert", entityType: "trade_notice", entityId: event.id, source: "trade_notice", after: { project_id: projectId, company_id: companyId, change_count: changes.length } })
}
