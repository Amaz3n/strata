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

export interface RfiNotificationEmailProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  recipientName?: string | null
  audience: "internal" | "client" | "sub"
  projectName?: string | null
  rfiNumber: number | string
  subject: string
  question?: string | null
  kind: "created" | "response" | "decision"
  message?: string | null
  decisionStatus?: string | null
  decisionNote?: string | null
  priority?: string | null
  dueDate?: string | null
  actionHref: string
  actionLabel: string
}

export function RfiNotificationEmail({
  orgName,
  orgLogoUrl,
  recipientName,
  audience,
  projectName,
  rfiNumber,
  subject,
  question,
  kind,
  message,
  decisionStatus,
  decisionNote,
  priority,
  dueDate,
  actionHref,
  actionLabel,
}: RfiNotificationEmailProps) {
  const displayOrgName = orgName ?? "Arc"
  const previewText =
    kind === "created"
      ? `RFI #${rfiNumber} is ready for review`
      : kind === "response"
        ? `New response on RFI #${rfiNumber}`
        : `Decision posted on RFI #${rfiNumber}`
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,"

  const eventLabel = kind === "created" ? "New RFI" : kind === "response" ? "Response Added" : "Decision Posted"

  const audienceLabel =
    audience === "internal"
      ? "Arc Team"
      : audience === "sub"
        ? "Trade Partner"
        : "Project Stakeholder"

  const summaryText =
    kind === "created"
      ? "A new RFI has been issued and is ready for review."
      : kind === "response"
        ? "There is a new update in the RFI thread."
        : "A final decision has been recorded for this RFI."

  return (
    <EmailLayout
      preview={previewText}
      subtitle="Request for Information"
      orgName={orgName}
      orgLogoUrl={orgLogoUrl}
    >
      <Text style={eventLabelText}>{eventLabel}</Text>
      <Heading style={heading}>RFI #{rfiNumber}</Heading>
      <Text style={subjectText}>{subject}</Text>

      <Text style={paragraph}>{greeting}</Text>
      <Text style={paragraph}>{summaryText}</Text>

      <Section style={metaCard}>
        {projectName ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Project:</span> <span style={metaValue}>{projectName}</span>
          </Text>
        ) : null}
        <Text style={metaRow}>
          <span style={metaLabel}>Audience:</span> <span style={metaValue}>{audienceLabel}</span>
        </Text>
        <Text style={metaRow}>
          <span style={metaLabel}>Priority:</span>{" "}
          <span style={metaValue}>{priority ? priority.toUpperCase() : "NORMAL"}</span>
        </Text>
        {dueDate ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Due Date:</span> <span style={metaValue}>{dueDate}</span>
          </Text>
        ) : null}
      </Section>

      {kind === "created" ? (
        <Section style={contentCard}>
          <Text style={contentLabel}>Question</Text>
          <Text style={contentText}>{question ?? "No question body was provided."}</Text>
        </Section>
      ) : null}

      {kind === "response" ? (
        <Section style={contentCard}>
          <Text style={contentLabel}>Latest Response</Text>
          <Text style={contentText}>{message ?? "A new response was posted."}</Text>
        </Section>
      ) : null}

      {kind === "decision" ? (
        <Section style={decisionCard}>
          <Text style={decisionLabel}>Decision</Text>
          <Text style={decisionStatusText}>{decisionStatus ?? "Updated"}</Text>
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
  marginTop: "16px",
  padding: "16px",
  border: "2px solid #1fca84",
  backgroundColor: "#0f3a2e",
}

const decisionLabel: React.CSSProperties = {
  margin: "0 0 8px 0",
  color: "#9ab7aa",
  fontWeight: 700,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const decisionStatusText: React.CSSProperties = {
  margin: "0 0 10px 0",
  color: "#22e38a",
  fontWeight: 700,
  fontSize: "16px",
  textTransform: "capitalize",
}

const decisionContentText: React.CSSProperties = {
  margin: "0",
  color: "#a9c3b7",
  fontSize: "14px",
  lineHeight: "1.6",
  whiteSpace: "pre-wrap",
}

export default RfiNotificationEmail
