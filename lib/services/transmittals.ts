import { formatDocNumber, type DocumentNumberingSettings } from "@/lib/document-number"
import { renderTransmittalPdf } from "@/lib/pdfs/transmittal-pdf"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { createFileShareLink } from "@/lib/services/file-share-links"
import { exportSheetPdf } from "@/lib/services/drawings-export"
import { persistGeneratedProjectPdf } from "@/lib/services/generated-project-pdfs"
import { escapeHtml, getOrgSenderEmail, renderStandardEmailLayout, sendEmail } from "@/lib/services/mailer"
import { insertWithProjectNumberRetry } from "@/lib/services/project-sequence"
import { requirePermission } from "@/lib/services/permissions"
import { createTransmittalSchema, type CreateTransmittalInput } from "@/lib/validation/transmittals"

export type Transmittal = {
  id: string
  org_id: string
  project_id: string
  transmittal_number: number
  display_number: string
  subject: string
  purpose: string
  notes: string | null
  sent_at: string | null
  sent_by: string | null
  pdf_file_id: string | null
  metadata: Record<string, unknown>
  created_at: string
  recipients: TransmittalRecipient[]
  items: TransmittalItem[]
}

export type TransmittalItem = { id: string; file_id: string | null; entity_type: string | null; entity_id: string | null; description: string; copies: number }
export type TransmittalRecipient = { id: string; contact_id: string | null; email: string; display_name: string; company_name: string | null; share_link_id: string | null; first_viewed_at: string | null; first_downloaded_at: string | null }

const TRANSMITTAL_SELECT = "id, org_id, project_id, transmittal_number, subject, purpose, notes, sent_at, sent_by, pdf_file_id, metadata, created_at"
const ITEM_SELECT = "id, file_id, entity_type, entity_id, description, copies"
const RECIPIENT_SELECT = "id, contact_id, email, display_name, company_name, share_link_id, first_viewed_at, first_downloaded_at"

async function numberingForOrg(supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"], orgId: string) {
  const { data } = await supabase.from("orgs").select("document_numbering").eq("id", orgId).single()
  return (data?.document_numbering ?? {}) as DocumentNumberingSettings
}

export async function listTransmittals(projectId: string, orgId?: string): Promise<Transmittal[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.read", { supabase, orgId: resolvedOrgId, userId })
  const [{ data, error }, numbering] = await Promise.all([
    supabase.from("transmittals").select(`${TRANSMITTAL_SELECT}, transmittal_items(${ITEM_SELECT}), transmittal_recipients(${RECIPIENT_SELECT})`).eq("org_id", resolvedOrgId).eq("project_id", projectId).order("transmittal_number", { ascending: false }).limit(250),
    numberingForOrg(supabase, resolvedOrgId),
  ])
  if (error) throw new Error(`Failed to load transmittals: ${error.message}`)
  const rows = data ?? []
  const fileIds = [...new Set(rows.flatMap((row) => [row.pdf_file_id, ...(row.transmittal_items ?? []).map((item) => item.file_id)]).filter((id): id is string => Boolean(id)))]
  const { data: events } = fileIds.length
    ? await supabase.from("file_access_events").select("file_id, action, metadata, created_at").eq("org_id", resolvedOrgId).in("file_id", fileIds).order("created_at", { ascending: true })
    : { data: [] }
  return rows.map((row) => {
    const recipients = (row.transmittal_recipients ?? []).map((recipient) => {
      const deliveryLinks = ((row.metadata as { delivery_links?: Record<string, { link_ids?: string[] }> } | null)?.delivery_links?.[recipient.id]?.link_ids ?? [])
      const trackedLinkIds = new Set([recipient.share_link_id, ...deliveryLinks].filter((id): id is string => Boolean(id)))
      const recipientEvents = (events ?? []).filter((event) => trackedLinkIds.has(String(event.metadata?.share_link_id ?? "")))
      return {
        ...recipient,
        first_viewed_at: recipient.first_viewed_at ?? recipientEvents.find((event) => event.action === "view")?.created_at ?? null,
        first_downloaded_at: recipient.first_downloaded_at ?? recipientEvents.find((event) => event.action === "download")?.created_at ?? null,
      }
    })
    return { ...row, items: row.transmittal_items ?? [], recipients, display_number: formatDocNumber("transmittal", row.transmittal_number, numbering) } as Transmittal
  })
}

