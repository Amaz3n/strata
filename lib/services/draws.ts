import { requireOrgContext } from "@/lib/services/context"
import { createInvoice } from "@/lib/services/invoices"
import { createFileRecord } from "@/lib/services/files"
import { createInitialVersion } from "@/lib/services/file-versions"
import { attachFile } from "@/lib/services/file-links"
import { renderDrawSummaryPdf } from "@/lib/pdfs/draw-summary"
import { uploadFilesObject } from "@/lib/storage/files-storage"
import { requireAuthorization } from "@/lib/services/authorization"

export async function listDueDraws(projectId?: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "draw.read",
    userId,
    orgId: resolvedOrgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: projectId ? "project" : "org",
    resourceId: projectId ?? resolvedOrgId,
  })

  const today = new Date().toISOString().split("T")[0]

  let query = supabase
    .from("draw_schedules")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("status", "pending")
    .lte("due_date", today)
    .order("due_date", { ascending: true })

  if (projectId) {
    query = query.eq("project_id", projectId)
  }

  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to load due draws: ${error.message}`)
  }

  return data ?? []
}

export async function invoiceDrawSchedule({
  drawId,
  invoice_number,
  reservation_id,
  issue_date,
  due_date,
  orgId,
  create_draw_summary,
}: {
  drawId: string
  invoice_number: string
  reservation_id?: string
  issue_date?: string
  due_date?: string
  orgId?: string
  create_draw_summary?: boolean
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: draw, error: drawError } = await supabase
    .from("draw_schedules")
    .select("*")
    .eq("id", drawId)
    .eq("org_id", resolvedOrgId)
    .single()

  if (drawError || !draw) {
    throw new Error("Draw not found")
  }

  let drawContractId: string | null = draw.contract_id ?? null
  let contract: any = null

  if (drawContractId) {
    const { data: linkedContract, error: linkedContractError } = await supabase
      .from("contracts")
      .select("id, status, signed_at, total_cents")
      .eq("org_id", resolvedOrgId)
      .eq("id", drawContractId)
      .maybeSingle()

    if (linkedContractError) {
      throw new Error(`Failed to load draw contract: ${linkedContractError.message}`)
    }
    contract = linkedContract
  } else {
    const { data: activeContract, error: activeContractError } = await supabase
      .from("contracts")
      .select("id, status, signed_at, total_cents")
      .eq("org_id", resolvedOrgId)
      .eq("project_id", draw.project_id)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (activeContractError) {
      throw new Error(`Failed to load project contract: ${activeContractError.message}`)
    }

    contract = activeContract
    drawContractId = activeContract?.id ?? null
  }

  if (!contract?.id || contract.status !== "active" || !contract.signed_at) {
    throw new Error("A signed active contract is required before invoicing a draw.")
  }

  if (!draw.contract_id && drawContractId) {
    const { error: bindError } = await supabase
      .from("draw_schedules")
      .update({ contract_id: drawContractId })
      .eq("org_id", resolvedOrgId)
      .eq("id", draw.id)

    if (bindError) {
      throw new Error(`Failed to bind draw to contract: ${bindError.message}`)
    }
  }

  await requireAuthorization({
    permission: "draw.approve",
    userId,
    orgId: resolvedOrgId,
    projectId: draw.project_id,
    supabase,
    logDecision: true,
    resourceType: "draw_schedule",
    resourceId: drawId,
  })

  if (draw.invoice_id) {
    throw new Error("Draw already invoiced")
  }

  const drawAmountCents =
    typeof draw.percent_of_contract === "number"
      ? Math.round(((contract.total_cents ?? 0) * Number(draw.percent_of_contract)) / 100)
      : (draw.amount_cents ?? 0)

  if (!Number.isFinite(drawAmountCents) || drawAmountCents <= 0) {
    throw new Error("Draw amount must be greater than $0 before invoicing.")
  }

  const invoice = await createInvoice({
    input: {
      project_id: draw.project_id,
      invoice_number,
      reservation_id,
      title: `Draw ${draw.draw_number}: ${draw.title}`,
      status: "sent",
      issue_date,
      due_date: due_date ?? draw.due_date ?? undefined,
      notes: draw.description ?? undefined,
      client_visible: true,
      tax_rate: 0,
      lines: [
        {
          description: draw.title,
          quantity: 1,
          unit: "draw",
          unit_cost: drawAmountCents / 100,
          taxable: false,
        },
      ],
    },
    orgId: resolvedOrgId,
  })

  const { error: updateError } = await supabase
    .from("draw_schedules")
    .update({
      invoice_id: invoice.id,
      status: "invoiced",
      invoiced_at: new Date().toISOString(),
    })
    .eq("id", drawId)
    .eq("org_id", resolvedOrgId)

  if (updateError) {
    throw new Error(`Failed to mark draw invoiced: ${updateError.message}`)
  }

  let drawSummaryFileId: string | undefined

  if (create_draw_summary) {
    try {
      drawSummaryFileId = await generateAndAttachDrawSummary({
        supabase,
        orgId: resolvedOrgId,
        projectId: draw.project_id,
        draw,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoice_number,
        issueDate: issue_date ?? new Date().toISOString().split("T")[0],
      })
    } catch (err) {
      console.warn("Failed to generate draw summary PDF", err)
    }
  }

  return {
    draw: { ...draw, status: "invoiced", invoice_id: invoice.id, contract_id: drawContractId, amount_cents: drawAmountCents },
    invoice,
    draw_summary_file_id: drawSummaryFileId,
  }
}

export async function markDrawPaid(drawId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: draw, error: drawError } = await supabase
    .from("draw_schedules")
    .select("id, project_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", drawId)
    .maybeSingle()

  if (drawError || !draw) {
    throw new Error("Draw not found")
  }

  await requireAuthorization({
    permission: "payment.release",
    userId,
    orgId: resolvedOrgId,
    projectId: draw.project_id,
    supabase,
    logDecision: true,
    resourceType: "draw_schedule",
    resourceId: drawId,
  })

  const { error } = await supabase
    .from("draw_schedules")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
    })
    .eq("id", drawId)
    .eq("org_id", resolvedOrgId)

  if (error) {
    throw new Error(`Failed to mark draw paid: ${error.message}`)
  }

  return { success: true }
}

async function generateAndAttachDrawSummary({
  supabase,
  orgId,
  projectId,
  draw,
  invoiceId,
  invoiceNumber,
  issueDate,
}: {
  supabase: any
  orgId: string
  projectId: string
  draw: any
  invoiceId: string
  invoiceNumber: string
  issueDate: string
}): Promise<string> {
  const [orgResult, projectResult, contractResult, approvedCosResult, paymentsResult] = await Promise.all([
    supabase.from("orgs").select("name").eq("id", orgId).maybeSingle(),
    supabase.from("projects").select("name, total_value").eq("id", projectId).maybeSingle(),
    supabase
      .from("contracts")
      .select("total_cents")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "active")
      .maybeSingle(),
    supabase
      .from("change_orders")
      .select("total_cents")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .eq("status", "approved")
      .eq("client_visible", true),
    supabase
      .from("payments")
      .select("amount_cents")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .not("invoice_id", "is", null)
      .eq("status", "succeeded"),
  ])

  const baseContractTotal =
    contractResult.data?.total_cents ??
    (projectResult.data?.total_value ? Math.round(projectResult.data.total_value * 100) : 0)
  const approvedChangesTotal = (approvedCosResult.data ?? []).reduce((sum: number, row: any) => sum + (row.total_cents ?? 0), 0)
  const revisedContractCents = baseContractTotal + approvedChangesTotal
  const paidToDateCents = (paymentsResult.data ?? []).reduce((sum: number, row: any) => sum + (row.amount_cents ?? 0), 0)
  const drawAmountCents =
    typeof draw.percent_of_contract === "number" && revisedContractCents > 0
      ? Math.round((revisedContractCents * draw.percent_of_contract) / 100)
      : (draw.amount_cents ?? 0)
  const remainingAfterThisDrawCents = revisedContractCents - paidToDateCents - drawAmountCents

  const pdfBuffer = await renderDrawSummaryPdf({
    orgName: orgResult.data?.name ?? undefined,
    projectName: projectResult.data?.name ?? undefined,
    invoiceNumber,
    drawNumber: draw.draw_number,
    drawTitle: draw.title,
    drawAmountCents,
    contractTotalCents: baseContractTotal,
    approvedChangeOrdersCents: approvedChangesTotal,
    revisedContractCents,
    paidToDateCents,
    remainingAfterThisDrawCents,
    issuedAtIso: issueDate,
  })

  const timestamp = Date.now()
  const safeInvoice = String(invoiceNumber).replace(/[^a-zA-Z0-9-_.]/g, "_")
  const fileName = `draw-${draw.draw_number}-summary-invoice-${safeInvoice}.pdf`
  const storagePath = `${orgId}/${projectId}/draw-summaries/${timestamp}_${fileName}`

  await uploadFilesObject({
    supabase,
    orgId,
    path: storagePath,
    bytes: pdfBuffer,
    contentType: "application/pdf",
    upsert: false,
  })

  const record = await createFileRecord(
    {
      project_id: projectId,
      file_name: fileName,
      storage_path: storagePath,
      mime_type: "application/pdf",
      size_bytes: pdfBuffer.length,
      visibility: "private",
      category: "financials",
      folder_path: "Financials/Draw Summaries",
      description: `Draw ${draw.draw_number} summary for Invoice #${invoiceNumber}`,
      source: "generated",
      share_with_clients: true,
      share_with_subs: false,
    },
    orgId,
  )

  await createInitialVersion(
    {
      fileId: record.id,
      storagePath,
      fileName,
      mimeType: "application/pdf",
      sizeBytes: pdfBuffer.length,
    },
    orgId,
  )

  await attachFile(
    {
      file_id: record.id,
      entity_type: "invoice",
      entity_id: invoiceId,
      project_id: projectId,
      link_role: "draw_summary",
    },
    orgId,
  )

  return record.id
}



