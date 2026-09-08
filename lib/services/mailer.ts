import { render } from "@react-email/components"
import type { ReactElement } from "react"
import { BidInviteEmail } from "@/lib/emails/bid-invite-email"
import { BidAddendumEmail } from "@/lib/emails/bid-addendum-email"
import { BidDateUpdateEmail } from "@/lib/emails/bid-date-update-email"
import { InvoiceReminderEmail } from "@/lib/emails/invoice-reminder-email"
import { ProjectPortalInviteEmail } from "@/lib/emails/project-portal-invite-email"
import { InviteTeamMemberEmail } from "@/lib/emails/invite-team-member-email"
import { PasswordResetEmail } from "@/lib/emails/password-reset-email"
import { ExternalPasswordResetEmail } from "@/lib/emails/external-password-reset-email"
import { ExternalVerifyEmail } from "@/lib/emails/external-verify-email"
import { PrequalificationRequestEmail } from "@/lib/emails/prequalification-request-email"
import { PrequalificationDecisionEmail } from "@/lib/emails/prequalification-decision-email"
import { ARC_SITE_URL, palette } from "@/lib/emails/theme"

const RESEND_API_KEY = process.env.RESEND_API_KEY
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev"

export interface EmailPayload {
  to: (string | null | undefined)[]
  subject: string
  html: string
  text?: string
  replyTo?: string | null
  from?: string
  /** Stable provider key used to suppress duplicate transactional sends. */
  idempotencyKey?: string
  attachments?: Array<{
    filename: string
    content: string
    contentType?: string
  }>
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

function getSendingDomain(): string {
  const emailMatch = RESEND_FROM_EMAIL.match(/<(.+)>|(\S+@\S+)/)
  const email = emailMatch ? (emailMatch[1] || emailMatch[2]) : RESEND_FROM_EMAIL
  const parts = email.split("@")
  return parts[1] || "app.arcnaples.com"
}

export function getOrgSenderEmail(orgSlug?: string | null, orgName?: string | null): string {
  if (!orgSlug) return RESEND_FROM_EMAIL
  
  const domain = getSendingDomain()
  // Resend's free tier sandbox ONLY allows sending from onboarding@resend.dev
  if (domain === "resend.dev") {
    return RESEND_FROM_EMAIL
  }
  
  const cleanSlug = orgSlug.toLowerCase().trim().replace(/[^a-z0-9-]/g, "")
  const friendlyName = orgName ? orgName.replace(/"/g, '\\"') : "Arc"
  
  return `"${friendlyName}" <${cleanSlug}@${domain}>`
}

export function renderStandardEmailLayout(args: {
  title: string
  messageHtml: string
  buttonText?: string
  buttonUrl?: string
  orgName?: string | null
  orgLogoUrl?: string | null
  appUrl?: string
  showManageSettings?: boolean
}): string {
  const orgName = args.orgName || "Arc"
  const appUrl = (args.appUrl || process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com").replace(/\/$/, "")
  const showManageSettings = args.showManageSettings !== false
  
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(args.title)}</title>
  </head>
  <body style="background-color: #ececea; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 32px 0;">
    <table align="center" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 620px; background-color: #ffffff; border: 1px solid #dcdcdc; border-collapse: collapse; margin: 0 auto;">
      <!-- Header -->
      <tr>
        <td style="text-align: center; padding: 36px 40px 22px 40px; border-bottom: 1px solid #ebebeb;">
          ${args.orgLogoUrl ? `
            <img src="${args.orgLogoUrl}" alt="${escapeHtml(orgName)}" width="56" height="56" style="border: 1px solid #d6d6d6; background-color: #ffffff; display: block; margin: 0 auto; padding: 6px; width: 56px; height: 56px; object-fit: contain;" />
          ` : `
            <div style="margin: 0 auto 12px auto; width: 56px; height: 56px; line-height: 56px; text-align: center; border: 1px solid #d6d6d6; background-color: #ffffff; color: #111111; font-weight: 700; font-size: 18px;">
              ${escapeHtml(orgName.slice(0, 1).toUpperCase())}
            </div>
          `}
          <div style="margin: 12px 0 0 0; color: #111111; font-size: 15px; font-weight: 700;">${escapeHtml(orgName)}</div>
          <div style="margin: 4px 0 0 0; color: #6b6b6b; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;">Notification</div>
        </td>
      </tr>
      
      <!-- Content -->
      <tr>
        <td style="padding: 30px 40px 32px 40px;">
          <div style="margin: 0 0 10px 0; color: #666666; font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 1px;">Update</div>
          <h1 style="margin: 0 0 16px 0; color: #111111; font-size: 28px; line-height: 1.2; font-weight: 700; letter-spacing: -0.5px;">${escapeHtml(args.title)}</h1>
          
          <div style="margin: 0 0 24px 0; color: #2f2f2f; font-size: 14px; line-height: 1.6;">
            ${args.messageHtml}
          </div>
          
          ${args.buttonUrl ? `
            <table align="center" border="0" cellpadding="0" cellspacing="0" style="margin: 26px auto 16px auto;">
              <tr>
                <td align="center" style="background-color: ${palette.brand};">
                  <a href="${args.buttonUrl}" style="background-color: ${palette.brand}; color: #ffffff; border: 1px solid ${palette.brand}; text-decoration: none; font-size: 14px; font-weight: 700; padding: 12px 24px; display: inline-block;">
                    ${escapeHtml(args.buttonText || 'Open in Arc')}
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin: 16px 0 0 0; color: #666666; font-size: 12px; line-height: 1.65; text-align: center;">
              If the button does not open, <a href="${args.buttonUrl}" style="color: ${palette.brand}; text-decoration: underline;">open secure link</a>
            </p>
          ` : ''}
        </td>
      </tr>
      
      <!-- Footer -->
      <tr>
        <td style="padding: 18px 40px 22px 40px; background-color: #ffffff; border-top: 1px solid #ebebeb; text-align: center;">
          <div style="margin: 0 0 8px 0; color: #777777; font-size: 12px; line-height: 1.5;">Sent via <a href="${ARC_SITE_URL}" style="color: #777777; font-weight: 600; text-decoration: underline;">Arc</a></div>
          ${showManageSettings ? `
            <div style="margin: 0; color: #999999; font-size: 11px; line-height: 1.5;">
              <a href="${appUrl}/settings" style="color: #777777; text-decoration: underline;">Manage Notification Settings</a>
            </div>
          ` : ""}
        </td>
      </tr>
    </table>
  </body>
</html>`
}

/**
 * Render a React Email component to HTML string
 */
export async function renderEmailTemplate(template: ReactElement): Promise<string> {
  return await render(template)
}

/**
 * Send a transactional email via Resend.
 * - No-ops if API key missing or no recipients.
 * - Deduplicates recipients and filters falsy values.
 */
export async function sendEmail(payload: EmailPayload): Promise<boolean> {
  if (!RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set; skipping email send")
    return false
  }

  const recipients = Array.from(new Set(payload.to.filter(Boolean))) as string[]
  if (recipients.length === 0) {
    console.warn("No email recipients provided; skipping email send")
    return false
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        ...(payload.idempotencyKey
          ? { "Idempotency-Key": payload.idempotencyKey }
          : {}),
      },
      body: JSON.stringify({
        from: payload.from ?? RESEND_FROM_EMAIL,
        to: recipients,
        subject: payload.subject,
        html: payload.html,
        text: payload.text ?? stripHtml(payload.html),
        reply_to: payload.replyTo ?? undefined,
        attachments: payload.attachments,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error("Resend API error", response.status, errorText)
      return false
    }
    return true
  } catch (error) {
    console.error("Failed to send email via Resend", error)
    return false
  }
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
}

export interface ReminderEmailPayload {
  to: string
  recipientName: string | null
  invoiceNumber: string
  amountDue: number // in cents
  dueDate: string
  daysOverdue?: number
  payLink: string
  orgName?: string | null
  orgLogoUrl?: string | null
  orgSlug?: string | null
}

/**
 * Send a reminder email for an overdue invoice
 */
export async function sendReminderEmail(payload: ReminderEmailPayload): Promise<string | undefined> {
  const amount = `$${(payload.amountDue / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
  const dueDate = new Date(payload.dueDate).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })

  const subject = payload.daysOverdue
    ? `Payment Reminder: Invoice #${payload.invoiceNumber} is ${payload.daysOverdue} days overdue`
    : `Payment Reminder: Invoice #${payload.invoiceNumber} due ${dueDate}`

  const html = await renderEmailTemplate(
    InvoiceReminderEmail({
      recipientName: payload.recipientName,
      invoiceNumber: payload.invoiceNumber,
      amount,
      dueDate,
      daysOverdue: payload.daysOverdue,
      payLink: payload.payLink,
      orgName: payload.orgName,
      orgLogoUrl: payload.orgLogoUrl,
    })
  )

  const emailPayload: EmailPayload = {
    to: [payload.to],
    subject,
    html,
    from: getOrgSenderEmail(payload.orgSlug, payload.orgName),
  }

  await sendEmail(emailPayload)

  // For now, return a mock message ID since Resend doesn't return one in the response
  // In a real implementation, you'd parse the response from Resend to get the actual message ID
  return `reminder-${payload.invoiceNumber}-${Date.now()}`
}

export interface InviteEmailPayload {
  to: string
  inviteLink: string
  orgName?: string | null
  orgLogoUrl?: string | null
  inviterName?: string | null
  inviterEmail?: string | null
  orgSlug?: string | null
}

export async function sendInviteEmail(payload: InviteEmailPayload): Promise<void> {
  const html = await renderEmailTemplate(
    InviteTeamMemberEmail({
      orgName: payload.orgName,
      orgLogoUrl: payload.orgLogoUrl,
      inviterName: payload.inviterName,
      inviterEmail: payload.inviterEmail,
      inviteeEmail: payload.to,
      inviteLink: payload.inviteLink,
    }),
  )

  await sendEmail({
    to: [payload.to],
    subject: `You have been invited to join ${payload.orgName ?? "Arc"}`,
    html,
    from: getOrgSenderEmail(payload.orgSlug, payload.orgName),
  })
}

export interface PasswordResetEmailPayload {
  to: string
  resetLink: string
  orgName?: string | null
  orgLogoUrl?: string | null
  orgSlug?: string | null
}

export async function sendPasswordResetEmail(payload: PasswordResetEmailPayload): Promise<void> {
  const html = await renderEmailTemplate(
    PasswordResetEmail({
      orgName: payload.orgName,
      orgLogoUrl: payload.orgLogoUrl,
      recipientEmail: payload.to,
      resetLink: payload.resetLink,
    }),
  )

  await sendEmail({
    to: [payload.to],
    subject: `Reset your ${payload.orgName ?? "Arc"} password`,
    html,
    from: getOrgSenderEmail(payload.orgSlug, payload.orgName),
  })
}

export interface ExternalPasswordResetEmailPayload {
  to: string
  resetLink: string
}

/** Arc-branded, not builder-branded — an external identity spans every builder. */
export async function sendExternalPasswordResetEmail(
  payload: ExternalPasswordResetEmailPayload,
): Promise<void> {
  const html = await renderEmailTemplate(
    ExternalPasswordResetEmail({
      recipientEmail: payload.to,
      resetLink: payload.resetLink,
    }),
  )

  await sendEmail({
    to: [payload.to],
    subject: "Reset your Arc password",
    html,
  })
}

export interface ExternalVerifyEmailPayload {
  to: string
  verifyLink: string
  orgName?: string | null
}

export async function sendExternalVerifyEmail(payload: ExternalVerifyEmailPayload): Promise<void> {
  const html = await renderEmailTemplate(
    ExternalVerifyEmail({
      recipientEmail: payload.to,
      orgName: payload.orgName,
      verifyLink: payload.verifyLink,
    }),
  )

  await sendEmail({
    to: [payload.to],
    subject: "Confirm your Arc email",
    html,
  })
}

export interface ReminderSMSPayload {
  to: string
  message: string
}

/**
 * Send a reminder SMS for an overdue invoice
 * Note: This currently logs a warning since SMS functionality is not implemented
 */
export async function sendReminderSMS(payload: ReminderSMSPayload): Promise<string | undefined> {
  console.warn("SMS reminders not yet implemented", payload)

  // For now, return undefined to indicate SMS sending failed
  // In a real implementation, you'd integrate with an SMS service like Twilio
  return undefined
}

export interface ComplianceAutopilotEmailItem {
  documentName: string
  reminderKind: "missing" | "expiring" | "expired" | "rejected" | "deficient"
  expiryDate?: string | null
  /** The builder's words on why it came back. Only set for a rejection. */
  rejectionReason?: string | null
  /**
   * Why a document that IS on file still does not satisfy the requirement —
   * coverage below the minimum, a missing endorsement. Only set for
   * `deficient`, and the whole point of that kind: "send us your certificate"
   * is useless advice to a vendor who already did.
   */
  deficiency?: string | null
}

export interface ComplianceAutopilotEmailPayload {
  to: string
  recipientName?: string | null
  companyName: string
  items: ComplianceAutopilotEmailItem[]
  orgName?: string | null
  orgLogoUrl?: string | null
  orgSlug?: string | null
  /** Where the vendor uploads. Absent when they have no portal link yet. */
  portalUrl?: string | null
}

function escapeMessage(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

function formatComplianceDate(value?: string | null): string | null {
  if (!value) return null
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })
}

function complianceItemStatus(item: ComplianceAutopilotEmailItem): string {
  const date = formatComplianceDate(item.expiryDate)
  if (item.reminderKind === "missing") return "Not on file"
  if (item.reminderKind === "rejected") return "Sent back"
  if (item.reminderKind === "deficient") return item.deficiency ?? "Does not meet the requirement"
  if (item.reminderKind === "expired") return date ? `Expired ${date}` : "Expired"
  return date ? `Expires ${date}` : "Expiring soon"
}

function complianceEmailTitle(items: ComplianceAutopilotEmailItem[]): string {
  const noun = items.length === 1 ? "document" : "documents"
  const kinds = new Set(items.map((item) => item.reminderKind))
  if (kinds.size > 1) return `Compliance ${noun} need attention`
  const [kind] = kinds
  if (kind === "expired") return `Compliance ${noun} expired`
  if (kind === "expiring") return `Compliance ${noun} expiring`
  if (kind === "rejected") return `Compliance ${noun} sent back`
  if (kind === "deficient") return `Compliance ${noun} fall short`
  return `Compliance ${noun} needed`
}

export function buildComplianceAutopilotSubject(items: ComplianceAutopilotEmailItem[]): string {
  const kinds = new Set(items.map((item) => item.reminderKind))

  if (items.length === 1) {
    const [item] = items
    if (item.reminderKind === "missing") return `Compliance request: ${item.documentName} needed`
    if (item.reminderKind === "expired") return `Compliance expired: ${item.documentName}`
    if (item.reminderKind === "rejected") return `Action needed: ${item.documentName} was sent back`
    if (item.reminderKind === "deficient") {
      return `Action needed: ${item.documentName} does not meet the requirement`
    }
    return `Compliance reminder: ${item.documentName} expires soon`
  }

  if (kinds.size === 1) {
    const [kind] = kinds
    if (kind === "missing") return `Compliance request: ${items.length} documents needed`
    if (kind === "expired") return `Compliance expired: ${items.length} documents`
    if (kind === "rejected") return `Action needed: ${items.length} documents were sent back`
    if (kind === "deficient") {
      return `Action needed: ${items.length} documents do not meet the requirements`
    }
    return `Compliance reminder: ${items.length} documents expire soon`
  }

  return `Compliance update: ${items.length} documents need attention`
}

export interface ComplianceDecisionEmailPayload {
  to: string
  recipientName?: string | null
  companyName: string
  documentName: string
  decision: "approved" | "rejected"
  rejectionReason?: string | null
  orgName?: string | null
  orgLogoUrl?: string | null
  orgSlug?: string | null
  /** An existing portal link. A decision email never mints new access. */
  portalToken?: string | null
}

/**
 * Tell a vendor what happened to the document they sent.
 *
 * A rejection nobody is told about is a document that never gets fixed: the
 * autopilot only ever chased missing and expiring items, so a returned
 * certificate was invisible until the vendor happened to open the portal.
 */
export async function sendComplianceDecisionEmail(
  payload: ComplianceDecisionEmailPayload,
): Promise<boolean> {
  const approved = payload.decision === "approved"
  const documentName = escapeMessage(payload.documentName)
  const companyName = escapeMessage(payload.companyName)
  const greeting = payload.recipientName
    ? `<p style="margin:0 0 14px 0;">Hi ${escapeMessage(payload.recipientName)},</p>`
    : ""

  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com").replace(/\/$/, "")
  const portalUrl = payload.portalToken ? `${baseUrl}/s/${payload.portalToken}/compliance` : null

  const reasonBlock =
    !approved && payload.rejectionReason
      ? `<p style="margin:0 0 14px 0; padding:12px 14px; background:#faf7f2; border-left:3px solid #b45309; color:#111111; font-size:14px;">${escapeMessage(payload.rejectionReason)}</p>`
      : ""

  const body = approved
    ? `<p style="margin:0;">Nothing further is needed for this document. We will let you know before it expires.</p>`
    : `<p style="margin:0;">${
        portalUrl
          ? "Upload a corrected copy from your portal so work and payments are not held up."
          : "Please send a corrected copy to the project team so work and payments are not held up."
      }</p>`

  const html = renderStandardEmailLayout({
    title: approved ? `${payload.documentName} approved` : `${payload.documentName} needs another look`,
    messageHtml: `
      ${greeting}
      <p style="margin:0 0 14px 0;">Your <strong>${documentName}</strong> for ${companyName} was ${
        approved ? "approved" : "sent back"
      }.</p>
      ${reasonBlock}
      ${body}
    `,
    buttonText: !approved && portalUrl ? "Upload a new copy" : undefined,
    buttonUrl: !approved && portalUrl ? portalUrl : undefined,
    orgName: payload.orgName,
    orgLogoUrl: payload.orgLogoUrl,
  })

  return sendEmail({
    to: [payload.to],
    subject: approved
      ? `Approved: ${payload.documentName}`
      : `Action needed: ${payload.documentName} was sent back`,
    html,
    from: getOrgSenderEmail(payload.orgSlug, payload.orgName),
  })
}

export async function sendComplianceAutopilotEmail(
  payload: ComplianceAutopilotEmailPayload,
): Promise<boolean> {
  if (payload.items.length === 0) return false

  const companyName = escapeMessage(payload.companyName)
  const greeting = payload.recipientName
    ? `<p style="margin:0 0 14px 0;">Hi ${escapeMessage(payload.recipientName)},</p>`
    : ""

  const intro =
    payload.items.length === 1
      ? `The following document is outstanding for ${companyName}.`
      : `The following ${payload.items.length} documents are outstanding for ${companyName}.`

  const rows = payload.items
    .map(
      (item) => `
        <tr>
          <td style="padding:10px 0; border-bottom:1px solid #ebebeb; color:#111111; font-size:14px;">${escapeMessage(item.documentName)}</td>
          <td style="padding:10px 0; border-bottom:1px solid #ebebeb; color:#6b6b6b; font-size:13px; text-align:right; white-space:nowrap;">${escapeMessage(complianceItemStatus(item))}</td>
        </tr>`,
    )
    .join("")

  const subject = buildComplianceAutopilotSubject(payload.items)

  const html = renderStandardEmailLayout({
    title: complianceEmailTitle(payload.items),
    messageHtml: `
      ${greeting}
      <p style="margin:0 0 14px 0;">${intro}</p>
      <table border="0" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; margin:0 0 18px 0;">
        ${rows}
      </table>
      <p style="margin:0;">${
        payload.portalUrl
          ? "Upload the updated documents from your portal so work and payments do not get held up."
          : "Please upload updated documents or send them to the project team so work and payments do not get held up."
      }</p>
    `,
    buttonText: payload.portalUrl ? "Upload documents" : undefined,
    buttonUrl: payload.portalUrl ?? undefined,
    orgName: payload.orgName,
    orgLogoUrl: payload.orgLogoUrl,
  })

  return sendEmail({
    to: [payload.to],
    subject,
    html,
    from: getOrgSenderEmail(payload.orgSlug, payload.orgName),
  })
}

export interface BidInviteEmailPayload {
  to: string
  companyName?: string | null
  contactName?: string | null
  projectName?: string | null
  bidPackageTitle: string
  trade?: string | null
  dueDate?: string | null
  orgName?: string | null
  orgLogoUrl?: string | null
  bidLink: string
  orgSlug?: string | null
}

export async function sendBidInviteEmail(payload: BidInviteEmailPayload): Promise<void> {
  const dueDate = payload.dueDate
    ? new Date(payload.dueDate).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/New_York",
      })
    : undefined

  const html = await renderEmailTemplate(
    BidInviteEmail({
      companyName: payload.companyName,
      contactName: payload.contactName,
      projectName: payload.projectName,
      bidPackageTitle: payload.bidPackageTitle,
      trade: payload.trade,
      dueDate,
      orgName: payload.orgName,
      orgLogoUrl: payload.orgLogoUrl,
      bidLink: payload.bidLink,
    })
  )

  await sendEmail({
    to: [payload.to],
    subject: `Invitation to Bid: ${payload.bidPackageTitle}`,
    html,
    from: getOrgSenderEmail(payload.orgSlug, payload.orgName),
  })
}

