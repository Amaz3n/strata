import sharp from "sharp"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { InvoicePdfData, InvoicePdfLine } from "@/lib/pdfs/invoice"

type AnySupabase = SupabaseClient<any, any, any>

export type InvoiceOrgBranding = {
  name?: string | null
  billing_email?: string | null
  address?: any
  logo_url?: string | null
}

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

        const neighbors = [current - 1, current + 1, current - width, current + width]
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

export async function normalizeLogoForPdf(logoUrl: string | null | undefined, supabase: AnySupabase) {
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
    const resizedBuffer = await sharp(logoBuffer).ensureAlpha().resize({ width: 700, height: 240, fit: "inside", withoutEnlargement: true }).png().toBuffer()

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

/**
 * Builds the canonical Arc invoice PDF payload from an invoice-with-lines plus org/project context.
 * Shared by the authed composer export (generateInvoicePdfAction) and the public token PDF route so
 * both produce a byte-for-byte identical document.
 */
export async function buildInvoicePdfData({
  supabase,
  invoice,
  org,
  orgSettings,
  projectName,
  token,
  appUrl,
}: {
  supabase: AnySupabase
  invoice: any
  org?: InvoiceOrgBranding | null
  orgSettings?: Record<string, any> | null
  projectName?: string | null
  token: string
  appUrl?: string
}): Promise<InvoicePdfData> {
  const metadata = (invoice.metadata ?? {}) as Record<string, any>
  const settings = orgSettings ?? {}

  const lines: InvoicePdfLine[] = (invoice.lines ?? []).map((line: any) => {
    const qty = Number(line.quantity ?? 0)
    const unitCost = Number(line.unit_cost_cents ?? line.unit_price_cents ?? 0)
    const safeQty = Number.isFinite(qty) ? qty : 0
    const safeUnit = Number.isFinite(unitCost) ? unitCost : 0
    return {
      description: line.description ?? "",
      quantity: safeQty,
      unit: line.unit ?? "ea",
      unitCostCents: safeUnit,
      lineTotalCents: Math.round(safeQty * safeUnit),
    }
  })

  const fromAddress =
    typeof metadata.from_address === "string" && metadata.from_address.trim().length > 0
      ? metadata.from_address
      : typeof org?.address === "string"
        ? org.address
        : (org?.address?.formatted ??
          [org?.address?.street1, org?.address?.street2, [org?.address?.city, org?.address?.state].filter(Boolean).join(", "), org?.address?.postal_code]
            .filter(Boolean)
            .join(" "))

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
      : (metadata.customer_address?.formatted ??
        [
          metadata.customer_address?.street1,
          metadata.customer_address?.street2,
          [metadata.customer_address?.city, metadata.customer_address?.state, metadata.customer_address?.postal_code].filter(Boolean).join(" "),
          metadata.customer_address?.country,
        ]
          .filter(Boolean)
          .join("\n"))

  const billToLines = [
    invoice.customer_name ?? metadata.customer_name ?? "Client",
    typeof metadata.customer_email === "string" ? metadata.customer_email : (invoice.sent_to_emails?.[0] ?? ""),
    customerAddress ?? "",
  ]
    .map((line) => String(line ?? "").trim())
    .filter((line) => line.length > 0)

  const normalizedLogo = await normalizeLogoForPdf((org?.logo_url as string | null) ?? null, supabase)
  const resolvedAppUrl = appUrl || process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://arcnaples.com"

  return {
    invoiceNumber: invoice.invoice_number,
    title: invoice.title ?? undefined,
    logoUrl: normalizedLogo,
    issueDate: invoice.issue_date ?? undefined,
    dueDate: invoice.due_date ?? undefined,
    fromLines,
    billToLines,
    projectName: projectName ?? undefined,
    notes:
      (typeof invoice.notes === "string" && invoice.notes.trim().length > 0
        ? invoice.notes
        : String(settings.invoice_default_payment_details ?? settings.invoice_default_note ?? "").trim()) || undefined,
    payUrl: `${resolvedAppUrl}/i/${token}`,
    subtotalCents: invoice.subtotal_cents ?? invoice.totals?.subtotal_cents ?? 0,
    taxCents: invoice.tax_cents ?? invoice.totals?.tax_cents ?? 0,
    totalCents: invoice.total_cents ?? invoice.totals?.total_cents ?? 0,
    taxRate: invoice.totals?.tax_rate ?? (metadata.tax_rate as number | undefined),
    lines,
  }
}
