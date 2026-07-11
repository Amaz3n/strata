import { formatDocNumber, type DocumentNumberingSettings } from "@/lib/document-number"
import { renderMeetingMinutesPdf } from "@/lib/pdfs/meeting-minutes-pdf"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { listDistributionMembers } from "@/lib/services/distribution-lists"
import { recordEvent } from "@/lib/services/events"
import { persistGeneratedProjectPdf } from "@/lib/services/generated-project-pdfs"
import { getOrgSenderEmail, renderStandardEmailLayout, sendEmail } from "@/lib/services/mailer"
import { requirePermission } from "@/lib/services/permissions"
import { createTask } from "@/lib/services/tasks"
import { createMeetingSchema, meetingAttendeeSchema, meetingItemSchema, updateMeetingAttendeeSchema, updateMeetingItemSchema, updateMeetingSchema, type CreateMeetingInput, type MeetingAttendeeInput, type MeetingItemInput, type UpdateMeetingInput } from "@/lib/validation/meetings"

export type Meeting = {
  id: string
  org_id: string
  project_id: string
  meeting_number: number
  series: "oac" | "sub" | "safety" | "custom"
  title: string
  held_at: string | null
  location: string | null
  status: "draft" | "finalized"
  finalized_at: string | null
  pdf_file_id: string | null
  metadata: Record<string, unknown>
  created_at: string
  updated_at: string
}

export type MeetingItem = {
  id: string
  meeting_id: string
  project_id: string
  item_number: string
  first_meeting_id: string | null
  carried_from_item_id: string | null
  topic: string
  discussion: string | null
  status: "open" | "closed" | "info"
  ball_in_court: string | null
  due_date: string | null
  task_id: string | null
  sort_order: number
}

export type MeetingAttendee = {
  id: string
  meeting_id: string
  contact_id: string | null
  user_id: string | null
  display_name: string
  company_name: string | null
  email: string | null
  present: boolean
}

export type MeetingDetail = Meeting & { items: MeetingItem[]; attendees: MeetingAttendee[]; display_number: string }

const MEETING_SELECT = "id, org_id, project_id, meeting_number, series, title, held_at, location, status, finalized_at, pdf_file_id, metadata, created_at, updated_at"
const ITEM_SELECT = "id, meeting_id, project_id, item_number, first_meeting_id, carried_from_item_id, topic, discussion, status, ball_in_court, due_date, task_id, sort_order"
const ATTENDEE_SELECT = "id, meeting_id, contact_id, user_id, display_name, company_name, email, present"

async function loadNumbering(supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"], orgId: string) {
  const { data } = await supabase.from("orgs").select("document_numbering").eq("id", orgId).single()
  return (data?.document_numbering ?? {}) as DocumentNumberingSettings
}

export async function listMeetings(projectId: string, orgId?: string): Promise<Array<Meeting & { display_number: string }>> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.read", { supabase, orgId: resolvedOrgId, userId })
  const [{ data, error }, numbering] = await Promise.all([
    supabase.from("meetings").select(MEETING_SELECT).eq("org_id", resolvedOrgId).eq("project_id", projectId).order("series").order("meeting_number", { ascending: false }).limit(250),
    loadNumbering(supabase, resolvedOrgId),
  ])
  if (error) throw new Error(`Failed to load meetings: ${error.message}`)
  return (data ?? []).map((meeting) => ({ ...meeting, display_number: formatDocNumber("meeting", meeting.meeting_number, numbering) })) as Array<Meeting & { display_number: string }>
}

export async function getMeeting(meetingId: string, orgId?: string): Promise<MeetingDetail> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.read", { supabase, orgId: resolvedOrgId, userId })
  const [{ data: meeting, error }, { data: items }, { data: attendees }, numbering] = await Promise.all([
    supabase.from("meetings").select(MEETING_SELECT).eq("org_id", resolvedOrgId).eq("id", meetingId).single(),
    supabase.from("meeting_items").select(ITEM_SELECT).eq("org_id", resolvedOrgId).eq("meeting_id", meetingId).order("sort_order"),
    supabase.from("meeting_attendees").select(ATTENDEE_SELECT).eq("org_id", resolvedOrgId).eq("meeting_id", meetingId).order("display_name"),
    loadNumbering(supabase, resolvedOrgId),
  ])
  if (error || !meeting) throw new Error("Meeting not found")
  return { ...meeting, items: items ?? [], attendees: attendees ?? [], display_number: formatDocNumber("meeting", meeting.meeting_number, numbering) } as MeetingDetail
}

