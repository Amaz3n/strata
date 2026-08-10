import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { findDuplicatePayable } from "@/lib/services/payable-duplicate-check"
import { uploadFilesObject } from "@/lib/storage/files-storage"
import { attachFileWithServiceRole } from "@/lib/services/file-links"
import { recordEvent } from "@/lib/services/events"
import { NotificationService } from "@/lib/services/notifications"
import { extractPayableInvoiceFromFile } from "@/lib/services/document-extraction"
import { suggestCodingForService } from "@/lib/services/books/coding-rules"
import { computeCommitmentOverBudget } from "@/lib/services/vendor-bills"
import { emailIngestBillCoreSchema } from "@/lib/validation/vendor-bills"

/**
 * Inbound bill ingest: subs email their invoice to the org's bills address.
 * Receiving uses Resend's managed catch-all domain (`<id>.resend.app` — no
 * DNS, no extra domain slot, doesn't touch the real mailboxes on the root
 * domain), so the canonical address is `<org-slug>@$PAYABLES_INBOUND_DOMAIN`.
 * Optionally, pretty aliases like `ap-<slug>@arcnaples.com` can be created as
 * forwarding rules in the existing mail host; forwarding preserves the
 * original To: header, so those resolve too. The Resend webhook
 * enqueues an outbox job per received email; this service drains it:
 * fetch the email + attachment from Resend, extract the invoice, match the
 * sender to an Arc vendor and its commitment, and create a pending payable
 * in the right project — or fall back to an org notification when it can't
 * route confidently. Money never moves here: everything lands as a pending
 * bill in the normal approval queue.
 */

const RESEND_API_BASE = "https://api.resend.com"

/** Resend managed receiving domain (`<id>.resend.app`). Unset = ingest off. */
export const PAYABLES_INBOUND_DOMAIN = process.env.PAYABLES_INBOUND_DOMAIN ?? null
/** Domain hosting the optional pretty forwarding aliases (`ap-<slug>@…`). */
const PAYABLES_INBOUND_ALIAS_DOMAIN = process.env.PAYABLES_INBOUND_ALIAS_DOMAIN ?? "arcnaples.com"
const PAYABLES_INBOUND_ALIAS_PREFIX = process.env.PAYABLES_INBOUND_ALIAS_PREFIX ?? "ap-"

/** The address that is guaranteed deliverable (the Resend catch-all), or null when ingest is not configured. */
export function orgBillsInboundAddress(slug: string): string | null {
  return PAYABLES_INBOUND_DOMAIN ? `${slug}@${PAYABLES_INBOUND_DOMAIN}` : null
}

/**
 * Pull the org slug out of the recipient list. Two shapes resolve:
 *   1. `<slug>@<PAYABLES_INBOUND_DOMAIN>` — the Resend managed catch-all.
 *   2. `ap-<slug>@<alias domain>` — a forwarding alias in the org's real mail
 *      host; forwarding preserves the original To: header, so it shows up in
 *      the recipient list alongside the catch-all address.
 * Anything else is ignored.
 */
export function resolveInboundOrgSlug(recipients: Array<string | null | undefined>): string | null {
  const catchAllSuffix = PAYABLES_INBOUND_DOMAIN ? `@${PAYABLES_INBOUND_DOMAIN.toLowerCase()}` : null
  const aliasSuffix = `@${PAYABLES_INBOUND_ALIAS_DOMAIN.toLowerCase()}`
  const aliasPrefix = PAYABLES_INBOUND_ALIAS_PREFIX.toLowerCase()

  for (const recipient of recipients) {
    if (!recipient) continue
    // Recipients can arrive as `Name <addr>` — take the bare address.
    const address = (recipient.match(/<([^>]+)>/)?.[1] ?? recipient).trim().toLowerCase()

    if (catchAllSuffix && address.endsWith(catchAllSuffix)) {
      const slug = address.slice(0, -catchAllSuffix.length)
      if (slug) return slug
    }

    if (address.endsWith(aliasSuffix)) {
      const localPart = address.slice(0, -aliasSuffix.length)
      if (localPart.startsWith(aliasPrefix)) {
        const slug = localPart.slice(aliasPrefix.length)
        if (slug) return slug
      }
    }
  }
  return null
}