export interface ProjectPortalInviteEmailPayload {
  to: string
  recipientName?: string | null
  projectName: string
  portalType: "client" | "sub" | "reviewer"
  orgName?: string | null
  orgLogoUrl?: string | null
  portalLink: string
  orgSlug?: string | null
}

export async function sendProjectPortalInviteEmail(payload: ProjectPortalInviteEmailPayload): Promise<boolean> {
  const html = await renderEmailTemplate(
    ProjectPortalInviteEmail({
      recipientName: payload.recipientName,
      projectName: payload.projectName,
      portalType: payload.portalType,
      orgName: payload.orgName,
      orgLogoUrl: payload.orgLogoUrl,
      portalLink: payload.portalLink,
    }),
  )

  return sendEmail({
    to: [payload.to],
    subject: `${payload.projectName} is ready in Arc`,
    html,
    from: getOrgSenderEmail(payload.orgSlug, payload.orgName),
  })
}

export interface BidAddendumEmailPayload {
  to: string
  companyName?: string | null
  contactName?: string | null
  projectName?: string | null
  bidPackageTitle: string
  addendumNumber: number
  addendumTitle?: string | null
  addendumMessage?: string | null
  orgName?: string | null
  orgLogoUrl?: string | null
  bidLink: string
  orgSlug?: string | null
}

