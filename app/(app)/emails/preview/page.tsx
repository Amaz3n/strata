import Link from "next/link"
import { PageLayout } from "@/components/layout/page-layout"
import {
  BidInviteEmail,
  InvoiceEmail,
  InvoiceReminderEmail,
  InviteTeamMemberEmail,
  RfiNotificationEmail,
  WeeklyExecutiveSnapshotEmail,
} from "@/lib/emails"
import { ComplianceDocumentReviewedEmail } from "@/lib/emails/compliance-document-reviewed-email"
import { ComplianceDocumentUploadedEmail } from "@/lib/emails/compliance-document-uploaded-email"
import { renderEmailTemplate } from "@/lib/services/mailer"

type SearchParams = Promise<Record<string, string | string[] | undefined>>
type TemplateId =
  | "rfi-notification"
  | "bid-invite"
  | "invoice"
  | "invoice-reminder"
  | "team-invite"
  | "compliance-uploaded"
  | "compliance-reviewed"
  | "weekly-executive-snapshot"

const TEMPLATE_OPTIONS: Array<{ id: TemplateId; label: string; description: string }> = [
  { id: "rfi-notification", label: "RFI Notification", description: "Created, response, and decision updates." },
  { id: "bid-invite", label: "Bid Invitation", description: "Invites trade partners to bid." },
  { id: "invoice", label: "Invoice Sent", description: "Initial invoice email." },
  { id: "invoice-reminder", label: "Invoice Reminder", description: "Due or overdue reminders." },
  { id: "team-invite", label: "Team Invite", description: "Org invitation email." },
  { id: "compliance-uploaded", label: "Compliance Uploaded", description: "Internal alert for upload review." },
  { id: "compliance-reviewed", label: "Compliance Reviewed", description: "Approved or rejected result." },
  {
    id: "weekly-executive-snapshot",
    label: "Weekly Executive Snapshot",
    description: "Executive portfolio digest for active projects, risk, and financial exposure.",
  },
]

const RFI_KIND_OPTIONS = ["created", "response", "decision"] as const
const RFI_AUDIENCE_OPTIONS = ["internal", "client", "sub"] as const
const REMINDER_VARIANTS = ["due", "overdue"] as const
const COMPLIANCE_DECISIONS = ["approved", "rejected"] as const

export const dynamic = "force-dynamic"

function firstValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value[0]
  return undefined
}

function toUrlParams(params: Record<string, string | string[] | undefined>) {
  const next = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    const first = firstValue(value)
    if (typeof first === "string") next.set(key, first)
  }
  return next
}

function pick(value: string | undefined, fallback: string): string {
  return value?.trim().length ? value : fallback
}

function parseEnum<T extends string>(value: string | undefined, options: readonly T[], fallback: T): T {
  return value && options.includes(value as T) ? (value as T) : fallback
}

function pillClass(isActive: boolean) {
  return isActive
    ? "rounded-full border border-primary/50 bg-primary/10 px-3 py-1 text-xs font-medium text-primary"
    : "rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
}

