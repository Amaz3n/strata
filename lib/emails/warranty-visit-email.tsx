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

export interface WarrantyVisitEmailProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  recipientName?: string | null
  audience: "buyer" | "trade"
  kind: "scheduled" | "rescheduled" | "canceled"
  projectName?: string | null
  address?: string | null
  requestTitle: string
  /** Already rendered at the house's wall-clock time, zone included. */
  windowText: string
  previousWindowText?: string | null
  note?: string | null
  actionHref?: string | null
  actionLabel?: string | null
}

const EVENT_LABEL = {
  scheduled: "Appointment Scheduled",
  rescheduled: "Appointment Moved",
  canceled: "Appointment Canceled",
} as const

export function WarrantyVisitEmail({
  orgName,
  orgLogoUrl,
  recipientName,
  audience,
  kind,
  projectName,
  address,
  requestTitle,
  windowText,
  previousWindowText,
  note,
  actionHref,
  actionLabel,
}: WarrantyVisitEmailProps) {
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,"
  const summary =
    kind === "scheduled"
      ? audience === "buyer"
        ? "We have scheduled warranty service at your home. Please confirm the time or tell us what works better."
        : "You have been assigned warranty service. Please confirm the appointment."
      : kind === "rescheduled"
        ? audience === "buyer"
          ? "Your warranty service appointment has moved to a new time. Please confirm it or tell us what works better."
          : "A warranty service appointment you are assigned to has moved. Please confirm the new time."
        : "This warranty service appointment has been canceled. We will be in touch if it is rescheduled."

  return (
    <EmailLayout preview={`${EVENT_LABEL[kind]}: ${requestTitle}`} subtitle="Warranty service" orgName={orgName} orgLogoUrl={orgLogoUrl}>
      <Text style={eventLabelText}>{EVENT_LABEL[kind]}</Text>
      <Heading style={heading}>{requestTitle}</Heading>
      <Text style={subjectText}>{projectName ?? "Warranty service"}</Text>

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
        {address ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Address:</span> <span style={metaValue}>{address}</span>
          </Text>
        ) : null}
      </Section>

      {note ? (
        <Section style={contentCard}>
          <Text style={contentLabel}>Note</Text>
          <Text style={contentText}>{note}</Text>
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

export default WarrantyVisitEmail
