"use server"

import { revalidatePath } from "next/cache"
import sharp from "sharp"

import {
  createInvoice,
  ensureInvoiceToken,
  getInvoiceWithLines,
  listInvoiceViews,
  listInvoices,
  updateInvoice,
} from "@/lib/services/invoices"
import { forceSyncInvoiceToQBO, retryFailedQBOSyncJobs, syncInvoiceToQBO } from "@/lib/services/qbo-sync"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { invoiceInputSchema } from "@/lib/validation/invoices"
import { sendReminderEmail } from "@/lib/services/mailer"
import { listChangeOrders } from "@/lib/services/change-orders"
import { renderInvoicePdf } from "@/lib/pdfs/invoice"
import { uploadFilesObject } from "@/lib/storage/files-storage"
import { createFileRecord } from "@/lib/services/files"
import { createInitialVersion } from "@/lib/services/file-versions"
import { attachFile } from "@/lib/services/file-links"
import { QBOClient } from "@/lib/integrations/accounting/qbo-api"
import { recordEvent } from "@/lib/services/events"

const INVOICE_PDF_TEMPLATE_VERSION = 2

function resolveOrgLogoPath(logoUrl?: string | null) {
  if (!logoUrl) return null

  try {
    const parsed = new URL(logoUrl)
    const marker = "/storage/v1/object/public/org-logos/"
    const markerIndex = parsed.pathname.indexOf(marker)
    if (markerIndex === -1) return null
    return decodeURIComponent(parsed.pathname.slice(markerIndex + marker.length))
  } catch {
    return null
  }
}

const normalizedLogoCache = new Map<string, string>()

function rememberNormalizedLogo(sourceUrl: string, normalized: string) {
  normalizedLogoCache.set(sourceUrl, normalized)
  if (normalizedLogoCache.size <= 30) return
  const oldest = normalizedLogoCache.keys().next().value
  if (oldest) normalizedLogoCache.delete(oldest)
}

function largestOpaqueComponentBounds(raw: Buffer, width: number, height: number, channels: number) {
  const visited = new Uint8Array(width * height)
  let best: { area: number; minX: number; minY: number; maxX: number; maxY: number } | null = null
  const alphaOffset = channels - 1

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = y * width + x
      if (visited[idx]) continue
      visited[idx] = 1
      const pixelIndex = idx * channels + alphaOffset
      if ((raw[pixelIndex] ?? 0) <= 1) continue

      let area = 0
      let minX = x
      let maxX = x
      let minY = y
      let maxY = y

      const queue = [idx]
      let queueHead = 0
      while (queueHead < queue.length) {
        const current = queue[queueHead++]
        const cx = current % width
        const cy = Math.floor(current / width)
        area += 1

        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy

        const neighbors = [
          current - 1,
          current + 1,
          current - width,
          current + width,
        ]
        for (const neighbor of neighbors) {
          if (neighbor < 0 || neighbor >= width * height) continue
          const nx = neighbor % width
          const ny = Math.floor(neighbor / width)
          if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue
          if (visited[neighbor]) continue
          visited[neighbor] = 1
          const neighborAlpha = raw[neighbor * channels + alphaOffset] ?? 0
          if (neighborAlpha <= 1) continue
          queue.push(neighbor)
        }
      }

      if (!best || area > best.area) {
        best = { area, minX, minY, maxX, maxY }
      }
    }
  }

  return best
}