export async function sendBidAddendumEmail(payload: BidAddendumEmailPayload): Promise<void> {
  const html = await renderEmailTemplate(
    BidAddendumEmail({
      companyName: payload.companyName,
      contactName: payload.contactName,
      projectName: payload.projectName,
      bidPackageTitle: payload.bidPackageTitle,
      addendumNumber: payload.addendumNumber,
      addendumTitle: payload.addendumTitle,
      addendumMessage: payload.addendumMessage,
      orgName: payload.orgName,
      orgLogoUrl: payload.orgLogoUrl,
      bidLink: payload.bidLink,
    })
  )

  await sendEmail({
    to: [payload.to],
    subject: `Addendum #${payload.addendumNumber} Issued: ${payload.bidPackageTitle}`,
    html,
    from: getOrgSenderEmail(payload.orgSlug, payload.orgName),
  })
}

export interface BidDateUpdateEmailPayload {
  to: string
  companyName?: string | null
  contactName?: string | null
  projectName?: string | null
  bidPackageTitle: string
  oldDueDate?: string | null
  newDueDate: string
  orgName?: string | null
  orgLogoUrl?: string | null
  bidLink: string
  orgSlug?: string | null
}

export async function sendBidDateUpdateEmail(payload: BidDateUpdateEmailPayload): Promise<void> {
  const formattedOldDueDate = payload.oldDueDate
    ? new Date(payload.oldDueDate).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/New_York",
      })
    : undefined

  const formattedNewDueDate = new Date(payload.newDueDate).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  })

  const html = await renderEmailTemplate(
    BidDateUpdateEmail({
      companyName: payload.companyName,
      contactName: payload.contactName,
      projectName: payload.projectName,
      bidPackageTitle: payload.bidPackageTitle,
      oldDueDate: formattedOldDueDate,
      newDueDate: formattedNewDueDate,
      orgName: payload.orgName,
      orgLogoUrl: payload.orgLogoUrl,
      bidLink: payload.bidLink,
    })
  )

  await sendEmail({
    to: [payload.to],
    subject: `Bid Deadline Update: ${payload.bidPackageTitle}`,
    html,
    from: getOrgSenderEmail(payload.orgSlug, payload.orgName),
  })
}