export async function findOrgIdByInboundRecipients(recipients: Array<string | null | undefined>): Promise<{ orgId: string; slug: string } | null> {
  const slug = resolveInboundOrgSlug(recipients)
  if (!slug) return null
  const supabase = createServiceSupabaseClient()
  const { data } = await supabase.from("orgs").select("id, slug").eq("slug", slug).maybeSingle()
  return data ? { orgId: data.id as string, slug } : null
}

interface ResendReceivedEmail {
  id: string
  from: string
  to: string[] | string
  received_for?: string[]
  subject?: string | null
  text?: string | null
}

interface ResendAttachment {
  id: string
  filename: string
  content_type?: string | null
  size?: number | null
  download_url: string
}

async function resendGet<T>(path: string): Promise<T> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured")
  const response = await fetch(`${RESEND_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!response.ok) {
    throw new Error(`Resend API ${path} failed: ${response.status} ${await response.text().catch(() => "")}`)
  }
  return (await response.json()) as T
}

function isInvoiceAttachment(attachment: ResendAttachment) {
  const type = (attachment.content_type ?? "").toLowerCase()
  const name = attachment.filename.toLowerCase()
  return type === "application/pdf" || type.startsWith("image/") || /\.(pdf|jpe?g|png|webp|heic|heif)$/.test(name)
}

function bareAddress(value: string) {
  return (value.match(/<([^>]+)>/)?.[1] ?? value).trim().toLowerCase()
}

function normalizeName(value?: string | null) {
  return value?.trim().replace(/\s+/g, " ").toLowerCase() ?? ""
}

function emailDomain(address: string) {
  const at = address.lastIndexOf("@")
  return at === -1 ? "" : address.slice(at + 1).toLowerCase()
}

function editDistance(a: string, b: string) {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]
    previous[0] = i
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = previous[j]
      previous[j] = next
    }
  }
  return previous[b.length]
}

/**
 * Deterministic look-alike detection for a sender domain against a vendor's
 * known domain: identical after stripping punctuation ("acme-inc.com" vs
 * "acmeinc.com"), or within two character edits of a reasonably long domain
 * ("acrne.com" vs "acme.com"). No AI, no fuzzy scoring — a flag for a human.
 */
function isLookalikeDomain(candidate: string, known: string) {
  if (!candidate || !known || candidate === known) return false
  const a = candidate.replace(/[^a-z0-9]/g, "")
  const b = known.replace(/[^a-z0-9]/g, "")
  if (a === b) return true
  if (Math.min(a.length, b.length) < 6) return false
  return editDistance(a, b) <= 2
}

async function notifyOrgMembers(args: { orgId: string; title: string; message: string; projectId?: string | null; entityType?: string; entityId?: string }) {
  const supabase = createServiceSupabaseClient()
  const { data: members } = await supabase.from("memberships").select("user_id").eq("org_id", args.orgId).eq("status", "active")
  const notificationService = new NotificationService()
  const seen = new Set<string>()
  for (const member of members ?? []) {
    const userId = member.user_id as string
    if (!userId || seen.has(userId)) continue
    seen.add(userId)
    // In-app only: "payable_email_ingest" is not an email-eligible type.
    await notificationService
      .createAndQueue({
        orgId: args.orgId,
        userId,
        type: "payable_email_ingest",
        title: args.title,
        message: args.message,
        projectId: args.projectId ?? undefined,
        entityType: args.entityType,
        entityId: args.entityId,
      })
      .catch((error) => console.error("payables-email-ingest: notification failed", error))
  }
}

export interface InboundBillResult {
  status: "created" | "unrouted" | "duplicate" | "no_attachment" | "ignored" | "not_a_bill"
  /** Set when status is "not_a_bill", so the caller can say what arrived instead. */
  documentType?: string
  billId?: string
  projectId?: string
}

export async function processInboundBillEmail(args: { orgId: string; emailId: string; preferredProjectId?: string }): Promise<InboundBillResult> {
  const { orgId, emailId } = args
  const supabase = createServiceSupabaseClient()

  const email = await resendGet<ResendReceivedEmail>(`/emails/receiving/${encodeURIComponent(emailId)}`)
  const fromAddress = bareAddress(email.from ?? "")
  const subject = email.subject?.trim() || null

  // ── Attachment ─────────────────────────────────────────────────────────
  const attachmentList = await resendGet<{ data: ResendAttachment[] }>(`/emails/receiving/${encodeURIComponent(emailId)}/attachments`)
  const attachment = (attachmentList.data ?? []).find(isInvoiceAttachment)

  if (!attachment) {
    await notifyOrgMembers({
      orgId,
      title: "Emailed bill had no invoice attached",
      message: `${fromAddress || "A vendor"} emailed ${subject ? `“${subject}”` : "your bills address"} without a PDF or image attachment, so no payable was created.`,
    })
    return { status: "no_attachment" }
  }

  const download = await fetch(attachment.download_url)
  if (!download.ok) throw new Error(`Failed to download inbound attachment: ${download.status}`)
  const bytes = Buffer.from(await download.arrayBuffer())
  const contentType = attachment.content_type || "application/pdf"
  const invoiceFile = new File([bytes], attachment.filename || "invoice.pdf", {
    type: contentType,
  })

  // ── Understand the invoice ─────────────────────────────────────────────
  const extraction = await extractPayableInvoiceFromFile(invoiceFile, {
    orgId,
  }).catch((error) => {
    console.error("payables-email-ingest: extraction failed", error)
    return null
  })

  // ── Refuse documents that are not bills ────────────────────────────────
  // A vendor statement lists invoices that were each sent separately, and a
  // lien waiver is a signed release. Turning either into a payable creates a
  // duplicate liability that only shows up at reconciliation, so the router's
  // verdict stops the pipeline here rather than downstream.
  if (extraction && !extraction.billable) {
    console.warn("payables-email-ingest: non-billable document", {
      emailId,
      documentType: extraction.documentType,
    })
    return { status: "not_a_bill", documentType: extraction.documentType }
  }

  // ── Match sender → Arc vendor ──────────────────────────────────────────
  // The scan may already have matched the vendor against the org's list, which
  // beats the exact-string name comparison the fallback below relies on.
  let companyId: string | null = extraction?.vendorId ?? null
  let companyName: string | null = null
  let matchedViaSenderContact = false

  if (fromAddress) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("company_id, company:companies(id, name)")
      .eq("org_id", orgId)
      .eq("email", fromAddress)
      .not("company_id", "is", null)
      .limit(1)
      .maybeSingle()
    const contactCompany = Array.isArray(contact?.company) ? contact?.company[0] : contact?.company
    if (contactCompany?.id) {
      companyId = contactCompany.id as string
      companyName = (contactCompany.name as string) ?? null
      matchedViaSenderContact = true
    }
  }

  if (!companyId && extraction?.vendorName) {
    const { data: companies } = await supabase.from("companies").select("id, name").eq("org_id", orgId).in("company_type", ["subcontractor", "supplier", "other"])
    const wanted = normalizeName(extraction.vendorName)
    const match = (companies ?? []).find((company) => normalizeName(company.name) === wanted)
    if (match) {
      companyId = match.id as string
      companyName = match.name as string
    }
  }

  // ── Screen the sender against the vendor's known contacts ─────────────
  // Deterministic string comparison only. A bill "from" a known vendor whose
  // sender address is not one of that vendor's contacts — or whose domain
  // merely looks like a known one — is exactly the shape of invoice fraud, so
  // it gets flagged for a human. The flag never blocks intake, but it does
  // block auto-approval (see evaluateAndAutoApproveVendorBill).
  let senderUnverified = false
  let senderLookalikeOf: string | null = null
  if (companyId && fromAddress && !matchedViaSenderContact) {
    const [{ data: vendorContacts }, { data: vendorCompany }] = await Promise.all([
      supabase.from("contacts").select("email").eq("org_id", orgId).eq("company_id", companyId),
      supabase.from("companies").select("email").eq("org_id", orgId).eq("id", companyId).maybeSingle(),
    ])
    const knownEmails = new Set(
      [...(vendorContacts ?? []).map((row) => row.email as string | null), (vendorCompany?.email as string | null) ?? null]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim().toLowerCase()),
    )
    if (!knownEmails.has(fromAddress)) {
      const senderDomain = emailDomain(fromAddress)
      const knownDomains = new Set(Array.from(knownEmails).map(emailDomain).filter(Boolean))
      // A new person at a vendor's known domain is routine; anything else is not.
      if (!senderDomain || !knownDomains.has(senderDomain)) {
        senderUnverified = true
        for (const domain of knownDomains) {
          if (isLookalikeDomain(senderDomain, domain)) {
            senderLookalikeOf = domain
            break
          }
        }
      }
    }
  }

  // ── Duplicate guard ────────────────────────────────────────────────────
  // One matcher for every path. This used to be two blocks here — a
  // case-SENSITIVE check when the vendor matched and a looser name-based one
  // when it did not — neither of which agreed with the interactive create path.
  const duplicate = await findDuplicatePayable({
    supabase,
    orgId,
    billNumber: extraction?.billNumber ?? null,
    companyId,
    totalCents: extraction?.totalDollars != null ? Math.round(extraction.totalDollars * 100) : null,
    billDate: extraction?.billDate ?? null,
    vendorAliases: companyId ? undefined : { vendorName: extraction?.vendorName ?? null },
  })
  if (duplicate) {
    const { data: existing } = await supabase
      .from("vendor_bills")
      .select("project_id")
      .eq("org_id", orgId)
      .eq("id", duplicate.billId)
      .maybeSingle()
    await notifyOrgMembers({
      orgId,
      title: "Emailed bill skipped as a duplicate",
      message: `${companyName ?? fromAddress} emailed a bill that already exists in Arc. ${duplicate.reason}`,
      projectId: (existing?.project_id as string | null) ?? null,
      entityType: "vendor_bill",
      entityId: duplicate.billId,
    })
    return { status: "duplicate", billId: duplicate.billId }
  }

  // ── Route to a project via the vendor's commitments ────────────────────
  let projectId: string | null = args.preferredProjectId ?? null
  let commitmentId: string | null = null
  let routingNote: string | null = null

  if (companyId) {
    const { data: commitments } = await supabase
      .from("commitments")
      .select("id, project_id, title, status, total_cents")
      .eq("org_id", orgId)
      .eq("company_id", companyId)
      .eq("status", "approved")
    const open = args.preferredProjectId ? (commitments ?? []).filter((row) => row.project_id === args.preferredProjectId) : (commitments ?? [])
    if (open.length === 1) {
      commitmentId = open[0].id as string
      projectId = open[0].project_id as string
    } else if (open.length > 1) {
      const projectIds = Array.from(new Set(open.map((row) => row.project_id as string)))
      if (projectIds.length === 1) {
        // One project, several commitments: land the bill on the project and
        // let a human pick the commitment during review.
        projectId = projectIds[0]
        routingNote = "Vendor has multiple commitments on this project — assign the source commitment."
      } else {
        routingNote = "Vendor has commitments on multiple projects."
      }
    } else {
      routingNote = "Vendor has no approved commitment."
    }
  } else {
    routingNote = "Sender did not match an Arc vendor."
  }

  // ── Store the invoice document ─────────────────────────────────────────
  const timestamp = Date.now()
  const safeName = (attachment.filename || "invoice.pdf").replace(/[^a-zA-Z0-9.-]/g, "_")
  const storagePath = `${orgId}/${projectId ?? "org"}/payables/email-ingest/${timestamp}_${safeName}`
  await uploadFilesObject({
    supabase,
    orgId,
    path: storagePath,
    bytes,
    contentType,
    upsert: false,
  })
  const { data: fileRow, error: fileError } = await supabase
    .from("files")
    .insert({
      org_id: orgId,
      project_id: projectId,
      file_name: attachment.filename || "invoice.pdf",
      storage_path: storagePath,
      mime_type: contentType,
      size_bytes: bytes.byteLength,
      visibility: "private",
      category: "financials",
      folder_path: "/financials",
      metadata: {
        source: "payables_email_ingest",
        resend_email_id: emailId,
        from_email: fromAddress,
        subject,
      },
    })
    .select("id")
    .single()
  if (fileError || !fileRow) throw new Error(`Failed to store inbound invoice: ${fileError?.message}`)
  const fileId = fileRow.id as string

  // ── Unrouted: keep the document, tell the team ─────────────────────────
  if (!projectId) {
    await notifyOrgMembers({
      orgId,
      title: "Emailed bill needs a project",
      message: `${companyName ?? fromAddress ?? "A vendor"} emailed ${
        extraction?.billNumber ? `bill #${extraction.billNumber}` : subject ? `“${subject}”` : "an invoice"
      }. ${routingNote ?? ""} The document is saved in org Documents (financials) — add the payable from the project's Payables tab.`.trim(),
      entityType: "file",
      entityId: fileId,
    })
    return { status: "unrouted" }
  }

  // ── Create the pending payable ─────────────────────────────────────────
  const totalCents = Math.round((extraction?.totalDollars ?? 0) * 100)

  // The same rules a manually created payable passes: a real invoice number,
  // a positive amount, a valid date. Extraction that cannot produce them still
  // creates the record — losing the document helps nobody — but always as a
  // draft flagged for a human, which the desk keeps out of the approval queue
  // and the auto-approval evaluator refuses outright.
  const coreValidation = emailIngestBillCoreSchema.safeParse({
    bill_number: extraction?.billNumber ?? "",
    total_cents: totalCents,
    bill_date: extraction?.billDate ?? new Date().toISOString().slice(0, 10),
  })
  const extractionIncomplete = !coreValidation.success

  const overBudget = commitmentId && totalCents > 0
    ? await computeCommitmentOverBudget(supabase, { orgId, commitmentId, totalCents })
    : false

  const { data: company } = companyId ? await supabase.from("companies").select("qbo_vendor_id, qbo_vendor_name, name").eq("id", companyId).maybeSingle() : { data: null }
  const codingSuggestion = await suggestCodingForService({
    orgId,
    companyId,
    vendorName: companyName ?? extraction?.vendorName,
    memo: extraction?.description ?? subject,
  })

  const { data: bill, error: billError } = await supabase
    .from("vendor_bills")
    .insert({
      org_id: orgId,
      project_id: projectId,
      commitment_id: commitmentId,
      company_id: companyId,
      bill_number: extraction?.billNumber ?? null,
      total_cents: totalCents,
      currency: "usd",
      status: "pending",
      bill_date: extraction?.billDate ?? new Date().toISOString().slice(0, 10),
      due_date: extraction?.dueDate ?? null,
      file_id: fileId,
      qbo_vendor_id: company?.qbo_vendor_id ?? null,
      qbo_vendor_name: company?.qbo_vendor_name ?? company?.name ?? null,
      metadata: {
        source: "email_ingest",
        resend_email_id: emailId,
        from_email: fromAddress,
        subject,
        description: extraction?.description ?? subject,
        extraction_confidence: extraction?.confidence ?? null,
        routing_note: routingNote,
        over_budget: overBudget,
        creation_state: extractionIncomplete ? "draft" : "ready",
        ...(extractionIncomplete ? { needs_review_reason: "extraction_incomplete" } : {}),
        ...(senderUnverified ? { sender_unverified: true } : {}),
        ...(senderLookalikeOf ? { sender_domain_lookalike_of: senderLookalikeOf } : {}),
        vendor_name: companyName ?? extraction?.vendorName ?? null,
        coding_source: codingSuggestion?.autoApply ? "rule" : null,
        coding_rule_id: codingSuggestion?.ruleId ?? null,
        coding_confidence: codingSuggestion?.confidence ?? null,
      },
      accounting_coding: codingSuggestion?.autoApply ? codingSuggestion.accountingCoding : {},
    })
    .select("id")
    .single()
  if (billError || !bill) throw new Error(`Failed to create emailed payable: ${billError?.message}`)
  const billId = bill.id as string

  // No auto-coding for an incomplete extraction: a zero-amount line would only
  // masquerade as real coding on a draft a human still has to complete.
  if (!extractionIncomplete && codingSuggestion?.autoApply && codingSuggestion.costCodeId) {
    // Preserve the invoice's own line structure when the scan reconciled. The
    // learned coding applies to every line, because it was learned from this
    // vendor rather than from any one line; a human re-codes individual lines
    // during review. A scan whose lines did not reconcile falls back to the
    // single lump line rather than persisting a split we already distrust.
    const useScannedLines = Boolean(extraction && extraction.lines.length > 1 && !extraction.sumMismatch)
    const rows = useScannedLines
      ? extraction!.lines.map((line, index) => ({
          org_id: orgId,
          bill_id: billId,
          project_id: projectId,
          cost_code_id: codingSuggestion.costCodeId,
          budget_line_id: codingSuggestion.budgetLineId,
          description: line.description || "Emailed vendor bill",
          quantity: line.quantity ?? 1,
          unit: line.unit ?? "LS",
          unit_cost_cents:
            line.quantity && line.quantity !== 0
              ? Math.round(line.amountCents / line.quantity)
              : line.amountCents,
          sort_order: index,
          metadata: {
            source: "email_ingest",
            coding_rule_id: codingSuggestion.ruleId,
            extracted_amount_cents: line.amountCents,
          },
        }))
      : [{
          org_id: orgId,
          bill_id: billId,
          project_id: projectId,
          cost_code_id: codingSuggestion.costCodeId,
          budget_line_id: codingSuggestion.budgetLineId,
          description: extraction?.description ?? subject ?? "Emailed vendor bill",
          quantity: 1,
          unit: "LS",
          unit_cost_cents: totalCents,
          sort_order: 0,
          metadata: {
            source: "email_ingest",
            coding_rule_id: codingSuggestion.ruleId,
          },
        }]

    const { error: codingError } = await supabase.from("bill_lines").insert(rows)
    if (codingError) throw new Error(`Failed to apply learned coding: ${codingError.message}`)
  }

  await supabase.from("files").update({ project_id: projectId }).eq("org_id", orgId).eq("id", fileId)
  await attachFileWithServiceRole({
    orgId,
    fileId,
    projectId,
    entityType: "vendor_bill",
    entityId: billId,
    linkRole: "invoice",
    createdBy: null,
  }).catch((error) => console.error("payables-email-ingest: attach failed", error))

  await recordEvent({
    orgId,
    eventType: "vendor_bill_submitted",
    entityType: "vendor_bill",
    entityId: billId,
    payload: {
      project_id: projectId,
      company_id: companyId,
      bill_number: extraction?.billNumber ?? null,
      total_cents: totalCents,
      source: "email_ingest",
      from_email: fromAddress,
      creation_state: extractionIncomplete ? "draft" : "ready",
      sender_unverified: senderUnverified,
    },
  })

  // Flagged intake gets a direct human notification on top of the submitted
  // event, naming exactly what to verify before anyone approves it.
  if (extractionIncomplete || senderUnverified) {
    const concerns: string[] = []
    if (senderUnverified) {
      concerns.push(
        senderLookalikeOf
          ? `The sender ${fromAddress} is not a known contact for ${companyName ?? "this vendor"}, and its domain looks like ${senderLookalikeOf} without matching it — verify it is really them.`
          : `The sender ${fromAddress} is not a known contact for ${companyName ?? "this vendor"} — verify it is really them.`,
      )
    }
    if (extractionIncomplete) {
      concerns.push("The invoice amount or number could not be read, so it was saved as a draft to complete by hand.")
    }
    await notifyOrgMembers({
      orgId,
      title: extractionIncomplete ? "Emailed bill needs review before approval" : "Emailed bill from an unverified sender",
      message: `${companyName ?? extraction?.vendorName ?? fromAddress ?? "A vendor"} emailed ${
        extraction?.billNumber ? `bill #${extraction.billNumber}` : subject ? `“${subject}”` : "an invoice"
      }. ${concerns.join(" ")}`,
      projectId,
      entityType: "vendor_bill",
      entityId: billId,
    })
  }

  return { status: "created", billId, projectId }
}