async function normalizeLogoForPdf(logoUrl: string | null | undefined, supabase: ReturnType<typeof createServiceSupabaseClient>) {
  if (!logoUrl) return undefined
  const cached = normalizedLogoCache.get(logoUrl)
  if (cached) return cached

  const logoPath = resolveOrgLogoPath(logoUrl)
  if (!logoPath) {
    rememberNormalizedLogo(logoUrl, logoUrl)
    return logoUrl
  }

  try {
    const { data: logoBlob, error } = await supabase.storage.from("org-logos").download(logoPath)
    if (error || !logoBlob) {
      rememberNormalizedLogo(logoUrl, logoUrl)
      return logoUrl
    }

    const logoBuffer = Buffer.from(await logoBlob.arrayBuffer())
    const resizedBuffer = await sharp(logoBuffer)
      .ensureAlpha()
      .resize({ width: 700, height: 240, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer()

    const { data: rawData, info } = await sharp(resizedBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const bounds = largestOpaqueComponentBounds(rawData, info.width, info.height, info.channels)

    if (!bounds || bounds.area < 24) {
      const fallback = `data:image/png;base64,${resizedBuffer.toString("base64")}`
      rememberNormalizedLogo(logoUrl, fallback)
      return fallback
    }

    const horizontalPadding = 20
    const left = Math.max(0, bounds.minX - horizontalPadding)
    const width = Math.min(info.width - left, bounds.maxX - bounds.minX + 1 + horizontalPadding * 2)

    // Keep full height to avoid trimming top/bottom logo edges from anti-aliased pixels.
    const cropped = await sharp(resizedBuffer).extract({ left, top: 0, width, height: info.height }).png().toBuffer()
    const normalized = `data:image/png;base64,${cropped.toString("base64")}`
    rememberNormalizedLogo(logoUrl, normalized)
    return normalized
  } catch {
    rememberNormalizedLogo(logoUrl, logoUrl)
    return logoUrl
  }
}

export async function listInvoicesAction(projectId?: string) {
  return listInvoices({ projectId })
}

export async function createInvoiceAction(input: unknown) {
  const startedAt = Date.now()
  const parsed = invoiceInputSchema.parse(input)
  const invoice = await createInvoice({ input: parsed })
  const durationMs = Date.now() - startedAt
  if (durationMs >= 1500) {
    console.warn("[invoice.create] Slow create detected", { durationMs, invoiceId: invoice.id })
    try {
      await recordEvent({
        eventType: "invoice_create_slow",
        entityType: "invoice",
        entityId: invoice.id,
        channel: "integration",
        payload: { duration_ms: durationMs },
      })
    } catch {
      // Non-blocking telemetry.
    }
  }
  revalidatePath("/invoices")
  return invoice
}

export async function createQBOIncomeAccountAction(name: string) {
  const normalized = String(name ?? "").trim()
  if (normalized.length < 2) {
    throw new Error("Account name must be at least 2 characters")
  }
  if (normalized.length > 100) {
    throw new Error("Account name must be 100 characters or fewer")
  }

  const { orgId } = await requireOrgContext()
  const client = await QBOClient.forOrg(orgId)
  if (!client) {
    throw new Error("No active QuickBooks connection")
  }

  return client.createIncomeAccount(normalized)
}

export async function updateInvoiceAction(invoiceId: string, input: unknown) {
  if (!invoiceId) throw new Error("Invoice id is required")
  const startedAt = Date.now()
  const parsed = invoiceInputSchema.parse(input)
  const invoice = await updateInvoice({ invoiceId, input: parsed })
  const durationMs = Date.now() - startedAt
  if (durationMs >= 1500) {
    console.warn("[invoice.update] Slow update detected", { durationMs, invoiceId })
    try {
      await recordEvent({
        eventType: "invoice_update_slow",
        entityType: "invoice",
        entityId: invoiceId,
        channel: "integration",
        payload: { duration_ms: durationMs },
      })
    } catch {
      // Non-blocking telemetry.
    }
  }
  revalidatePath("/invoices")
  return invoice
}

export async function generateInvoiceLinkAction(invoiceId: string) {
  if (!invoiceId) {
    throw new Error("Invoice id is required")
  }

  const token = await ensureInvoiceToken(invoiceId)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://arcnaples.com"

  return {
    token,
    url: `${appUrl}/i/${token}`,
  }
}

export async function getInvoiceDetailAction(invoiceId: string) {
  if (!invoiceId) throw new Error("Invoice id is required")

  const invoice = await getInvoiceWithLines(invoiceId)
  if (!invoice) throw new Error("Invoice not found")

  const token = await ensureInvoiceToken(invoiceId, invoice.org_id)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://arcnaples.com"
  const views = await listInvoiceViews(invoiceId, invoice.org_id)
  const supabase = createServiceSupabaseClient()
  const { data: syncHistory } = await supabase
    .from("qbo_sync_records")
    .select("id, status, last_synced_at, error_message, qbo_id")
    .eq("org_id", invoice.org_id)
    .eq("entity_type", "invoice")
    .eq("entity_id", invoiceId)
    .order("last_synced_at", { ascending: false })

  return {
    invoice: { ...invoice, token },
    link: `${appUrl}/i/${token}`,
    views,
    syncHistory: syncHistory ?? [],
  }
}

export async function manualResyncInvoiceAction(invoiceId: string) {
  if (!invoiceId) throw new Error("Invoice id is required")
  const { orgId } = await requireOrgContext()
  const result = await forceSyncInvoiceToQBO(invoiceId, orgId)
  if (!result.success) {
    throw new Error(result.error ?? "Unable to sync invoice")
  }
  revalidatePath("/invoices")
  return { success: true }
}

export async function retryFailedInvoiceSyncsAction() {
  const { orgId } = await requireOrgContext()
  const result = await retryFailedQBOSyncJobs(orgId)
  revalidatePath("/invoices")
  return result
}

export async function syncPendingInvoicesNowAction(limit = 15) {
  const { orgId } = await requireOrgContext()
  const supabase = createServiceSupabaseClient()

  const { data: pending } = await supabase
    .from("invoices")
    .select("id")
    .eq("org_id", orgId)
    .eq("qbo_sync_status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit)

  if (!pending?.length) {
    revalidatePath("/invoices")
    return { success: true, processed: 0 }
  }

  let processed = 0
  for (const row of pending) {
    const result = await syncInvoiceToQBO(row.id, orgId)
    if (result.success) processed++
  }

  revalidatePath("/invoices")
  return { success: true, processed }
}

export async function sendInvoiceReminderAction(invoiceId: string) {
  if (!invoiceId) throw new Error("Invoice id is required")

  const { orgId, supabase } = await requireOrgContext()
  const invoice = await getInvoiceWithLines(invoiceId, orgId)

  if (!invoice) throw new Error("Invoice not found")
  if (invoice.status === "paid" || invoice.status === "void") {
    throw new Error("Cannot send reminder for paid or void invoices")
  }

  // Get recipient email from sent_to_emails or metadata
  const recipientEmail = invoice.sent_to_emails?.[0] ?? (invoice.metadata as any)?.customer_email
  if (!recipientEmail) {
    throw new Error("No recipient email found for this invoice")
  }

  const token = await ensureInvoiceToken(invoiceId, orgId)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://arcnaples.com"
  const payLink = `${appUrl}/i/${token}`

  // Calculate days overdue if applicable
  const dueDate = invoice.due_date ? new Date(invoice.due_date) : null
  const now = new Date()
  let daysOverdue: number | undefined
  if (dueDate && now > dueDate) {
    daysOverdue = Math.floor((now.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
  }

  const { data: org } = await supabase.from("orgs").select("name, logo_url").eq("id", orgId).maybeSingle()

  await sendReminderEmail({
    to: recipientEmail,
    recipientName: (invoice.metadata as any)?.customer_name ?? null,
    invoiceNumber: invoice.invoice_number,
    amountDue: invoice.balance_due_cents ?? invoice.total_cents ?? 0,
    dueDate: invoice.due_date ?? new Date().toISOString(),
    daysOverdue,
    payLink,
    orgName: org?.name ?? null,
    orgLogoUrl: org?.logo_url ?? null,
  })

  return { success: true }
}

export async function getInvoiceComposerContextAction(projectId?: string | null) {
  const { supabase, orgId } = await requireOrgContext()

  let drawRows: Array<{
    id: string
    project_id: string
    draw_number: number
    title: string
    description: string | null
    amount_cents: number
    due_date: string | null
    status: string
  }> = []

  if (projectId) {
    const { data, error: drawError } = await supabase
      .from("draw_schedules")
      .select("id, project_id, draw_number, title, description, amount_cents, due_date, status")
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .in("status", ["pending", "partial"])
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("draw_number", { ascending: true })

    if (drawError) {
      console.warn("Failed to load draw schedule context", drawError)
    } else {
      drawRows = (data ?? []) as typeof drawRows
    }
  }

  const changeOrders = projectId
    ? await listChangeOrders({ orgId, projectId })
        .then((rows) =>
          rows.filter((co) => {
            const status = String(co.status ?? "").toLowerCase()
            return status === "approved" || status === "pending"
          }),
        )
        .catch(() => [])
    : []

  const { data: orgSettingsRow } = await supabase
    .from("org_settings")
    .select("settings")
    .eq("org_id", orgId)
    .maybeSingle()
  const settings = (orgSettingsRow?.settings as Record<string, any> | null) ?? {}

  const { data: qboConnection } = await supabase
    .from("qbo_connections")
    .select("status, settings, last_error, refresh_failure_count")
    .eq("org_id", orgId)
    .eq("status", "active")
    .maybeSingle()

  let qboConnected = Boolean(qboConnection)
  const qboDefaultIncomeAccountId =
    typeof (qboConnection?.settings as any)?.default_income_account_id === "string"
      ? (qboConnection?.settings as any).default_income_account_id
      : null

  let qboIncomeAccounts: Array<{ id: string; name: string; fullyQualifiedName?: string }> = []
  let qboAccountLoadWarning: string | null = null
  if (qboConnected) {
    try {
      const qboClient = await QBOClient.forOrg(orgId)
      if (!qboClient) {
        qboConnected = false
      } else {
        qboIncomeAccounts = await qboClient.listIncomeAccounts()
        if (qboIncomeAccounts.length === 0 && qboDefaultIncomeAccountId) {
          const fallbackAccount = await qboClient.getIncomeAccountById(qboDefaultIncomeAccountId).catch(() => null)
          if (fallbackAccount) {
            qboIncomeAccounts = [fallbackAccount]
          }
        }
        if (qboIncomeAccounts.length === 0) {
          qboAccountLoadWarning = "QuickBooks returned no income accounts. Check your chart of accounts and default income account."
        }
      }
    } catch (error) {
      console.warn("Unable to load QBO income accounts for invoice composer", error)
      qboAccountLoadWarning = error instanceof Error ? error.message : "Unable to load QuickBooks income accounts."
    }
  }

  return {
    draws: drawRows.map((draw) => ({
      id: draw.id as string,
      project_id: draw.project_id as string,
      draw_number: Number(draw.draw_number ?? 0),
      title: String(draw.title ?? ""),
      description: draw.description ? String(draw.description) : null,
      amount_cents: Number(draw.amount_cents ?? 0),
      due_date: draw.due_date ? String(draw.due_date) : null,
      status: String(draw.status ?? "pending"),
    })),
    changeOrders,
    qboConnected,
    qboIncomeAccounts,
    qboDefaultIncomeAccountId,
    qboDiagnostics: {
      connectionLastError: (qboConnection as any)?.last_error ?? null,
      refreshFailureCount: Number((qboConnection as any)?.refresh_failure_count ?? 0),
      accountLoadWarning: qboAccountLoadWarning,
    },
    settings: {
      defaultPaymentTermsDays: Number(settings.invoice_default_payment_terms_days ?? 15),
      defaultInvoiceNote: String(settings.invoice_default_payment_details ?? settings.invoice_default_note ?? ""),
    },
  }
}

export async function generateInvoicePdfAction(
  invoiceId: string,
  options?: {
    persistToArc?: boolean
  },
) {
  if (!invoiceId) throw new Error("Invoice id is required")
  const startedAt = Date.now()

  const { supabase, orgId } = await requireOrgContext()
  const persistToArc = options?.persistToArc === true

  const invoice = await getInvoiceWithLines(invoiceId, orgId)
  if (!invoice) {
    throw new Error("Invoice not found")
  }

  const metadata = (invoice.metadata ?? {}) as Record<string, any>
  const cachedPdfFileId = typeof metadata.latest_pdf_file_id === "string" ? metadata.latest_pdf_file_id : null
  const cachedPdfForUpdatedAt =
    typeof metadata.latest_pdf_invoice_updated_at === "string" ? metadata.latest_pdf_invoice_updated_at : null
  const cachedPdfTemplateVersion =
    typeof metadata.latest_pdf_template_version === "number"
      ? metadata.latest_pdf_template_version
      : Number(metadata.latest_pdf_template_version ?? 0)
  const invoiceUpdatedAt = typeof invoice.updated_at === "string" ? invoice.updated_at : null

  if (
    persistToArc &&
    cachedPdfFileId &&
    cachedPdfForUpdatedAt &&
    invoiceUpdatedAt &&
    cachedPdfForUpdatedAt === invoiceUpdatedAt &&
    cachedPdfTemplateVersion === INVOICE_PDF_TEMPLATE_VERSION
  ) {
    return {
      fileId: cachedPdfFileId,
      fileName: `invoice-${String(invoice.invoice_number).replace(/[^a-zA-Z0-9._-]/g, "_")}.pdf`,
      downloadUrl: `/api/files/${cachedPdfFileId}/raw`,
      pdfBase64: null,
      durationMs: Date.now() - startedAt,
      persistedToArc: true,
      fromCache: true,
    }
  }

  const [projectResult, orgResult, orgSettingsResult, token] = await Promise.all([
    invoice.project_id
      ? supabase
          .from("projects")
          .select("name")
          .eq("org_id", orgId)
          .eq("id", invoice.project_id)
          .maybeSingle()
      : Promise.resolve({ data: null as any }),
    supabase
      .from("orgs")
      .select("name, billing_email, address, logo_url")
      .eq("id", orgId)
      .maybeSingle(),
    supabase
      .from("org_settings")
      .select("settings")
      .eq("org_id", orgId)
      .maybeSingle(),
    ensureInvoiceToken(invoice.id, orgId),
  ])

  const project = projectResult.data
  const org = orgResult.data
  const orgSettings = (orgSettingsResult.data?.settings as Record<string, any> | null) ?? {}
  const lines = (invoice.lines ?? []).map((line) => {
    const qty = Number(line.quantity ?? 0)
    const unitCost = Number(line.unit_cost_cents ?? 0)
    return {
      description: line.description,
      quantity: Number.isFinite(qty) ? qty : 0,
      unit: line.unit ?? "ea",
      unitCostCents: Number.isFinite(unitCost) ? unitCost : 0,
      lineTotalCents: Math.round((Number.isFinite(qty) ? qty : 0) * (Number.isFinite(unitCost) ? unitCost : 0)),
    }
  })

  const fromAddress =
    typeof metadata.from_address === "string" && metadata.from_address.trim().length > 0
      ? metadata.from_address
      : typeof org?.address === "string"
        ? org.address
        : org?.address?.formatted ??
          [org?.address?.street1, org?.address?.street2, [org?.address?.city, org?.address?.state].filter(Boolean).join(", "), org?.address?.postal_code]
            .filter(Boolean)
            .join(" ")

  const fromLines = [
    (metadata.from_name as string | undefined) ?? org?.name ?? "Arc Builder",
    (metadata.from_email as string | undefined) ?? org?.billing_email ?? "",
    fromAddress,
  ]
    .map((line) => (typeof line === "string" ? line.trim() : ""))
    .filter((line) => line.length > 0)

  const customerAddress =
    typeof metadata.customer_address === "string"
      ? metadata.customer_address
      : metadata.customer_address?.formatted ??
        [
          metadata.customer_address?.street1,
          metadata.customer_address?.street2,
          [metadata.customer_address?.city, metadata.customer_address?.state, metadata.customer_address?.postal_code]
            .filter(Boolean)
            .join(" "),
          metadata.customer_address?.country,
        ]
          .filter(Boolean)
          .join("\n")

  const billToLines = [
    invoice.customer_name ?? metadata.customer_name ?? "Client",
    typeof metadata.customer_email === "string" ? metadata.customer_email : invoice.sent_to_emails?.[0] ?? "",
    customerAddress ?? "",
  ]
    .map((line) => String(line ?? "").trim())
    .filter((line) => line.length > 0)

  const normalizedLogo = await normalizeLogoForPdf((org?.logo_url as string | null) ?? null, supabase)
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://arcnaples.com"

  const pdfBuffer = await renderInvoicePdf({
    invoiceNumber: invoice.invoice_number,
    title: invoice.title ?? undefined,
    logoUrl: normalizedLogo,
    issueDate: invoice.issue_date ?? undefined,
    dueDate: invoice.due_date ?? undefined,
    fromLines,
    billToLines,
    projectName: project?.name ?? undefined,
    notes:
      (typeof invoice.notes === "string" && invoice.notes.trim().length > 0
        ? invoice.notes
        : String(orgSettings.invoice_default_payment_details ?? orgSettings.invoice_default_note ?? "").trim()) || undefined,
    payUrl: `${appUrl}/i/${token}`,
    subtotalCents: invoice.subtotal_cents ?? invoice.totals?.subtotal_cents ?? 0,
    taxCents: invoice.tax_cents ?? invoice.totals?.tax_cents ?? 0,
    totalCents: invoice.total_cents ?? invoice.totals?.total_cents ?? 0,
    taxRate: invoice.totals?.tax_rate ?? (metadata.tax_rate as number | undefined),
    lines,
  })
  const pdfBase64 = pdfBuffer.toString("base64")

  if (!persistToArc) {
    const durationMs = Date.now() - startedAt
    if (durationMs >= 5000) {
      console.warn("[invoice.pdf] Slow PDF render detected", { durationMs, invoiceId })
      try {
        await recordEvent({
          eventType: "invoice_pdf_render_slow",
          entityType: "invoice",
          entityId: invoice.id,
          channel: "integration",
          payload: {
            duration_ms: durationMs,
            persisted_to_arc: false,
          },
        })
      } catch {
        // Non-blocking telemetry.
      }
    }
    return {
      fileId: null,
      fileName: `invoice-${String(invoice.invoice_number).replace(/[^a-zA-Z0-9._-]/g, "_")}.pdf`,
      downloadUrl: null,
      pdfBase64,
      durationMs,
      persistedToArc: false,
      fromCache: false,
    }
  }

  const safeInvoiceNumber = String(invoice.invoice_number).replace(/[^a-zA-Z0-9._-]/g, "_")
  const fileName = `invoice-${safeInvoiceNumber}.pdf`
  const timestamp = Date.now()
  const storagePath = invoice.project_id
    ? `${orgId}/${invoice.project_id}/invoices/${timestamp}_${fileName}`
    : `${orgId}/general/invoices/${timestamp}_${fileName}`

  await uploadFilesObject({
    supabase,
    orgId,
    path: storagePath,
    bytes: pdfBuffer,
    contentType: "application/pdf",
    upsert: false,
  })

  const fileRecord = await createFileRecord({
    project_id: invoice.project_id ?? undefined,
    file_name: fileName,
    storage_path: storagePath,
    mime_type: "application/pdf",
    size_bytes: pdfBuffer.length,
    visibility: "private",
    category: "financials",
    folder_path: "Financials/Invoices",
    description: `Invoice PDF for ${invoice.invoice_number}`,
    source: "generated",
    share_with_clients: true,
    share_with_subs: false,
  })

  await createInitialVersion({
    fileId: fileRecord.id,
    storagePath,
    fileName,
    mimeType: "application/pdf",
    sizeBytes: pdfBuffer.length,
  })

  await attachFile({
    file_id: fileRecord.id,
    entity_type: "invoice",
    entity_id: invoice.id,
    project_id: invoice.project_id ?? undefined,
    link_role: "invoice_pdf",
  })

  await supabase
    .from("invoices")
    .update({
      metadata: {
        ...metadata,
        latest_pdf_file_id: fileRecord.id,
        latest_pdf_invoice_updated_at: invoice.updated_at ?? null,
        latest_pdf_generated_at: new Date().toISOString(),
        latest_pdf_template_version: INVOICE_PDF_TEMPLATE_VERSION,
      },
    })
    .eq("org_id", orgId)
    .eq("id", invoice.id)

  revalidatePath("/invoices")
  if (invoice.project_id) {
    revalidatePath(`/projects/${invoice.project_id}/financials`)
  }

  const durationMs = Date.now() - startedAt
  if (durationMs >= 5000) {
    console.warn("[invoice.pdf] Slow PDF generation + persist detected", { durationMs, invoiceId })
    try {
      await recordEvent({
        orgId,
        eventType: "invoice_pdf_slow",
        entityType: "invoice",
        entityId: invoice.id,
        channel: "integration",
        payload: {
          duration_ms: durationMs,
          persisted_to_arc: true,
        },
      })
    } catch {
      // Non-blocking telemetry.
    }
  }

  return {
    fileId: fileRecord.id,
    fileName,
    downloadUrl: `/api/files/${fileRecord.id}/raw`,
    pdfBase64: null,
    durationMs,
    persistedToArc: true,
    fromCache: false,
  }
}