export async function createNextMeeting(input: CreateMeetingInput, orgId?: string): Promise<MeetingDetail> {
  const parsed = createMeetingSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("meeting.write", { supabase, orgId: resolvedOrgId, userId })
  const { data: nextNumber, error: numberError } = await supabase.rpc("next_meeting_number", { p_project_id: parsed.project_id, p_series: parsed.series })
  if (numberError || typeof nextNumber !== "number") throw new Error(`Failed to allocate meeting number: ${numberError?.message}`)
  const { data: previous } = await supabase.from("meetings").select("id").eq("org_id", resolvedOrgId).eq("project_id", parsed.project_id).eq("series", parsed.series).eq("status", "finalized").order("meeting_number", { ascending: false }).limit(1).maybeSingle()
  const { data: meeting, error } = await supabase.from("meetings").insert({
    org_id: resolvedOrgId, project_id: parsed.project_id, meeting_number: nextNumber, series: parsed.series,
    title: parsed.title, held_at: parsed.held_at ?? null, location: parsed.location ?? null,
  }).select(MEETING_SELECT).single()
  if (error || !meeting) throw new Error(`Failed to create meeting: ${error?.message}`)
  if (previous) {
    const { data: openItems } = await supabase.from("meeting_items").select(ITEM_SELECT).eq("org_id", resolvedOrgId).eq("meeting_id", previous.id).eq("status", "open").order("sort_order")
    if (openItems?.length) {
      const { error: carryError } = await supabase.from("meeting_items").insert(openItems.map((item) => ({
        org_id: resolvedOrgId, project_id: parsed.project_id, meeting_id: meeting.id,
        item_number: item.item_number, first_meeting_id: item.first_meeting_id ?? previous.id,
        carried_from_item_id: item.id, topic: item.topic, discussion: null, status: "open",
        ball_in_court: item.ball_in_court, due_date: item.due_date, task_id: item.task_id, sort_order: item.sort_order,
      })))
      if (carryError) throw new Error(`Meeting created but items could not be carried forward: ${carryError.message}`)
    }
  }
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "meeting", entityId: meeting.id, after: meeting })
  return getMeeting(meeting.id, resolvedOrgId)
}

async function requireEditableMeeting(meetingId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("meeting.write", { supabase: context.supabase, orgId: context.orgId, userId: context.userId })
  const { data } = await context.supabase.from("meetings").select(MEETING_SELECT).eq("org_id", context.orgId).eq("id", meetingId).single()
  if (!data) throw new Error("Meeting not found")
  if (data.status === "finalized") throw new Error("Finalized meeting minutes are locked")
  return { ...context, meeting: data as Meeting }
}

export async function addMeetingItem(input: MeetingItemInput, orgId?: string): Promise<MeetingItem> {
  const parsed = meetingItemSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId, meeting } = await requireEditableMeeting(parsed.meeting_id, orgId)
  const { count } = await supabase.from("meeting_items").select("id", { count: "exact", head: true }).eq("org_id", resolvedOrgId).eq("meeting_id", meeting.id).is("carried_from_item_id", null)
  const itemNumber = `${meeting.meeting_number}.${(count ?? 0) + 1}`
  const { data, error } = await supabase.from("meeting_items").insert({
    org_id: resolvedOrgId, project_id: meeting.project_id, meeting_id: meeting.id, item_number: itemNumber,
    first_meeting_id: meeting.id, topic: parsed.topic, discussion: parsed.discussion ?? null, status: parsed.status,
    ball_in_court: parsed.ball_in_court ?? null, due_date: parsed.due_date ?? null, sort_order: (count ?? 0) + 1000,
  }).select(ITEM_SELECT).single()
  if (error || !data) throw new Error(`Failed to add meeting item: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "meeting_item", entityId: data.id, after: data })
  return data as MeetingItem
}

export async function updateMeeting(meetingId: string, input: UpdateMeetingInput, orgId?: string): Promise<Meeting> {
  const parsed = updateMeetingSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId, meeting } = await requireEditableMeeting(meetingId, orgId)
  const { data, error } = await supabase
    .from("meetings")
    .update(parsed)
    .eq("org_id", resolvedOrgId)
    .eq("id", meetingId)
    .select(MEETING_SELECT)
    .single()
  if (error || !data) throw new Error(`Failed to update meeting: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "meeting", entityId: meetingId, before: meeting, after: data })
  return data as Meeting
}

