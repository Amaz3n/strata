/**
 * The correspondence packet.
 *
 * A quasi-evidentiary log is only useful if you can hand it to someone — a
 * lawyer, an owner, a mediator. This assembles either one thread or whatever
 * the current filters select, with the bodies, the links and who ruled on each
 * classification, and says plainly when it hit its cap.
 */

import {
  CLASSIFICATION_LABELS,
  linkedEntityLabel,
  type CorrespondenceClassifiedBy,
} from "@/lib/correspondence"
import {
  getCorrespondenceThread,
  getProjectEmail,
  listCorrespondenceThreads,
  type ProjectEmailDetail,
} from "@/lib/services/correspondence"
import { requireOrgContext } from "@/lib/services/context"
import { requireProjectPermission } from "@/lib/services/permissions"
import type { CorrespondenceFilterInput } from "@/lib/validation/correspondence"

/** Threads one filtered export walks, and messages it will render. */
const EXPORT_THREAD_CAP = 200
const EXPORT_MESSAGE_CAP = 500

const RULED_BY_LABELS: Record<CorrespondenceClassifiedBy, string> = {
  user: "confirmed by a person",
  ai: "suggested by Arc",
  system: "not yet reviewed",
}

export interface CorrespondenceExportMessage {
  id: string
  occurred_at: string
  direction: "inbound" | "outbound"
  from_address: string
  to_addresses: string
  cc_addresses: string
  subject: string
  classification: string
  ruled_by: string
  links: string
  attachments: string
  body: string
}

export interface CorrespondenceExport {
  project_id: string
  title: string
  generated_at: string
  scope: Array<{ label: string; value: string | null }>
  messages: CorrespondenceExportMessage[]
  truncated_note: string | null
}

function toExportMessage(message: ProjectEmailDetail): CorrespondenceExportMessage {
  return {
    id: message.id,
    occurred_at: message.occurred_at,
    direction: message.direction,
    from_address: message.from_address,
    to_addresses: message.to_addresses.join(", "),
    cc_addresses: message.cc_addresses.join(", "),
    subject: message.subject,
    classification: CLASSIFICATION_LABELS[message.classification],
    ruled_by: RULED_BY_LABELS[message.classified_by],
    links: message.links.map((link) => linkedEntityLabel(link.entity_type) ?? link.entity_type).join(", "),
    attachments: message.attachments.map((attachment) => attachment.file_name).join(", "),
    body: message.body || message.body_preview || "",
  }
}

function filterScope(filters: CorrespondenceFilterInput): Array<{ label: string; value: string | null }> {
  return [
    { label: "Search", value: filters.search ?? null },
    {
      label: "Classification",
      value: filters.classification ? CLASSIFICATION_LABELS[filters.classification] : "All",
    },
    {
      label: "Direction",
      value: filters.direction === "inbound" ? "Received" : filters.direction === "outbound" ? "Sent" : "All",
    },
    { label: "From date", value: filters.from ?? null },
    { label: "To date", value: filters.to ?? null },
    { label: "Needs review only", value: filters.needsReview ? "Yes" : null },
    { label: "Linked", value: filters.linked ?? null },
    { label: "With attachments", value: filters.hasAttachments ? "Yes" : null },
  ]
}

export async function getCorrespondenceExport(
  input: { filters: CorrespondenceFilterInput; threadId?: string | null },
  orgId?: string,
): Promise<CorrespondenceExport> {
  const context = await requireOrgContext(orgId)
  await requireProjectPermission(context.userId, input.filters.projectId, "correspondence.read")
  const generatedAt = new Date().toISOString()

  if (input.threadId) {
    const thread = await getCorrespondenceThread(
      { projectId: input.filters.projectId, threadId: input.threadId },
      context.orgId,
    )
    if (!thread) throw new Error("That conversation is no longer in this project's log.")
    return {
      project_id: input.filters.projectId,
      title: thread.subject,
      generated_at: generatedAt,
      scope: [
        { label: "Conversation", value: thread.subject },
        { label: "Messages", value: String(thread.messages.length) },
      ],
      messages: thread.messages.map(toExportMessage),
      truncated_note: null,
    }
  }

  const page = await listCorrespondenceThreads(
    { ...input.filters, page: 1, pageSize: EXPORT_THREAD_CAP },
    context.orgId,
  )

  const messages: CorrespondenceExportMessage[] = []
  let capped = page.total > EXPORT_THREAD_CAP
  for (const thread of page.threads) {
    if (messages.length >= EXPORT_MESSAGE_CAP) {
      capped = true
      break
    }
    const detail = await getCorrespondenceThread(
      { projectId: input.filters.projectId, threadId: thread.thread_id },
      context.orgId,
    )
    for (const message of detail?.messages ?? []) {
      if (messages.length >= EXPORT_MESSAGE_CAP) {
        capped = true
        break
      }
      messages.push(toExportMessage(message))
    }
  }
  messages.sort((left, right) => left.occurred_at.localeCompare(right.occurred_at))

  return {
    project_id: input.filters.projectId,
    title: "Correspondence log",
    generated_at: generatedAt,
    scope: [
      ...filterScope(input.filters),
      { label: "Conversations", value: `${page.threads.length} of ${page.total}` },
      { label: "Messages", value: String(messages.length) },
    ],
    messages,
    truncated_note: capped
      ? `This packet covers the first ${messages.length} messages across ${page.threads.length} of ${page.total} conversations. Narrow the date range to export the rest.`
      : null,
  }
}

/** One message, for the "export this email" action in the detail sheet. */
export async function getCorrespondenceMessageExport(
  input: { projectId: string; emailId: string },
  orgId?: string,
): Promise<CorrespondenceExport> {
  const context = await requireOrgContext(orgId)
  const message = await getProjectEmail(input.emailId, input.projectId, context.orgId)
  if (!message) throw new Error("That email is no longer in this project's log.")
  return {
    project_id: input.projectId,
    title: message.subject,
    generated_at: new Date().toISOString(),
    scope: [{ label: "Message", value: message.subject }],
    messages: [toExportMessage(message)],
    truncated_note: null,
  }
}
