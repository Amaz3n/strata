import { z } from "zod"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import { MobileAPIError } from "@/lib/mobile/api"
import { allowed } from "@/lib/mobile/workspace"
import { field, section, type Action, type Field } from "@/lib/mobile/workspace-detail"
import { ACTIVITY_KINDS, ACTIVITY_LABELS } from "@/lib/sales/activity"
import { LOST_REASON_CODES, LOST_REASON_LABELS } from "@/lib/sales/lost-reasons"
import { updateProspectInputSchema, logProspectContactInputSchema, markProspectLostInputSchema, prospectContactInputSchema } from "@/lib/validation/prospects"

const prospectFields: Field[] = [field("name", "Opportunity name", "text", true), field("source", "Source"), field("project_type", "Project type"), field("budget_range", "Budget range"), field("timeline_preference", "Timeline"), field("notes", "Notes", "multiline")]
const contactFields = [field("full_name", "Name", "text", true), field("email", "Email"), field("phone", "Phone"), field("role", "Role"), field("company_name", "Company")]

export async function loadProspectDetail(context: MobileOrgContext, recordId: string) {
  const service = await import("@/lib/services/prospects")
  const prospect = await service.getProspect(recordId, context.orgId)
  const [contacts, activity] = await Promise.all([service.listProspectContacts(recordId, context.orgId), service.listProspectActivity(recordId, context.orgId, 100)])
  const sections = [
    section("prospect-contacts", "Contacts", contacts, ["full_name"], [field("email", "Email"), field("phone", "Phone"), field("role", "Role"), field("company_name", "Company")]),
    section("prospect-activity", "Recent Activity", activity.map(item => ({ ...item, note: item.payload?.note, kind: item.payload?.kind })), ["event_type"], [field("created_at", "When", "date"), field("kind", "Contact type"), field("note", "Note", "multiline")]),
  ]
  const actions: Action[] = []
  // Resolve linked projects independently: getProspect does not always include its project.
  const { data: project, error } = await context.serviceSupabase.from("projects").select("id,phase").eq("org_id", context.orgId).eq("prospect_id", recordId).maybeSingle()
  if (error) throw new MobileAPIError(500, "prospect_unavailable", "The opportunity workspace could not be checked.")
  if (!await allowed(context, "org.member") || (project && !await allowed(context, "project.manage", project.id)) || project?.phase === "delivery" || prospect.status === "won") return { actions, sections }
  if (prospect.status === "lost") {
    actions.push({ id: "reopen-prospect", title: "Reopen Opportunity", fields: [], revision: prospect.updated_at ?? undefined })
    return { actions, sections }
  }
  actions.push({ id: "edit-prospect", title: "Edit Opportunity", revision: prospect.updated_at ?? undefined, fields: prospectFields.map(f => ({ ...f, value: String(prospect[f.key as "name" | "source" | "project_type" | "budget_range" | "timeline_preference" | "notes"] ?? "") })) })
  const touchFields = [{ ...field("kind", "Contact type", "choice", true), options: [...ACTIVITY_KINDS], option_labels: ACTIVITY_LABELS }, field("note", "Note", "multiline")]
  actions.push({ id: "log-contact", title: "Record Contact Activity", fields: touchFields })
  actions.push({ id: "follow-up", title: "Set Follow-up Date", fields: [{ ...field("date", "Follow-up date", "date", true), value: prospect.next_follow_up_at?.slice(0, 10) }] })
  if (prospect.next_follow_up_at) actions.push({ id: "complete-follow-up", title: "Complete Follow-up", fields: touchFields })
  actions.push({ id: "add-prospect-contact", title: "Add Contact", fields: contactFields })
  if (["new", "contacted", "qualified"].includes(prospect.status)) actions.push({ id: "change-lead-stage", title: "Change Lead Stage", revision: prospect.updated_at ?? undefined, fields: [{ ...field("status", "Stage", "choice", true), options: ["new", "contacted", "qualified"], value: prospect.status }] })
  actions.push({ id: "mark-lost", title: "Mark Opportunity Lost", revision: prospect.updated_at ?? undefined, fields: [{ ...field("reasonCode", "Reason", "choice", true), options: [...LOST_REASON_CODES], option_labels: LOST_REASON_LABELS }, field("note", "Note", "multiline")] })
  return { actions, sections }
}

export async function performProspectAction(context: MobileOrgContext, recordId: string, actionId: string, values: Record<string, string>, revision?: string) {
  const service = await import("@/lib/services/prospects")
  const orgId = context.orgId
  if (actionId === "edit-prospect") return service.updateProspect({ prospectId: recordId, orgId, input: updateProspectInputSchema.parse({ ...values, expected_updated_at: revision }) })
  if (actionId === "change-lead-stage") return service.updateProspect({ prospectId: recordId, orgId, input: updateProspectInputSchema.parse({ status: z.enum(["new", "contacted", "qualified"]).parse(values.status), expected_updated_at: revision }) })
  if (actionId === "log-contact" || actionId === "complete-follow-up") {
    const input = logProspectContactInputSchema.parse({ kind: values.kind, note: values.note })
    return actionId === "log-contact" ? service.logProspectContact({ prospectId: recordId, orgId, input }) : service.completeProspectFollowUp({ prospectId: recordId, orgId, input })
  }
  if (actionId === "follow-up") return service.setProspectFollowUp({ prospectId: recordId, orgId, nextFollowUpAt: `${z.string().date().parse(values.date)}T12:00:00.000Z` })
  if (actionId === "add-prospect-contact") return service.createProspectContact({ prospectId: recordId, orgId, input: prospectContactInputSchema.parse({ ...values, email: values.email || undefined }) })
  if (actionId === "mark-lost") return service.markProspectLost({ prospectId: recordId, orgId, input: markProspectLostInputSchema.parse({ reasonCode: values.reasonCode, note: values.note }) })
  if (actionId === "reopen-prospect") return service.reopenProspect({ prospectId: recordId, orgId })
  throw new MobileAPIError(405, "action_unavailable", "This opportunity action is not available.")
}