export async function deleteMeeting(meetingId: string, orgId?: string): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId, meeting } = await requireEditableMeeting(meetingId, orgId)
  const { error } = await supabase.from("meetings").delete().eq("org_id", resolvedOrgId).eq("id", meetingId)
  if (error) throw new Error(`Failed to delete meeting: ${error.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "delete", entityType: "meeting", entityId: meetingId, before: meeting })
}

export async function updateMeetingItem(meetingItemId: string, input: Partial<Omit<MeetingItemInput, "meeting_id">>, orgId?: string): Promise<MeetingItem> {
  const parsed = updateMeetingItemSchema.parse(input)
  const context = await requireOrgContext(orgId)
  const { data: existing } = await context.supabase.from("meeting_items").select(ITEM_SELECT).eq("org_id", context.orgId).eq("id", meetingItemId).single()
  if (!existing) throw new Error("Meeting item not found")
  await requireEditableMeeting(existing.meeting_id, context.orgId)
  const { data, error } = await context.supabase.from("meeting_items").update(parsed).eq("org_id", context.orgId).eq("id", meetingItemId).select(ITEM_SELECT).single()
  if (error || !data) throw new Error(`Failed to update meeting item: ${error?.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "meeting_item", entityId: meetingItemId, before: existing, after: data })
  return data as MeetingItem
}

export async function addMeetingAttendee(input: MeetingAttendeeInput, orgId?: string): Promise<MeetingAttendee> {
  const parsed = meetingAttendeeSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireEditableMeeting(parsed.meeting_id, orgId)
  const { data, error } = await supabase.from("meeting_attendees").insert({ org_id: resolvedOrgId, ...parsed }).select(ATTENDEE_SELECT).single()
  if (error || !data) throw new Error(`Failed to add attendee: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "meeting_attendee", entityId: data.id, after: data })
  return data as MeetingAttendee
}

export async function updateMeetingAttendee(attendeeId: string, input: Partial<Omit<MeetingAttendeeInput, "meeting_id">>, orgId?: string): Promise<MeetingAttendee> {
  const parsed = updateMeetingAttendeeSchema.parse(input)
  const context = await requireOrgContext(orgId)
  const { data: existing } = await context.supabase.from("meeting_attendees").select(ATTENDEE_SELECT).eq("org_id", context.orgId).eq("id", attendeeId).single()
  if (!existing) throw new Error("Meeting attendee not found")
  await requireEditableMeeting(existing.meeting_id, context.orgId)
  const { data, error } = await context.supabase.from("meeting_attendees").update(parsed).eq("org_id", context.orgId).eq("id", attendeeId).select(ATTENDEE_SELECT).single()
  if (error || !data) throw new Error(`Failed to update attendance: ${error?.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "meeting_attendee", entityId: attendeeId, before: existing, after: data })
  return data as MeetingAttendee
}