export interface VendorPayoutDestinationChangedEmailPayload {
  to: string[]
  vendorName: string
  /** Masked only. A full account or routing number never leaves the database. */
  bankLast4: string | null
  holdUntil: string
}

/**
 * The out-of-band warning that a payout bank changed.
 *
 * Sent to the vendor's own administrators, not to whoever made the change, and
 * deliberately alarming: if this was not them, the cooling period named here is
 * the window in which it can still be stopped. There is no action button — an
 * email that offers a one-click "confirm" to a phished recipient is worse than
 * no email at all.
 */
export async function sendVendorPayoutDestinationChangedEmail(
  payload: VendorPayoutDestinationChangedEmailPayload,
): Promise<boolean> {
  if (payload.to.length === 0) return false
  const holdUntil = new Date(payload.holdUntil).toLocaleString("en-US", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" })
  const account = payload.bankLast4 ? ` ending ${escapeMessage(payload.bankLast4)}` : ""
  const html = renderStandardEmailLayout({
    title: "Your Arc payout bank was changed",
    messageHtml: `
      <p style="margin:0 0 14px 0;">The payout bank account on file for ${escapeMessage(payload.vendorName)} was changed to an account${account}.</p>
      <p style="margin:0 0 14px 0;">Payments to this account are on hold until ${escapeMessage(holdUntil)} UTC while the change settles. Every builder who pays you through Arc has been told as well.</p>
      <p style="margin:0;"><strong>If you did not make this change, contact Arc support immediately and secure your Stripe account.</strong> Do not reply to this email with any bank details.</p>
    `,
  })
  return sendEmail({
    to: payload.to,
    subject: "Action may be required: your Arc payout bank changed",
    html,
  })
}

export interface VendorPaymentInviteEmailPayload {
  to: string[]
  recipientName?: string | null
  companyName: string
  orgName: string
  orgSlug?: string | null
  orgLogoUrl?: string | null
  setupUrl: string
  /** True when this send replaced a dead link the vendor may still be holding. */
  replacedPreviousLink?: boolean
  /** How long the link in this email stays good. */
  expiresInDays?: number
}

/**
 * Asks a vendor to set up Arc Pay. Deliberately does not promise a short flow:
 * a vendor who already verified with another Arc builder only has to confirm
 * the company, but one starting fresh goes through Stripe.
 *
 * One of the two genuinely external vendor emails on this rail, so it bypasses
 * builder notification preferences on purpose — the recipient is not a member
 * of the org whose settings would suppress it.
 */
export async function sendVendorPaymentInviteEmail(payload: VendorPaymentInviteEmailPayload): Promise<boolean> {
  if (payload.to.length === 0) return false
  const orgName = escapeMessage(payload.orgName)
  const greeting = payload.recipientName
    ? `<p style="margin:0 0 14px 0;">Hi ${escapeMessage(payload.recipientName)},</p>`
    : ""

  const html = renderStandardEmailLayout({
    title: `Get paid by ${payload.orgName} through Arc Pay`,
    messageHtml: `
      ${greeting}
      <p style="margin:0 0 14px 0;">${orgName} pays subcontractors through Arc Pay and would like to pay ${escapeMessage(payload.companyName)} by bank transfer instead of by check.</p>
      <p style="margin:0 0 14px 0;">You verify your business and payout bank once. The same account then works with every Arc builder you work with, so if you have already done this for another builder there is nothing to set up again — just confirm your company.</p>
      <p style="margin:0 0 14px 0;">${orgName} never sees or enters your bank details.</p>
      ${payload.replacedPreviousLink
        ? `<p style="margin:0 0 14px 0;"><strong>This link replaces the one we sent before.</strong> The earlier link no longer works — use the button below.</p>`
        : ""}
      ${payload.expiresInDays
        ? `<p style="margin:0;color:#666666;font-size:13px;">This invitation is good for ${payload.expiresInDays} days. If it expires, ask ${orgName} to send a new one.</p>`
        : ""}
    `,
    buttonText: "Set up Arc Pay",
    buttonUrl: payload.setupUrl,
    orgName: payload.orgName,
    orgLogoUrl: payload.orgLogoUrl,
  })

  return sendEmail({
    to: payload.to,
    subject: `${payload.orgName} would like to pay you through Arc Pay`,
    html,
    from: getOrgSenderEmail(payload.orgSlug, payload.orgName),
  })
}

export interface PrequalificationRequestEmailPayload {
  to: string
  recipientName?: string | null
  companyName: string
  orgName?: string | null
  orgLogoUrl?: string | null
  orgSlug?: string | null
  portalLink: string
  askedFor: string[]
  message?: string | null
}

export async function sendPrequalificationRequestEmail(
  payload: PrequalificationRequestEmailPayload,
): Promise<boolean> {
  const html = await renderEmailTemplate(
    PrequalificationRequestEmail({
      recipientName: payload.recipientName,
      companyName: payload.companyName,
      orgName: payload.orgName,
      orgLogoUrl: payload.orgLogoUrl,
      portalLink: payload.portalLink,
      askedFor: payload.askedFor,
      message: payload.message,
    }),
  )

  return sendEmail({
    to: [payload.to],
    subject: `${payload.orgName ?? "Arc"} would like to prequalify ${payload.companyName}`,
    html,
    from: getOrgSenderEmail(payload.orgSlug, payload.orgName),
  })
}

export interface PrequalificationDecisionEmailPayload {
  to: string
  recipientName?: string | null
  companyName: string
  orgName?: string | null
  orgLogoUrl?: string | null
  orgSlug?: string | null
  decision: "approved" | "approved_with_limits" | "declined"
  expiresAt?: string | null
  singleProjectLimit?: string | null
  aggregateLimit?: string | null
  reviewNotes?: string | null
}

export async function sendPrequalificationDecisionEmail(
  payload: PrequalificationDecisionEmailPayload,
): Promise<boolean> {
  const html = await renderEmailTemplate(
    PrequalificationDecisionEmail({
      recipientName: payload.recipientName,
      companyName: payload.companyName,
      orgName: payload.orgName,
      orgLogoUrl: payload.orgLogoUrl,
      decision: payload.decision,
      expiresAt: payload.expiresAt,
      singleProjectLimit: payload.singleProjectLimit,
      aggregateLimit: payload.aggregateLimit,
      reviewNotes: payload.reviewNotes,
    }),
  )

  return sendEmail({
    to: [payload.to],
    subject:
      payload.decision === "declined"
        ? `${payload.orgName ?? "Arc"}: prequalification decision for ${payload.companyName}`
        : `${payload.companyName} is prequalified with ${payload.orgName ?? "Arc"}`,
    html,
    from: getOrgSenderEmail(payload.orgSlug, payload.orgName),
  })
}