async function resolveTransmittalEnclosures({
  supabase,
  orgId,
  projectId,
  transmittalId,
  items,
}: {
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"]
  orgId: string
  projectId: string
  transmittalId: string
  items: TransmittalItem[]
}): Promise<Array<{ itemId: string; fileId: string; description: string }>> {
  const enclosures: Array<{ itemId: string; fileId: string; description: string }> = []
  for (const item of items) {
    let fileId = item.file_id
    if (!fileId && item.entity_type === "drawing_sheet" && item.entity_id) {
      const exported = await exportSheetPdf({ sheetId: item.entity_id, includeMarkups: true }, orgId)
      const generated = await persistGeneratedProjectPdf({
        supabase,
        orgId,
        projectId,
        fileName: exported.fileName,
        pdf: Buffer.from(exported.bytes),
        category: "other",
        folderPath: "Transmittals/Enclosures",
        description: `Drawing enclosure: ${item.description}`,
      })
      fileId = generated.id
    } else if (!fileId && item.entity_type === "submittal" && item.entity_id) {
      const { data: submittal } = await supabase
        .from("submittals")
        .select("stamped_file_id, attachment_file_id")
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .eq("id", item.entity_id)
        .maybeSingle()
      fileId = submittal?.stamped_file_id ?? submittal?.attachment_file_id ?? null
    }
    if (!fileId) throw new Error(`Enclosure “${item.description}” has no deliverable file`)
    const { data: file } = await supabase.from("files").select("id").eq("org_id", orgId).eq("project_id", projectId).eq("id", fileId).maybeSingle()
    if (!file) throw new Error(`Enclosure “${item.description}” is not available in this project`)
    if (item.file_id !== fileId) {
      await supabase.from("transmittal_items").update({ file_id: fileId }).eq("org_id", orgId).eq("transmittal_id", transmittalId).eq("id", item.id)
    }
    enclosures.push({ itemId: item.id, fileId, description: item.description })
  }
  return enclosures
}

