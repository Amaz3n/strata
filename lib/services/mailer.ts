import { render } from "@react-email/components"
import type { ReactElement } from "react"
import { BidInviteEmail } from "@/lib/emails/bid-invite-email"
import { BidAddendumEmail } from "@/lib/emails/bid-addendum-email"
import { BidDateUpdateEmail } from "@/lib/emails/bid-date-update-email"
import { InvoiceReminderEmail } from "@/lib/emails/invoice-reminder-email"
import { ProjectPortalInviteEmail } from "@/lib/emails/project-portal-invite-email"
import { InviteTeamMemberEmail } from "@/lib/emails/invite-team-member-email"
import { PasswordResetEmail } from "@/lib/emails/password-reset-email"

const RESEND_API_KEY = process.env.RESEND_API_KEY
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "onboarding@resend.dev"

export interface EmailPayload {
  to: (string | null | undefined)[]
  subject: string
  html: string
  text?: string
  replyTo?: string | null
  from?: string
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
                <td align="center" style="background-color: #3A70EE; border-radius: 4px;">
                  <a href="${args.buttonUrl}" style="background-color: #3A70EE; color: #ffffff; border: 1px solid #3A70EE; text-decoration: none; font-size: 14px; font-weight: 700; padding: 12px 24px; display: inline-block; border-radius: 4px;">
                    ${escapeHtml(args.buttonText || 'Open in Arc')}
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin: 16px 0 0 0; color: #666666; font-size: 12px; line-height: 1.65; text-align: center;">
              If the button does not open, <a href="${args.buttonUrl}" style="color: #3A70EE; text-decoration: underline;">open secure link</a>
            </p>
          ` : ''}
        </td>
      </tr>
      
      <!-- Footer -->
      <tr>
        <td style="padding: 18px 40px 22px 40px; background-color: #ffffff; border-top: 1px solid #ebebeb; text-align: center;">
          <div style="margin: 0 0 8px 0; color: #777777; font-size: 12px; line-height: 1.5;">Sent via Arc</div>
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

export interface ComplianceAutopilotEmailPayload {
  to: string
  recipientName?: string | null
  companyName: string
  documentName: string
  reminderKind: "missing" | "expiring" | "expired"
  expiryDate?: string | null
  daysUntilExpiry?: number | null
  orgName?: string | null
  orgLogoUrl?: string | null
  orgSlug?: string | null
  uploadUrl?: string | null
}

function escapeMessage(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

export async function sendComplianceAutopilotEmail(
  payload: ComplianceAutopilotEmailPayload,
): Promise<string | undefined> {
  const expiryDate = payload.expiryDate
    ? new Date(payload.expiryDate).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null
  const documentName = escapeMessage(payload.documentName)
  const companyName = escapeMessage(payload.companyName)
  const greeting = payload.recipientName
    ? `<p style="margin:0 0 14px 0;">Hi ${escapeMessage(payload.recipientName)},</p>`
    : ""

  const message =
    payload.reminderKind === "missing"
      ? `${documentName} is missing for ${companyName}.`
      : payload.reminderKind === "expired"
        ? `${documentName} for ${companyName} has expired${expiryDate ? ` as of ${escapeMessage(expiryDate)}` : ""}.`
        : `${documentName} for ${companyName} expires${expiryDate ? ` on ${escapeMessage(expiryDate)}` : ""}.`

  const subject =
    payload.reminderKind === "missing"
      ? `Compliance request: ${payload.documentName} needed`
      : payload.reminderKind === "expired"
        ? `Compliance expired: ${payload.documentName}`
        : `Compliance reminder: ${payload.documentName} expires soon`

  const html = renderStandardEmailLayout({
    title:
      payload.reminderKind === "missing"
        ? "Compliance document needed"
        : payload.reminderKind === "expired"
          ? "Compliance document expired"
          : "Compliance document expiring",
    messageHtml: `
      ${greeting}
      <p style="margin:0 0 14px 0;">${message}</p>
      <p style="margin:0;">Please upload an updated document or send it to the project team so work and payments do not get held up.</p>
    `,
    buttonText: payload.uploadUrl ? "Upload document" : undefined,
    buttonUrl: payload.uploadUrl ?? undefined,
    orgName: payload.orgName,
    orgLogoUrl: payload.orgLogoUrl,
  })

  const sent = await sendEmail({
    to: [payload.to],
    subject,
    html,
    from: getOrgSenderEmail(payload.orgSlug, payload.orgName),
  })

  return sent
    ? `compliance-${payload.reminderKind}-${payload.documentName}-${Date.now()}`
    : undefined
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
  portalType: "client" | "sub"
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