export default async function EmailPreviewPage({ searchParams }: { searchParams: SearchParams }) {
  const resolvedSearchParams = await searchParams
  const params = toUrlParams(resolvedSearchParams)

  const template = parseEnum(params.get("template") ?? undefined, TEMPLATE_OPTIONS.map((option) => option.id), "rfi-notification")

  const rfiKind = parseEnum(params.get("kind") ?? undefined, RFI_KIND_OPTIONS, "created")
  const rfiAudience = parseEnum(params.get("audience") ?? undefined, RFI_AUDIENCE_OPTIONS, "sub")
  const reminderVariant = parseEnum(params.get("variant") ?? undefined, REMINDER_VARIANTS, "due")
  const complianceDecision = parseEnum(params.get("decision") ?? undefined, COMPLIANCE_DECISIONS, "approved")

  const withPatch = (patch: Record<string, string>) => {
    const next = toUrlParams(resolvedSearchParams)
    for (const [key, value] of Object.entries(patch)) next.set(key, value)
    return `/emails/preview?${next.toString()}`
  }

  const sample = {
    orgName: pick(params.get("orgName") ?? undefined, "Arc Naples"),
    orgLogoUrl: params.get("orgLogoUrl") ?? "/icon-dark-32x32.png",
    recipientName: pick(params.get("recipientName") ?? undefined, "Alex Rivera"),
    companyName: pick(params.get("companyName") ?? undefined, "Harbor Steel LLC"),
    inviteeEmail: pick(params.get("inviteeEmail") ?? undefined, "architect@harborsteel.com"),
    inviterName: pick(params.get("inviterName") ?? undefined, "Jordan Lee"),
    inviterEmail: pick(params.get("inviterEmail") ?? undefined, "jordan@arcnaples.com"),
    projectName: pick(params.get("projectName") ?? undefined, "Naples Bay Villas"),
    subject: pick(params.get("subject") ?? undefined, "Please confirm structural beam depth over great room"),
    question: pick(
      params.get("question") ?? undefined,
      "Can you confirm whether the beam over gridline C should remain at 14 inches clear depth in the current revision?",
    ),
    responseMessage: pick(
      params.get("responseMessage") ?? undefined,
      "Reviewed against revision A7.2. Maintain 14 inches clear depth as drawn. No changes required.",
    ),
    decisionNote: pick(
      params.get("decisionNote") ?? undefined,
      "Approved per latest structural set. Proceed with framing per current drawings.",
    ),
    priority: pick(params.get("priority") ?? undefined, "high"),
    dueDate: pick(params.get("dueDate") ?? undefined, "Feb 28, 2026"),
    rfiNumber: pick(params.get("rfiNumber") ?? undefined, "117"),
    bidPackageTitle: pick(params.get("bidPackageTitle") ?? undefined, "Structural Steel Fabrication"),
    trade: pick(params.get("trade") ?? undefined, "Structural"),
    bidDueDate: pick(params.get("bidDueDate") ?? undefined, "Mar 4, 2026 at 5:00 PM"),
    invoiceNumber: pick(params.get("invoiceNumber") ?? undefined, "INV-2831"),
    invoiceTitle: pick(params.get("invoiceTitle") ?? undefined, "Progress Billing - February"),
    amount: pick(params.get("amount") ?? undefined, "$42,750.00"),
    invoiceDueDate: pick(params.get("invoiceDueDate") ?? undefined, "Mar 7, 2026"),
    documentType: pick(params.get("documentType") ?? undefined, "Certificate of Insurance"),
    uploadedAt: pick(params.get("uploadedAt") ?? undefined, "Feb 22, 2026 at 9:38 AM"),
    reviewNotes: pick(
      params.get("reviewNotes") ?? undefined,
      "Coverage meets project requirements and expiration aligns with contract period.",
    ),
    rejectionReason: pick(
      params.get("rejectionReason") ?? undefined,
      "Missing worker's compensation endorsement and additional insured language.",
    ),
    snapshotWeekLabel: pick(params.get("snapshotWeekLabel") ?? undefined, "Week of Feb 16 - Feb 22, 2026"),
    snapshotGeneratedAt: pick(
      params.get("snapshotGeneratedAt") ?? undefined,
      "Generated Feb 22, 2026 at 8:00 AM EST",
    ),
    inviteLink: params.get("inviteLink") ?? "https://app.arcnaples.com/auth/accept-invite?token=example",
    bidLink: params.get("bidLink") ?? "https://app.arcnaples.com/b/example-bid-token",
    invoiceLink: params.get("invoiceLink") ?? "https://app.arcnaples.com/i/example-invoice-token",
    payLink: params.get("payLink") ?? "https://app.arcnaples.com/i/example-invoice-token",
    snapshotLink: params.get("snapshotLink") ?? "https://app.arcnaples.com",
    rfiInternalLink:
      params.get("rfiInternalLink") ??
      "https://app.arcnaples.com/rfis?highlight=726acd18-1be8-4840-a9ee-db63348237c5",
    rfiClientLink: params.get("rfiClientLink") ?? "https://app.arcnaples.com/p/example-client-token",
    rfiSubLink: params.get("rfiSubLink") ?? "https://app.arcnaples.com/s/example-sub-token/rfis",
  }

  const actionHref =
    rfiAudience === "internal" ? sample.rfiInternalLink : rfiAudience === "client" ? sample.rfiClientLink : sample.rfiSubLink
  const actionLabel = rfiAudience === "internal" ? "Open in Arc" : "Respond in Portal"

  const html = await renderEmailTemplate(
    (() => {
      switch (template) {
        case "rfi-notification":
          return RfiNotificationEmail({
            orgName: sample.orgName,
            orgLogoUrl: sample.orgLogoUrl,
            recipientName: sample.recipientName,
            audience: rfiAudience,
            projectName: sample.projectName,
            rfiNumber: sample.rfiNumber,
            subject: sample.subject,
            question: sample.question,
            kind: rfiKind,
            message: sample.responseMessage,
            decisionStatus: "approved",
            decisionNote: sample.decisionNote,
            priority: sample.priority,
            dueDate: sample.dueDate,
            actionHref,
            actionLabel,
          })
        case "bid-invite":
          return BidInviteEmail({
            companyName: sample.companyName,
            contactName: sample.recipientName,
            projectName: sample.projectName,
            bidPackageTitle: sample.bidPackageTitle,
            trade: sample.trade,
            dueDate: sample.bidDueDate,
            orgName: sample.orgName,
            orgLogoUrl: sample.orgLogoUrl,
            bidLink: sample.bidLink,
          })
        case "invoice":
          return InvoiceEmail({
            invoiceNumber: sample.invoiceNumber,
            invoiceTitle: sample.invoiceTitle,
            projectName: sample.projectName,
            amount: sample.amount,
            dueDate: sample.invoiceDueDate,
            invoiceLink: sample.invoiceLink,
            orgName: sample.orgName,
            orgLogoUrl: sample.orgLogoUrl,
          })
        case "invoice-reminder":
          return InvoiceReminderEmail({
            recipientName: sample.recipientName,
            invoiceNumber: sample.invoiceNumber,
            amount: sample.amount,
            dueDate: sample.invoiceDueDate,
            daysOverdue: reminderVariant === "overdue" ? 12 : undefined,
            payLink: sample.payLink,
            orgName: sample.orgName,
            orgLogoUrl: sample.orgLogoUrl,
          })
        case "team-invite":
          return InviteTeamMemberEmail({
            orgName: sample.orgName,
            orgLogoUrl: sample.orgLogoUrl,
            inviterName: sample.inviterName,
            inviterEmail: sample.inviterEmail,
            inviteeEmail: sample.inviteeEmail,
            inviteLink: sample.inviteLink,
          })
        case "compliance-uploaded":
          return ComplianceDocumentUploadedEmail({
            orgName: sample.orgName,
            orgLogoUrl: sample.orgLogoUrl,
            companyName: sample.companyName,
            documentType: sample.documentType,
            uploadedAt: sample.uploadedAt,
          })
        case "compliance-reviewed":
          return ComplianceDocumentReviewedEmail({
            orgName: sample.orgName,
            orgLogoUrl: sample.orgLogoUrl,
            companyName: sample.companyName,
            documentType: sample.documentType,
            decision: complianceDecision,
            reviewNotes: sample.reviewNotes,
            rejectionReason: complianceDecision === "rejected" ? sample.rejectionReason : null,
          })
        case "weekly-executive-snapshot":
          return WeeklyExecutiveSnapshotEmail({
            orgName: sample.orgName,
            orgLogoUrl: sample.orgLogoUrl,
            recipientName: sample.recipientName,
            weekLabel: sample.snapshotWeekLabel,
            generatedAtLabel: sample.snapshotGeneratedAt,
            controlTowerLink: sample.snapshotLink,
            metrics: [
              { label: "Active Projects", value: "18" },
              { label: "Exec Attention", value: "4" },
              { label: "AR 30+ Days", value: "$128K" },
              { label: "Pending CO Value", value: "$412K" },
              { label: "Decisions This Week", value: "9" },
            ],
            watchlist: [
              {
                projectName: "Naples Bay Villas",
                schedule: "2 critical path milestones trending 9 days late",
                cost: "$96K unpaid AR + $140K pending CO",
                docs: "Approve steel CO by Thu to protect framing sequence",
              },
              {
                projectName: "Southport Medical Plaza",
                schedule: "OR wing turnover milestone at risk for Mar 18",
                cost: "$128K AR overdue; $52K vendor bills pending",
                docs: "Escalate owner billing call + release 3 aged bills",
              },
              {
                projectName: "Harbor Townhomes",
                schedule: "Facade package submittal approval blocking install",
                cost: "2 COs pending, net $74K exposure",
                docs: "Finalize glazing submittal decision within 72 hours",
              },
              {
                projectName: "Gulfshore Offices Phase 2",
                schedule: "Concrete pour sequence stable; no critical slips",
                cost: "Healthy cash position; AR current",
                docs: "No executive intervention needed this week",
              },
            ],
            decisions: [
              {
                typeLabel: "Change Order",
                title: "CO-017 Structural steel revision",
                projectName: "Naples Bay Villas",
                owner: "Precon + Ops",
                dueBy: "Thu 5:00 PM",
                ageLabel: "9d",
                impactLabel: "$83,000 · 6d impact",
              },
              {
                typeLabel: "Submittal",
                title: "Curtain wall glazing package",
                projectName: "Southport Medical Plaza",
                owner: "Project Lead",
                dueBy: "Wed 2:00 PM",
                ageLabel: "6d",
                impactLabel: "Lead time 21d",
              },
              {
                typeLabel: "Vendor Bill",
                title: "Bill #VB-2048 awaiting approval",
                projectName: "Harbor Townhomes",
                owner: "Office Admin",
                dueBy: "Fri 12:00 PM",
                ageLabel: "11d",
                impactLabel: "$42,500",
              },
              {
                typeLabel: "Owner Decision",
                title: "Lobby finish alternate selection",
                projectName: "Gulfshore Offices Phase 2",
                owner: "Client + PM",
                dueBy: "Fri EOD",
                ageLabel: "4d",
                impactLabel: "Could shift handover by 3 days",
              },
            ],
            drift: [
              { label: "Critical Delays", current: "6", delta: "-1 vs prior 7d" },
              { label: "AR 30+ Days", current: "$128K", delta: "+$22K vs prior 7d" },
              { label: "Pending COs", current: "$412K", delta: "+$58K vs prior 7d" },
              { label: "Overdue RFIs", current: "11", delta: "-3 vs prior 7d" },
            ],
            executiveNotes: [
              "Biggest immediate lever: close 2 high-value decisions by Thursday to prevent schedule carryover into next week.",
              "Cash trend is mixed: collections slowed in medical and multifamily portfolios while AP approvals remain backlogged.",
              "Current risk concentration is acceptable if Naples steel and Southport glazing decisions are resolved on time.",
            ],
          })
        default:
          return RfiNotificationEmail({
            orgName: sample.orgName,
            recipientName: sample.recipientName,
            audience: "sub",
            projectName: sample.projectName,
            rfiNumber: sample.rfiNumber,
            subject: sample.subject,
            question: sample.question,
            kind: "created",
            actionHref: sample.rfiSubLink,
            actionLabel: "Respond in Portal",
          })
      }
    })(),
  )

  const selectedTemplate = TEMPLATE_OPTIONS.find((option) => option.id === template)

  return (
    <PageLayout title="Email Preview">
      <div className="space-y-5">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Email Preview</h1>
          <p className="text-sm text-muted-foreground">
            Render any Arc email template in-app without sending a message.
          </p>
        </div>

        <div className="rounded-lg border bg-card p-4 space-y-4">
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Template</p>
            <div className="flex flex-wrap gap-2">
              {TEMPLATE_OPTIONS.map((option) => (
                <Link key={option.id} href={withPatch({ template: option.id })} className={pillClass(template === option.id)}>
                  {option.label}
                </Link>
              ))}
            </div>
            {selectedTemplate && <p className="text-xs text-muted-foreground">{selectedTemplate.description}</p>}
          </div>

          {template === "rfi-notification" && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">RFI Event</p>
                <div className="flex flex-wrap gap-2">
                  {RFI_KIND_OPTIONS.map((option) => (
                    <Link key={option} href={withPatch({ kind: option })} className={pillClass(rfiKind === option)}>
                      {option}
                    </Link>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Audience</p>
                <div className="flex flex-wrap gap-2">
                  {RFI_AUDIENCE_OPTIONS.map((option) => (
                    <Link key={option} href={withPatch({ audience: option })} className={pillClass(rfiAudience === option)}>
                      {option}
                    </Link>
                  ))}
                </div>
              </div>
            </div>
          )}

          {template === "invoice-reminder" && (
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Reminder State</p>
              <div className="flex flex-wrap gap-2">
                {REMINDER_VARIANTS.map((option) => (
                  <Link key={option} href={withPatch({ variant: option })} className={pillClass(reminderVariant === option)}>
                    {option}
                  </Link>
                ))}
              </div>
            </div>
          )}

          {template === "compliance-reviewed" && (
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Decision</p>
              <div className="flex flex-wrap gap-2">
                {COMPLIANCE_DECISIONS.map((option) => (
                  <Link key={option} href={withPatch({ decision: option })} className={pillClass(complianceDecision === option)}>
                    {option}
                  </Link>
                ))}
              </div>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Tip: all sample values can be overridden via query params for quick copy review links.
          </p>
        </div>

        <div className="overflow-hidden rounded-lg border bg-white">
          <iframe title="Email preview" srcDoc={html} className="h-[980px] w-full" style={{ colorScheme: "light" }} />
        </div>
      </div>
    </PageLayout>
  )
}