export async function createTransmittal(input: CreateTransmittalInput, orgId?: string): Promise<Transmittal> {
  const parsed = createTransmittalSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("transmittal.write", { supabase, orgId: resolvedOrgId, userId })
  const { data: transmittal } = await insertWithProjectNumberRetry<Record<string, unknown>>({
    supabase, table: "transmittals", numberColumn: "transmittal_number", rpcName: "next_transmittal_number",
    conflictConstraint: "transmittals_project_id_transmittal_number_key", projectId: parsed.project_id,
    payload: { org_id: resolvedOrgId, project_id: parsed.project_id, subject: parsed.subject, purpose: parsed.purpose, notes: parsed.notes ?? null },
    select: TRANSMITTAL_SELECT, entityLabel: "transmittal",
  })
  const transmittalId = String(transmittal.id)
  const [itemsResult, recipientsResult] = await Promise.all([
    supabase.from("transmittal_items").insert(parsed.items.map((item) => ({ org_id: resolvedOrgId, transmittal_id: transmittalId, ...item }))).select(ITEM_SELECT),
    supabase.from("transmittal_recipients").insert(parsed.recipients.map((recipient) => ({ org_id: resolvedOrgId, transmittal_id: transmittalId, ...recipient }))).select(RECIPIENT_SELECT),
  ])
  if (itemsResult.error || recipientsResult.error) throw new Error(`Failed to create transmittal details: ${itemsResult.error?.message ?? recipientsResult.error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "transmittal", entityId: transmittalId, after: transmittal })
  return { ...transmittal, items: itemsResult.data ?? [], recipients: recipientsResult.data ?? [], display_number: String(transmittal.transmittal_number) } as Transmittal
}

export async function sendTransmittal(transmittalId: string, orgId?: string): Promise<Transmittal> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("transmittal.write", { supabase, orgId: resolvedOrgId, userId })
  const { data: row, error } = await supabase.from("transmittals").select(`${TRANSMITTAL_SELECT}, transmittal_items(${ITEM_SELECT}), transmittal_recipients(${RECIPIENT_SELECT})`).eq("org_id", resolvedOrgId).eq("id", transmittalId).single()
  if (error || !row) throw new Error("Transmittal not found")
  if (row.sent_at) throw new Error("Transmittal has already been sent")
  const [{ data: project }, { data: org }, numbering] = await Promise.all([
    supabase.from("projects").select("name").eq("org_id", resolvedOrgId).eq("id", row.project_id).single(),
    supabase.from("orgs").select("name, slug, address, document_numbering").eq("id", resolvedOrgId).single(),
    numberingForOrg(supabase, resolvedOrgId),
  ])
  const displayNumber = formatDocNumber("transmittal", row.transmittal_number, numbering)
  const sentAt = new Date().toISOString()
  const pdf = await renderTransmittalPdf({
    header: { orgName: org?.name ?? "Arc", orgAddress: typeof org?.address === "string" ? org.address : null, projectName: project?.name ?? "Project", title: "Transmittal", documentNumber: displayNumber, date: new Date(sentAt).toLocaleDateString() },
    subject: row.subject, purpose: row.purpose, notes: row.notes, sentAt,
    recipients: (row.transmittal_recipients ?? []).map((recipient) => ({ name: recipient.display_name, company: recipient.company_name, email: recipient.email })),
    items: (row.transmittal_items ?? []).map((item) => ({ description: item.description, type: item.entity_type, copies: item.copies })),
  })
  const fileName = `transmittal-${displayNumber}.pdf`.replaceAll("/", "-")
  const file = await persistGeneratedProjectPdf({ supabase, orgId: resolvedOrgId, projectId: row.project_id, fileName, pdf, category: "other", folderPath: "Transmittals", description: `${displayNumber}: ${row.subject}` })
  const enclosures = await resolveTransmittalEnclosures({
    supabase,
    orgId: resolvedOrgId,
    projectId: row.project_id,
    transmittalId,
    items: (row.transmittal_items ?? []) as TransmittalItem[],
  })
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://arcnaples.com").replace(/\/$/, "")
  const deliveryLinks: Record<string, { link_ids: string[]; file_ids: string[] }> = {}
  for (const recipient of row.transmittal_recipients ?? []) {
    const coverLink = await createFileShareLink({ file_id: file.id, label: `${displayNumber} cover for ${recipient.display_name}`, allow_download: true }, resolvedOrgId)
    const enclosureLinks = await Promise.all(enclosures.map(async (enclosure) => ({
      ...enclosure,
      link: await createFileShareLink({ file_id: enclosure.fileId, label: `${displayNumber} — ${enclosure.description} for ${recipient.display_name}`, allow_download: true }, resolvedOrgId),
    })))
    await supabase.from("transmittal_recipients").update({ share_link_id: coverLink.id }).eq("org_id", resolvedOrgId).eq("id", recipient.id)
    deliveryLinks[recipient.id] = { link_ids: [coverLink.id, ...enclosureLinks.map((entry) => entry.link.id)], file_ids: [file.id, ...enclosureLinks.map((entry) => entry.fileId)] }
    const coverUrl = `${appUrl}/f/${coverLink.token}`
    const enclosureHtml = enclosureLinks.map((entry) => `<li style="margin: 6px 0;"><a href="${appUrl}/f/${entry.link.token}">${escapeHtml(entry.description)}</a></li>`).join("")
    const html = renderStandardEmailLayout({ title: `Transmittal ${displayNumber}`, messageHtml: `${escapeHtml(row.subject)}<br><br>Purpose: ${escapeHtml(row.purpose.replaceAll("_", " "))}<br><br><strong>Enclosures</strong><ul>${enclosureHtml}</ul>`, buttonText: "View cover sheet", buttonUrl: coverUrl, orgName: org?.name, showManageSettings: false })
    await sendEmail({ to: [recipient.email], subject: `Transmittal ${displayNumber}: ${row.subject}`, html, from: getOrgSenderEmail(org?.slug, org?.name) })
  }
  const metadata = { ...((row.metadata as Record<string, unknown> | null) ?? {}), delivery_links: deliveryLinks }
  const { error: updateError } = await supabase.from("transmittals").update({ sent_at: sentAt, sent_by: userId, pdf_file_id: file.id, metadata }).eq("org_id", resolvedOrgId).eq("id", transmittalId)
  if (updateError) throw new Error(`Failed to mark transmittal sent: ${updateError.message}`)
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "transmittal_sent", entityType: "transmittal", entityId: transmittalId, payload: { project_id: row.project_id, transmittal_number: row.transmittal_number } })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "transmittal", entityId: transmittalId, before: row, after: { ...row, sent_at: sentAt, sent_by: userId, pdf_file_id: file.id } })
  const list = await listTransmittals(row.project_id, resolvedOrgId)
  const sent = list.find((item) => item.id === transmittalId)
  if (!sent) throw new Error("Sent transmittal could not be reloaded")
  return sent
}
