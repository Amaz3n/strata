import { Button, Heading, Link, Section, Text } from "@react-email/components"

import { EmailLayout } from "./email-layout"
import {
  button,
  buttonWrap,
  fallbackText,
  heading,
  link,
  paragraph,
} from "./theme"

export interface VendorBillDecisionEmailProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  kind: "approved" | "rejected"
  /** "invoice 1042" or "your invoice" — matches the subject line's phrasing. */
  invoiceLabel: string
  projectName: string | null
  reason?: string | null
  actionHref?: string
}

export function VendorBillDecisionEmail({
  orgName,
  orgLogoUrl,
  kind,
  invoiceLabel,
  projectName,
  reason,
  actionHref,
}: VendorBillDecisionEmailProps) {
  const displayOrgName = orgName ?? "Your customer"
  const approved = kind === "approved"
  const onProject = projectName ? ` on ${projectName}` : ""

  return (
    <EmailLayout
      preview={approved ? `${invoiceLabel} was approved for payment` : `${invoiceLabel} was not accepted`}
      subtitle="Invoice Decision"
      orgName={orgName}
      orgLogoUrl={orgLogoUrl}
    >
      <Heading style={heading}>{approved ? "Invoice approved" : "Invoice not accepted"}</Heading>

      {approved ? (
        <Text style={paragraph}>
          {displayOrgName} approved {invoiceLabel}
          {onProject} for payment. You will get a separate notice when the payment is sent.
        </Text>
      ) : (
        <>
          <Text style={paragraph}>
            {displayOrgName} could not accept {invoiceLabel}
            {onProject}.
          </Text>
          {reason ? (
            <Section style={reasonCard}>
              <Text style={reasonLabel}>Reason given</Text>
              <Text style={reasonText}>{reason}</Text>
            </Section>
          ) : null}
          <Text style={paragraph}>
            Correct it and submit again — you do not need to start a new contract or purchase order.
          </Text>
        </>
      )}

      {actionHref ? (
        <>
          <Section style={buttonWrap}>
            <Button style={button} href={actionHref}>
              View your invoices
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

const reasonCard: React.CSSProperties = {
  margin: "16px 0",
  padding: "14px 16px",
  border: "1px solid #e1e1e1",
  backgroundColor: "#fafafa",
}

const reasonLabel: React.CSSProperties = {
  margin: "0 0 8px 0",
  color: "#626262",
  fontWeight: 700,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const reasonText: React.CSSProperties = {
  margin: "0",
  color: "#222222",
  fontSize: "14px",
  lineHeight: "1.6",
  whiteSpace: "pre-wrap",
}

export default VendorBillDecisionEmail
