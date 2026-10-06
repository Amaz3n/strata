import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

import { escapeHtml, getOrgSenderEmail, renderStandardEmailLayout, sendEmail } from "@/lib/services/mailer"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { getProjectReadScopeForUser } from "@/lib/services/authorization"
import { readAllRowsById } from "@/lib/land/paging"
import { SCHEDULE_DIGEST_WINDOW_MS, scheduleDigestKey } from "@/lib/starts/even-flow-math"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { lookaheadSchema, tradeLookaheadWorkspaceSchema, tradeSchedulePageSchema, tradeWorkspaceReplySchema } from "@/lib/validation/starts"

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

function text(value: unknown) {
  return typeof value === "string" ? value : null
}

async function companyRecipients(supabase: SupabaseClient, orgId: string, companyId: string) {
  const contacts = await readAllRowsById((after, take) => {
    let query = supabase.from("contacts").select("id,email").eq("org_id", orgId).eq("company_id", companyId).not("email", "is", null)
    if (after) query = query.gt("id", after)
    return query.order("id").limit(take)
  }, { cap: 10000, label: "Failed to load trade contacts" })
  return Array.from(new Set(contacts.flatMap(contact => contact.email ? [contact.email] : [])))
}

async function loadTradeLookahead(
  input: { weeks: 2 | 3 | 4; communityId?: string; divisionId?: string; companyId?: string; page?: number; pageSize?: number },
  orgId?: string,
): Promise<TradeLookaheadRow[]> {
  const parsed = lookaheadSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("start.read", context)
  const access = await getProjectReadScopeForUser(context)
  const divisions = parsed.divisionId ? access.divisionIds === null || access.divisionIds.includes(parsed.divisionId) ? [parsed.divisionId] : [] : access.divisionIds
  if (divisions !== null && !divisions.length) return []
  const lot = `lot:lots!lots_project_id_fkey${parsed.communityId ? "!inner" : ""}(org_id,lot_number,block,community_id,community:communities${parsed.communityId ? "!inner" : ""}(org_id,name))`
  const projectSelect = `project:projects!inner(property_type,status,${lot}${access.projectMembershipRequired ? ",access:project_members!project_members_project_id_fkey!inner(id)" : ""})`
  const start = new Date().toISOString().slice(0, 10)
  const endDate = new Date()
  endDate.setUTCDate(endDate.getUTCDate() + parsed.weeks * 7)
  const end = endDate.toISOString().slice(0, 10)
  // The lot hangs off the project, not off the schedule item — there is no
  // schedule_items → lots foreign key to embed through. The project owns the
  // lot filter; its join is inner only for an explicit community lens.
  // Unscoped work keeps projects without lots, while scoped queries narrow early.
  const items = await readAllRowsById(async (after, take) => {
    let query = context.supabase.from("schedule_items").select(`
    id,project_id,name,trade,status,start_date,end_date,cost_code_id,
    ${projectSelect},
    assignments:schedule_assignments(company_id,confirmed_at,company:companies(name))
  `).eq("org_id", context.orgId).eq("project.org_id", context.orgId)
      .eq("project.property_type", "production").eq("project.status", "active")
      .gte("start_date", start).lte("start_date", end)
    if (divisions !== null) query = query.in("project.division_id", divisions)
    if (access.projectMembershipRequired) query = query.eq("project.access.org_id", context.orgId).eq("project.access.user_id", context.userId).eq("project.access.status", "active")
    if (parsed.communityId) query = query.eq("project.lot.org_id", context.orgId).eq("project.lot.community.org_id", context.orgId).eq("project.lot.community_id", parsed.communityId)
    if (after) query = query.gt("id", after)
    const result = await query.order("id").limit(take)
    if (result.error) return { data: null, error: result.error }
    return { data: tradeSchedulePageSchema.parse(result.data), error: null }
  }, { cap: 100000, label: "Failed to load trade look-ahead; narrow the community or schedule window" })
  items.sort((a, b) => a.start_date.localeCompare(b.start_date) || a.id.localeCompare(b.id))
  const unresolved = items.filter((item) => !(item.assignments ?? []).some((assignment: { company_id?: string | null }) => assignment.company_id) && item.cost_code_id)
  const projectIds = Array.from(new Set(unresolved.map((item) => item.project_id)))
  const costsByProject = new Map<string, Set<string>>()
  for (const item of unresolved) {
    if (!item.cost_code_id) continue
    const costs = costsByProject.get(item.project_id) ?? new Set<string>()
    costs.add(item.cost_code_id)
    costsByProject.set(item.project_id, costs)
  }
  const vendorsByProjectCost = new Map<string, Map<string, { id: string; name: string }>>()
  for (let offset = 0; offset < projectIds.length; offset += 100) {
    const batch = projectIds.slice(offset, offset + 100)
    const costCodeIds = Array.from(new Set(batch.flatMap((id) => Array.from(costsByProject.get(id) ?? []))))
    for (let costOffset = 0; costOffset < costCodeIds.length; costOffset += 100) {
      const commitments = await readAllRowsById((after, take) => {
        let query = context.supabase.from("commitment_lines").select("id,cost_code_id,commitment:commitments!inner(project_id,company_id,company:companies(name),commitment_type)")
          .eq("org_id", context.orgId).eq("commitment.org_id", context.orgId)
          .in("commitment.project_id", batch).in("cost_code_id", costCodeIds.slice(costOffset, costOffset + 100))
          .eq("commitment.commitment_type", "purchase_order")
        if (after) query = query.gt("id", after)
        return query.order("id").limit(take)
      }, { cap: 100000, label: "Failed to load look-ahead purchase orders" })
      for (const line of commitments) {
        const commitment = one(line.commitment)
        const company = one(commitment?.company)
        if (commitment?.company_id && typeof commitment.project_id === "string") {
          if (!batch.includes(commitment.project_id)) throw new Error("Look-ahead purchase order belongs to an unexpected home")
          const key = `${commitment.project_id}:${line.cost_code_id}`
          const vendors = vendorsByProjectCost.get(key) ?? new Map<string, { id: string; name: string }>()
          vendors.set(String(commitment.company_id), { id: String(commitment.company_id), name: String(company?.name ?? "Trade company") })
          vendorsByProjectCost.set(key, vendors)
        }
      }
    }
  }
  const groups = new Map<string, TradeLookaheadRow>()
  for (const item of items ?? []) {
    const itemLot = one(one(item.project)?.lot)
    if (parsed.communityId && text(itemLot?.community_id) !== parsed.communityId) continue
    const assigned = (item.assignments ?? []).filter((row: { company_id?: string | null }) => row.company_id)
    const seenCompanies = new Set<string | null>()
    for (const assignment of assigned.length ? assigned : [null]) {
      const assignedCompany = assignment ? one(assignment.company) : null
      const possibleVendors = item.cost_code_id ? vendorsByProjectCost.get(`${item.project_id}:${item.cost_code_id}`) : undefined
      // Multiple PO vendors are not an assignment. Keep the task unassigned so
      // the coordinator fixes its original schedule rather than emailing a guess.
      const fallback = possibleVendors?.size === 1 ? possibleVendors.values().next().value : undefined
      const companyId = assignment?.company_id ?? fallback?.id ?? null
      if (seenCompanies.has(companyId)) continue
      seenCompanies.add(companyId)
      if (parsed.companyId && companyId !== parsed.companyId) continue
      const companyName = assignedCompany?.name ? String(assignedCompany.name) : fallback?.name ?? "Unassigned"
      const key = `${companyId ?? "unassigned"}:${item.trade ?? ""}`
      const lot = itemLot
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
  }
  return Array.from(groups.values()).sort((a, b) => a.companyName.localeCompare(b.companyName)
    || (a.companyId ?? "").localeCompare(b.companyId ?? "") || (a.trade ?? "").localeCompare(b.trade ?? ""))
}

export async function getTradeLookahead(
  input: { weeks: 2 | 3 | 4; communityId?: string; divisionId?: string; companyId?: string; page?: number; pageSize?: number },
  orgId?: string,
): Promise<{ rows: TradeLookaheadRow[]; total: number }> {
  const parsed = lookaheadSchema.parse(input)
  const all = await loadTradeLookahead(parsed, orgId)
  const offset = (parsed.page - 1) * parsed.pageSize
  return { rows: all.slice(offset, offset + parsed.pageSize), total: all.length }
}

export interface TradeLookaheadSummary {
  key: string
  companyId: string | null
  companyName: string
  trade: string | null
  itemCount: number
  confirmedCount: number
  firstDate: string | null
}

/** Original read owner; summaries avoid serializing every task into the desk. */
export async function getTradeLookaheadWorkspace(input: unknown, orgId?: string) {
  const parsed = tradeLookaheadWorkspaceSchema.parse(input)
  if (process.env.ARC_TRADE_DATABASE_WORKSPACE_ENABLED === "true") {
    const context = await requireOrgContext(orgId)
    await requirePermission("start.read", context)
    const { data, error } = await context.supabase.rpc("read_trade_lookahead_workspace", {
      p_org: context.orgId, p_actor: context.userId, p_weeks: parsed.weeks,
      p_division: parsed.divisionId ?? null, p_community: parsed.communityId ?? null,
      p_q: parsed.q, p_page: parsed.page, p_group: parsed.group ?? null, p_item_page: parsed.itemPage,
    })
    if (error) throw new Error(`Failed to load database trade workspace: ${error.message}`)
    const page = tradeWorkspaceReplySchema.parse(data)
    const expectedRows = Math.min(50, Math.max(0, page.total - (parsed.page - 1) * 50))
    const sameScope = page.orgId === context.orgId && page.actorId === context.userId && page.divisionId === (parsed.divisionId ?? null) && page.communityId === (parsed.communityId ?? null)
    const sameQuery = page.weeks === parsed.weeks && page.q === parsed.q && page.page === parsed.page && page.group === (parsed.group ?? null) && page.itemPage === parsed.itemPage
    const summaries = [...page.rows, ...(page.selected ? [page.selected] : [])]
    const validSummaries = summaries.every(row => row.key === JSON.stringify([row.companyId,row.trade]) && row.confirmedCount <= row.itemCount)
    const validSelection = page.selected ? page.selected.key === parsed.group && !page.selectedUnavailable && page.selected.items.length === Math.min(50, Math.max(0, page.selected.itemCount - (parsed.itemPage - 1) * 50)) && new Set(page.selected.items.map(item => item.scheduleItemId)).size === page.selected.items.length : page.selectedUnavailable === Boolean(parsed.group)
    if (!sameScope || !sameQuery || !validSummaries || !validSelection || page.rows.length !== expectedRows || new Set(page.rows.map(row => row.key)).size !== page.rows.length) throw new Error("Database trade workspace reply differs from the reviewed scope or page")
    return page
  }
  const all = await loadTradeLookahead(parsed, orgId)
  const key = (row: TradeLookaheadRow) => JSON.stringify([row.companyId, row.trade])
  const matching = all.filter(row => `${row.companyName} ${row.trade ?? ""}`.toLowerCase().includes(parsed.q.toLowerCase()))
  const summarize = (row: TradeLookaheadRow): TradeLookaheadSummary => ({
    key: key(row), companyId: row.companyId, companyName: row.companyName, trade: row.trade,
    itemCount: row.items.length, confirmedCount: row.items.filter(item => item.confirmation === "confirmed").length,
    firstDate: row.items[0]?.startDate ?? null,
  })
  const selected = parsed.group ? all.find(row => key(row) === parsed.group) : undefined

  const pageSize = 50, itemPageSize = 50
  return {
    rows: matching.slice((parsed.page - 1) * pageSize, parsed.page * pageSize).map(summarize),
    total: matching.length, page: parsed.page, pageSize,
    selectedUnavailable: Boolean(parsed.group && !selected),
    selected: selected ? { ...summarize(selected), items: selected.items.slice((parsed.itemPage - 1) * itemPageSize, parsed.itemPage * itemPageSize) } : null,
    itemPage: parsed.itemPage, itemPageSize,
  }
}

export async function sendTradeLookahead(
  companyId: string,
  opts: { weeks: 2 | 3 | 4; communityId?: string; divisionId?: string; releaseNoticeKey?: string },
  orgId?: string,
) {
  const context = await requireOrgContext(orgId)
  await requirePermission("start.write", context)
  const today = new Date().toISOString().slice(0, 10)
  let sentQuery = context.supabase.from("events").select("id", { count: "exact", head: true })
    .eq("org_id", context.orgId).eq("event_type", "trade_lookahead.sent").eq("payload->>company_id", companyId)
  sentQuery = opts.releaseNoticeKey
    ? sentQuery.eq("payload->>release_notice_key", opts.releaseNoticeKey)
    : sentQuery.gte("created_at", `${today}T00:00:00.000Z`)
  const { count: alreadySent, error: dedupeError } = await sentQuery
  if (dedupeError || alreadySent === null) throw new Error(`Failed to inspect sent trade notices: ${dedupeError?.message ?? "Count unavailable"}`)
  if (alreadySent > 0) return { sent: false }
  let row: TradeLookaheadRow | undefined
  const rows = await loadTradeLookahead({ ...opts, companyId }, context.orgId)
  for (const candidate of rows) {
    if (candidate.companyId !== companyId) continue
    if (!row) row = { ...candidate, items: [] }
    row.items.push(...candidate.items)
  }
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
  const accepted = await sendEmail({ to: recipients, subject: `${opts.weeks}-week trade look-ahead`, html, from: getOrgSenderEmail(org?.slug, org?.name) })
  if (!accepted) throw new Error("Trade look-ahead email was not accepted; retry after correcting delivery settings or recipients")
  const event = await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "trade_lookahead.sent", entityType: "company", entityId: companyId, payload: { company_id: companyId, recipients: recipients.length, item_count: row.items.length, ...(opts.releaseNoticeKey ? { release_notice_key: opts.releaseNoticeKey } : {}) } })
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
  const dedupeKey = scheduleDigestKey(input.companyId, input.projectId, Date.now())
  const { data: existing } = await supabase.from("outbox").select("id,payload").eq("org_id", input.orgId).eq("dedupe_key", dedupeKey).eq("status", "pending").maybeSingle()
  const change = { schedule_item_id: input.scheduleItemId, old_start: input.oldStart, new_start: input.newStart }
  if (existing) {
    const payload = existing.payload && typeof existing.payload === "object" ? existing.payload as Record<string, unknown> : {}
    const changes = Array.isArray(payload.changes) ? payload.changes.filter((item) => one(item)?.schedule_item_id !== input.scheduleItemId) : []
    await supabase.from("outbox").update({ payload: { ...payload, actor_id: input.actorId, changes: [...changes, change] }, run_at: new Date(Date.now() + SCHEDULE_DIGEST_WINDOW_MS).toISOString() }).eq("id", existing.id)
    return
  }
  await supabase.from("outbox").insert({
    org_id: input.orgId, job_type: "trade_schedule_change_notice", dedupe_key: dedupeKey,
    payload: { company_id: input.companyId, project_id: input.projectId, actor_id: input.actorId, changes: [change] },
    run_at: new Date(Date.now() + SCHEDULE_DIGEST_WINDOW_MS).toISOString(),
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
  const accepted = await sendEmail({ to: recipients, subject: "Schedule dates changed", html, from: getOrgSenderEmail(orgResult.data?.slug, orgResult.data?.name) })
  if (!accepted) throw new Error("Schedule change email was not accepted; retry after correcting delivery settings or recipients")
  const actorId = typeof job.payload.actor_id === "string" ? job.payload.actor_id : null
  const event = await recordEvent({ orgId: job.org_id, actorId, eventType: "trade_schedule_change_notice.sent", entityType: "project", entityId: projectId, payload: { project_id: projectId, company_id: companyId, change_count: changes.length } })
  await recordAudit({ orgId: job.org_id, actorId: actorId ?? undefined, action: "insert", entityType: "trade_notice", entityId: event.id, source: "trade_notice", after: { project_id: projectId, company_id: companyId, change_count: changes.length } })
}
