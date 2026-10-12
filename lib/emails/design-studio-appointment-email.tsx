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

export interface DesignStudioAppointmentEmailProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  recipientName?: string | null
  kind: "booked" | "rescheduled" | "canceled"
  homeName?: string | null
  studioName: string
  studioAddress?: string | null
  consultantName?: string | null
  /** Already rendered at the studio's wall-clock time, zone included. */
  windowText: string
  previousWindowText?: string | null
  /** Each covered group with its deadline, which a session never moves. */
  deadlines: Array<{ name: string; cutoffText: string | null }>
  reason?: string | null
  actionHref?: string | null
  actionLabel?: string | null
}

const EVENT_LABEL = {
  booked: "Design Studio Appointment",
  rescheduled: "Appointment Moved",
  canceled: "Appointment Canceled",
} as const

export function DesignStudioAppointmentEmail({
  orgName,
  orgLogoUrl,
  recipientName,
  kind,
  homeName,
  studioName,
  studioAddress,
  consultantName,
  windowText,
  previousWindowText,
  deadlines,
  reason,
  actionHref,
  actionLabel,
}: DesignStudioAppointmentEmailProps) {
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,"
  const summary =
    kind === "booked"
      ? "Your design studio appointment is booked. Bring any inspiration you have; your consultant will walk you through every choice."
      : kind === "rescheduled"
        ? "Your design studio appointment has moved to a new time. Your selection deadlines have not changed."
        : "Your design studio appointment has been canceled. Your selection deadlines have not changed, so please book another time soon."
  const dated = deadlines.filter((deadline) => deadline.cutoffText)

  return (
    <EmailLayout preview={`${EVENT_LABEL[kind]}: ${windowText}`} subtitle="Design studio" orgName={orgName} orgLogoUrl={orgLogoUrl}>
      <Text style={eventLabelText}>{EVENT_LABEL[kind]}</Text>
      <Heading style={heading}>{studioName}</Heading>
      <Text style={subjectText}>{homeName ?? "Your new home"}</Text>

      <Text style={paragraph}>{greeting}</Text>
      <Text style={paragraph}>{summary}</Text>

      <Section style={metaCard}>
        <Text style={metaRow}>
          <span style={metaLabel}>{kind === "canceled" ? "Was scheduled:" : "When:"}</span> <span style={metaValue}>{windowText}</span>
        </Text>
        {previousWindowText && kind === "rescheduled" ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Previously:</span> <span style={metaValue}>{previousWindowText}</span>
          </Text>
        ) : null}
        {studioAddress ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Where:</span> <span style={metaValue}>{studioAddress}</span>
          </Text>
        ) : null}
        {consultantName && kind !== "canceled" ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Consultant:</span> <span style={metaValue}>{consultantName}</span>
          </Text>
        ) : null}
      </Section>

      {dated.length > 0 ? (
        <Section style={contentCard}>
          <Text style={contentLabel}>Your selection deadlines</Text>
          {dated.map((deadline) => (
            <Text key={deadline.name} style={contentText}>
              {deadline.name}: {deadline.cutoffText}
            </Text>
          ))}
        </Section>
      ) : null}

      {reason ? (
        <Section style={contentCard}>
          <Text style={contentLabel}>Note</Text>
          <Text style={contentText}>{reason}</Text>
        </Section>
      ) : null}

      {actionHref && actionLabel ? (
        <>
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
        </>
      ) : null}
    </EmailLayout>
  )
}

export default DesignStudioAppointmentEmail