export async function createTaskFromMeetingItem({ itemId, assigneeId, assigneeKind, orgId }: { itemId: string; assigneeId?: string; assigneeKind?: "user" | "contact"; orgId?: string }) {
  const context = await requireOrgContext(orgId)
  const { data: item } = await context.supabase.from("meeting_items").select(`${ITEM_SELECT}, meetings!inner(title, status)`).eq("org_id", context.orgId).eq("id", itemId).single()
  if (!item) throw new Error("Meeting item not found")
  if (item.task_id) throw new Error("This item already has a linked task")
  const task = await createTask({ input: { project_id: item.project_id, title: item.topic, description: item.discussion ?? undefined, status: "todo", priority: "normal", due_date: item.due_date ?? undefined, assignee_id: assigneeId, assignee_kind: assigneeKind }, orgId: context.orgId })
  await context.supabase.from("meeting_items").update({ task_id: task.id }).eq("org_id", context.orgId).eq("id", itemId)
  return task
}

export async function finalizeMeeting(meetingId: string, orgId?: string): Promise<MeetingDetail> {
  const { supabase, orgId: resolvedOrgId, userId, meeting } = await requireEditableMeeting(meetingId, orgId)
  const detail = await getMeeting(meetingId, resolvedOrgId)
  const [{ data: project }, { data: org }] = await Promise.all([
    supabase.from("projects").select("name").eq("org_id", resolvedOrgId).eq("id", meeting.project_id).single(),
    supabase.from("orgs").select("name, slug, address, document_numbering").eq("id", resolvedOrgId).single(),
  ])
  const displayNumber = formatDocNumber("meeting", meeting.meeting_number, (org?.document_numbering ?? {}) as DocumentNumberingSettings)
  const pdf = await renderMeetingMinutesPdf({
    header: { orgName: org?.name ?? "Arc", orgAddress: typeof org?.address === "string" ? org.address : null, projectName: project?.name ?? "Project", title: "Meeting Minutes", documentNumber: displayNumber, date: meeting.held_at ? new Date(meeting.held_at).toLocaleDateString() : null },
    series: meeting.series, title: meeting.title, heldAt: meeting.held_at, location: meeting.location,
    attendees: detail.attendees.map((attendee) => ({ name: attendee.display_name, company: attendee.company_name, present: attendee.present })),
    items: detail.items.map((item) => ({ number: item.item_number, topic: item.topic, discussion: item.discussion, status: item.status, ballInCourt: item.ball_in_court, dueDate: item.due_date, carried: Boolean(item.carried_from_item_id) })),
  })
  const fileName = `meeting-${meeting.series}-${displayNumber}.pdf`.replaceAll("/", "-")
  const file = await persistGeneratedProjectPdf({ supabase, orgId: resolvedOrgId, projectId: meeting.project_id, fileName, pdf, category: "other", folderPath: "Meetings", description: `${meeting.title} meeting minutes` })
  const finalizedAt = new Date().toISOString()
  const { error } = await supabase.from("meetings").update({ status: "finalized", finalized_at: finalizedAt, pdf_file_id: file.id }).eq("org_id", resolvedOrgId).eq("id", meetingId)
  if (error) throw new Error(`Failed to finalize meeting: ${error.message}`)
  const distribution = await listDistributionMembers(meeting.project_id, resolvedOrgId)
  const recipients = [...detail.attendees.map((attendee) => attendee.email), ...distribution.filter((member) => member.scope === "all").map((member) => member.email)].filter((email): email is string => Boolean(email))
  if (recipients.length) {
    const html = renderStandardEmailLayout({ title: `${meeting.title} minutes finalized`, messageHtml: `Meeting minutes ${displayNumber} for ${project?.name ?? "the project"} are finalized and attached.`, orgName: org?.name, showManageSettings: false })
    await sendEmail({ to: recipients, subject: `${meeting.title} — ${displayNumber}`, html, from: getOrgSenderEmail(org?.slug, org?.name), attachments: [{ filename: fileName, content: pdf.toString("base64"), contentType: "application/pdf" }] })
  }
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "meeting_finalized", entityType: "meeting", entityId: meetingId, payload: { project_id: meeting.project_id, meeting_number: meeting.meeting_number } })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "meeting", entityId: meetingId, before: meeting, after: { ...meeting, status: "finalized", finalized_at: finalizedAt, pdf_file_id: file.id } })
  return getMeeting(meetingId, resolvedOrgId)
}
