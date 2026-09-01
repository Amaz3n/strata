import { Button, Heading, Link, Section, Text } from "@react-email/components"

import { EmailLayout } from "./email-layout"
import {
  button,
  buttonWrap,
  contentCard,
  contentLabel,
  contentText,
  eventLabelText,
  fallbackText,
  heading,
  link,
  metaCard,
  metaLabel,
  metaRow,
  metaValue,
  paragraph,
  subjectText,
} from "./theme"

export interface SubmittalNotificationEmailProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  recipientName?: string | null
  audience: "internal" | "client" | "sub" | "reviewer"
  projectName?: string | null
  submittalNumber: number | string
  revision: number
  title: string
  description?: string | null
  kind: "created" | "item_submitted" | "decision" | "resubmit_requested" | "review_requested"
  decisionStatus?: string | null
  decisionNote?: string | null
  specSection?: string | null
  dueDate?: string | null
  requiredOnSite?: string | null
  actionHref: string
  actionLabel: string
}

const decisionDisplay: Record<string, string> = {
  approved: "Approved",
  approved_as_noted: "Approved as Noted",
  revise_resubmit: "Revise & Resubmit",
  rejected: "Rejected",
}

export function SubmittalNotificationEmail({
  orgName,
  orgLogoUrl,
  recipientName,
  audience,
  projectName,
  submittalNumber,
  revision,
  title,
  description,
  kind,
  decisionStatus,
  decisionNote,
  specSection,
  dueDate,
  requiredOnSite,
  actionHref,
  actionLabel,
}: SubmittalNotificationEmailProps) {
  const displayOrgName = orgName ?? "Arc"
  const numberLabel = revision > 0 ? `#${submittalNumber} Rev ${revision}` : `#${submittalNumber}`
  const previewText =
    kind === "created"
      ? `Submittal ${numberLabel} is ready for action`
      : kind === "item_submitted"
        ? `New documents on submittal ${numberLabel}`
        : kind === "resubmit_requested"
          ? `Submittal ${numberLabel} needs resubmission`
          : kind === "review_requested"
            ? `Submittal ${numberLabel} is waiting on your review`
            : `Decision posted on submittal ${numberLabel}`
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,"

  const eventLabel =
    kind === "created"
      ? "New Submittal"
      : kind === "item_submitted"
        ? "Documents Submitted"
        : kind === "resubmit_requested"
          ? "Resubmission Requested"
          : kind === "review_requested"
            ? "Review Requested"
            : "Decision Posted"

  const summaryText =
    kind === "created"
      ? audience === "sub"
        ? "A submittal has been assigned to your company. Please submit the requested documents."
        : "A new submittal has been created and is being tracked."
      : kind === "item_submitted"
        ? "New submittal documents were received and are awaiting review."
        : kind === "resubmit_requested"
          ? "The reviewer has requested a revised submission."
          : kind === "review_requested"
            ? "This submittal has been routed to you for design review. Please review the documents and return your decision."
            : "The review decision has been recorded for this submittal."

  return (
    <EmailLayout
      preview={previewText}
      subtitle="Submittal"
      orgName={orgName}
      orgLogoUrl={orgLogoUrl}
    >
      <Text style={eventLabelText}>{eventLabel}</Text>
      <Heading style={heading}>Submittal {numberLabel}</Heading>
      <Text style={subjectText}>{title}</Text>

      <Text style={paragraph}>{greeting}</Text>
      <Text style={paragraph}>{summaryText}</Text>

      <Section style={metaCard}>
        {projectName ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Project:</span> <span style={metaValue}>{projectName}</span>
          </Text>
        ) : null}
        {specSection ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Spec Section:</span> <span style={metaValue}>{specSection}</span>
          </Text>
        ) : null}
        {dueDate ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Review Due:</span> <span style={metaValue}>{dueDate}</span>
          </Text>
        ) : null}
        {requiredOnSite ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Required On Site:</span> <span style={metaValue}>{requiredOnSite}</span>
          </Text>
        ) : null}
      </Section>

      {kind === "created" && description ? (
        <Section style={contentCard}>
          <Text style={contentLabel}>Description</Text>
          <Text style={contentText}>{description}</Text>
        </Section>
      ) : null}

      {kind === "decision" || kind === "resubmit_requested" ? (
        <Section style={decisionCard}>
          <Text style={decisionLabel}>Decision</Text>
          <Text style={decisionStatusText}>
            {decisionStatus ? decisionDisplay[decisionStatus] ?? decisionStatus : "Updated"}
          </Text>
          {decisionNote ? <Text style={decisionContentText}>{decisionNote}</Text> : null}
        </Section>
      ) : null}

      <Section style={buttonWrap}>
        <Button style={button} href={actionHref}>
          {actionLabel}
        </Button>
      </Section>

      <Text style={fallbackText}>
        If the button does not open,{" "}
        <Link href={actionHref} style={link}>
          open secure link
        </Link>
      </Text>
    </EmailLayout>
  )
}

const decisionCard: React.CSSProperties = {
  border: "1px solid #d9d9d5",
  backgroundColor: "#f7f7f5",
  padding: "14px 18px",
  margin: "18px 0",
}

const decisionLabel: React.CSSProperties = {
  margin: "0 0 6px 0",
  color: "#6b6b6b",
  fontWeight: 700,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "1px",
}

const decisionStatusText: React.CSSProperties = {
  margin: "0",
  color: "#111111",
  fontSize: "16px",
  fontWeight: 700,
}

const decisionContentText: React.CSSProperties = {
  margin: "8px 0 0 0",
  color: "#333333",
  fontSize: "14px",
  lineHeight: "1.6",
  whiteSpace: "pre-wrap" as const,
}

