import { Body, Button, Container, Head, Heading, Hr, Html, Img, Link, Preview, Section, Text } from "@react-email/components"

export type PaymentRunEmailKind = "awaiting" | "approved" | "rejected" | "recorded"

export type PaymentRunEmailLine = {
  vendorName: string
  /** "Invoice 1042" or "Invoice —" when the vendor did not number it. */
  billLabel: string
  projectName?: string | null
  amountLabel: string
}

export interface PaymentRunApprovalEmailProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  recipientName?: string | null
  kind: PaymentRunEmailKind
  /** Everything that leaves the funding bank: vendor money plus every fee. */
  totalDebitLabel: string
  /** What the vendors actually receive, when it differs from the debit. */
  vendorAmountLabel?: string | null
  feeLabel?: string | null
  paymentCount: number
  vendorCount: number
  /** Who built the run. An approver has to know whose work they are checking. */
  preparerName?: string | null
  fundingLabel?: string | null
  scheduledLabel?: string | null
  approvalsRequired?: number | null
  approvalsRecorded?: number | null
  lines: PaymentRunEmailLine[]
  /** Bills beyond the ones listed, so the list never reads as the whole run. */
  remainingCount: number
  /** Populated on a rejection. */
  reason?: string | null
  actionUrl: string
}

const KIND_LABEL: Record<PaymentRunEmailKind, string> = {
  awaiting: "Approval Required",
  approved: "Payment Released",
  rejected: "Payment Rejected",
  recorded: "Approval Recorded",
}

export function PaymentRunApprovalEmail({
  orgName,
  orgLogoUrl,
  recipientName,
  kind = "awaiting",
  totalDebitLabel = "$0.00",
  vendorAmountLabel = null,
  feeLabel = null,
  paymentCount = 0,
  vendorCount = 0,
  preparerName = null,
  fundingLabel = null,
  scheduledLabel = null,
  approvalsRequired = null,
  approvalsRecorded = null,
  lines = [],
  remainingCount = 0,
  reason = null,
  actionUrl = "#",
}: PaymentRunApprovalEmailProps) {
  const displayOrgName = orgName ?? "Arc"
  const greeting = recipientName ? `Hi ${recipientName},` : "Hello,"
  const billsLabel = `${paymentCount} bill${paymentCount === 1 ? "" : "s"}`
  const vendorsLabel = `${vendorCount} vendor${vendorCount === 1 ? "" : "s"}`
  const dualApproval = (approvalsRequired ?? 1) > 1

  const heading =
    kind === "awaiting"
      ? `Release ${totalDebitLabel}?`
      : kind === "approved"
        ? `${totalDebitLabel} released`
        : kind === "rejected"
          ? `${totalDebitLabel} was not released`
          : `Approval recorded on ${totalDebitLabel}`

  const heroMeta =
    kind === "awaiting"
      ? `${billsLabel} to ${vendorsLabel}. Nothing leaves the bank until this run has every approval it needs.`
      : kind === "approved"
        ? `${billsLabel} to ${vendorsLabel} are on their way. Vendors are paid on the provider's normal ACH timing.`
        : kind === "rejected"
          ? `${billsLabel} to ${vendorsLabel} stayed put. No money moved and the payables are back in the queue.`
          : `${billsLabel} to ${vendorsLabel}. This run still needs another approval before it can release.`

  return (
    <Html>
      <Head />
      <Preview>{`${heading} · ${billsLabel} · ${displayOrgName}`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            {orgLogoUrl ? (
              <Img src={orgLogoUrl} alt={displayOrgName} width="56" height="56" style={logoImage} />
            ) : (
              <Text style={logoFallback}>{displayOrgName.slice(0, 1).toUpperCase()}</Text>
            )}
            <Text style={brandName}>{displayOrgName}</Text>
            <Text style={brandSub}>Arc Pay · {KIND_LABEL[kind]}</Text>
          </Section>

          <Section style={kind === "rejected" ? heroMuted : kind === "awaiting" ? heroAction : hero}>
            <Text style={heroKicker}>{KIND_LABEL[kind]}</Text>
            <Heading style={heroHeading}>{heading}</Heading>
            <Text style={heroMetaStyle}>{heroMeta}</Text>
          </Section>

          <Section style={content}>
            <Text style={paragraph}>{greeting}</Text>

            <Section style={sectionCard}>
              <Text style={sectionTitle}>The Run</Text>
              <table style={factTable} cellPadding={0} cellSpacing={0} role="presentation">
                <tbody>
                  <tr>
                    <td style={factLabelCell}>Debited from your bank</td>
                    <td style={factValueCellStrong} align="right">
                      {totalDebitLabel}
                    </td>
                  </tr>
                  {vendorAmountLabel ? (
                    <tr>
                      <td style={factLabelCell}>Paid to vendors</td>
                      <td style={factValueCell} align="right">
                        {vendorAmountLabel}
                      </td>
                    </tr>
                  ) : null}
                  {feeLabel ? (
                    <tr>
                      <td style={factLabelCell}>Fees</td>
                      <td style={factValueCell} align="right">
                        {feeLabel}
                      </td>
                    </tr>
                  ) : null}
                  <tr>
                    <td style={factLabelCell}>Bills / vendors</td>
                    <td style={factValueCell} align="right">
                      {billsLabel} · {vendorsLabel}
                    </td>
                  </tr>
                  {preparerName ? (
                    <tr>
                      <td style={factLabelCell}>Prepared by</td>
                      <td style={factValueCell} align="right">
                        {preparerName}
                      </td>
                    </tr>
                  ) : null}
                  {fundingLabel ? (
                    <tr>
                      <td style={factLabelCell}>Funding bank</td>
                      <td style={factValueCell} align="right">
                        {fundingLabel}
                      </td>
                    </tr>
                  ) : null}
                  {scheduledLabel ? (
                    <tr>
                      <td style={factLabelCell}>Scheduled for</td>
                      <td style={factValueCell} align="right">
                        {scheduledLabel}
                      </td>
                    </tr>
                  ) : null}
                  {approvalsRequired ? (
                    <tr>
                      <td style={factLabelCellLast}>Approvals</td>
                      <td style={factValueCellLast} align="right">
                        {approvalsRecorded ?? 0} of {approvalsRequired}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </Section>

            {reason ? (
              <Section style={reasonCard}>
                <Text style={reasonLabel}>Reason given</Text>
                <Text style={reasonText}>{reason}</Text>
              </Section>
            ) : null}

            {lines.length > 0 ? (
              <Section style={sectionCard}>
                <Text style={sectionTitle}>What Is In It</Text>
                <table style={lineTable} cellPadding={0} cellSpacing={0} role="presentation">
                  <tbody>
                    {lines.map((line, index) => (
                      <tr key={`${line.vendorName}-${line.billLabel}-${index}`}>
                        <td style={index === lines.length - 1 ? lineCellLast : lineCell}>
                          <Text style={lineVendor}>{line.vendorName}</Text>
                          <Text style={lineMeta}>
                            {line.billLabel}
                            {line.projectName ? ` · ${line.projectName}` : ""}
                          </Text>
                        </td>
                        <td style={index === lines.length - 1 ? lineAmountCellLast : lineAmountCell} align="right">
                          <span style={lineAmount}>{line.amountLabel}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {remainingCount > 0 ? (
                  <Text style={moreNote}>
                    + {remainingCount} more bill{remainingCount === 1 ? "" : "s"} in this run.
                  </Text>
                ) : null}
              </Section>
            ) : null}

            {kind === "awaiting" ? (
              <Section style={attestCard}>
                <Text style={attestTitle}>What approving means</Text>
                <Text style={attestText}>
                  • The vendors above are the ones you meant to pay, at the amounts shown.
                </Text>
                <Text style={attestText}>
                  • You are not aware of a payout bank change, an emailed &ldquo;new account&rdquo; notice, or a
                  vendor request you have not confirmed by phone on a number you already had.
                </Text>
                <Text style={attestText}>
                  • {totalDebitLabel} will be debited from {fundingLabel ?? "the funding bank"} once this run has
                  every approval. ACH debits cannot be recalled the way a check can be stopped.
                </Text>
                {dualApproval ? (
                  <Text style={attestText}>
                    • This organization requires {approvalsRequired} approvals, and the person who built the run is
                    never one of them.
                  </Text>
                ) : null}
              </Section>
            ) : null}

            <Section style={buttonWrap}>
              <Button style={kind === "awaiting" ? button : buttonQuiet} href={actionUrl}>
                {kind === "awaiting" ? "Review and decide" : "Open the payable"}
              </Button>
            </Section>

            <Text style={fallbackText}>
              {kind === "awaiting" ? (
                <>
                  Decisions are recorded in Arc, never by replying to this email. If the button does not open,{" "}
                  <Link href={actionUrl} style={link}>
                    open it directly
                  </Link>
                  .
                </>
              ) : (
                <Link href={actionUrl} style={link}>
                  Open it directly
                </Link>
              )}
            </Text>
          </Section>

          <Hr style={hr} />
          <Section style={footer}>
            <Text style={footerText}>Sent via Arc · {displayOrgName} vendor payments</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = {
  backgroundColor: "#e9edf5",
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, Arial, sans-serif',
  margin: "0",
  padding: "24px 0",
}

const container: React.CSSProperties = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  maxWidth: "680px",
  border: "1px solid #dcdcdc",
}

const header: React.CSSProperties = {
  textAlign: "center",
  padding: "34px 40px 20px 40px",
  borderBottom: "1px solid #ebebeb",
}

const logoImage: React.CSSProperties = {
  border: "1px solid #d6d6d6",
  backgroundColor: "#ffffff",
  display: "block",
  margin: "0 auto",
  padding: "6px",
  width: "56px",
  height: "56px",
  objectFit: "contain",
}

const logoFallback: React.CSSProperties = {
  margin: "0 auto",
  width: "56px",
  height: "56px",
  display: "block",
  textAlign: "center",
  lineHeight: "56px",
  border: "1px solid #d6d6d6",
  backgroundColor: "#fff",
  color: "#111111",
  fontWeight: 700,
  fontSize: "18px",
}

const brandName: React.CSSProperties = {
  margin: "12px 0 0 0",
  color: "#111111",
  fontSize: "15px",
  fontWeight: 700,
}

const brandSub: React.CSSProperties = {
  margin: "4px 0 0 0",
  color: "#1f5ecf",
  fontSize: "11px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "1px",
}

const hero: React.CSSProperties = {
  backgroundColor: "#0f4fc5",
  color: "#f5f7f9",
  padding: "26px 32px",
  borderBottom: "1px solid #d6e2fb",
}

const heroAction: React.CSSProperties = {
  ...hero,
  backgroundColor: "#0b3a94",
}

const heroMuted: React.CSSProperties = {
  ...hero,
  backgroundColor: "#3f4654",
  borderBottom: "1px solid #d7dae0",
}

const heroKicker: React.CSSProperties = {
  margin: "0 0 10px 0",
  color: "#c8d9fb",
  fontSize: "11px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "1px",
}

const heroHeading: React.CSSProperties = {
  margin: "0",
  color: "#f5f7f9",
  fontSize: "30px",
  lineHeight: "1.1",
  fontWeight: 700,
  letterSpacing: "-0.8px",
}

const heroMetaStyle: React.CSSProperties = {
  margin: "12px 0 0 0",
  color: "#dce6ff",
  fontSize: "13px",
  lineHeight: "1.5",
}

const content: React.CSSProperties = {
  padding: "24px 32px 30px 32px",
}

const paragraph: React.CSSProperties = {
  margin: "0 0 12px 0",
  color: "#2f2f2f",
  fontSize: "14px",
  lineHeight: "1.6",
}

const sectionCard: React.CSSProperties = {
  marginTop: "16px",
  border: "1px solid #e3e3e3",
  backgroundColor: "#ffffff",
}

const sectionTitle: React.CSSProperties = {
  margin: "0",
  padding: "12px 14px",
  borderBottom: "1px solid #deebff",
  backgroundColor: "#f4f8ff",
  color: "#1f5ecf",
  fontSize: "12px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const factTable: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
}

const factLabelCell: React.CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid #eaecf0",
  color: "#475467",
  fontSize: "13px",
  verticalAlign: "middle",
}

const factLabelCellLast: React.CSSProperties = {
  ...factLabelCell,
  borderBottom: "none",
}

const factValueCell: React.CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid #eaecf0",
  color: "#101828",
  fontSize: "13px",
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
  textAlign: "right",
  verticalAlign: "middle",
}

const factValueCellLast: React.CSSProperties = {
  ...factValueCell,
  borderBottom: "none",
}

const factValueCellStrong: React.CSSProperties = {
  ...factValueCell,
  color: "#0f4fc5",
  fontSize: "18px",
  fontWeight: 700,
  letterSpacing: "-0.3px",
}

const lineTable: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
}

const lineCell: React.CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid #eaecf0",
  verticalAlign: "top",
}

const lineCellLast: React.CSSProperties = {
  ...lineCell,
  borderBottom: "none",
}

const lineAmountCell: React.CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid #eaecf0",
  verticalAlign: "top",
  textAlign: "right",
  width: "120px",
}

const lineAmountCellLast: React.CSSProperties = {
  ...lineAmountCell,
  borderBottom: "none",
}

const lineVendor: React.CSSProperties = {
  margin: "0",
  color: "#101828",
  fontSize: "13px",
  fontWeight: 700,
  lineHeight: "1.4",
}

const lineMeta: React.CSSProperties = {
  margin: "2px 0 0 0",
  color: "#667085",
  fontSize: "12px",
  lineHeight: "1.4",
}

const lineAmount: React.CSSProperties = {
  color: "#101828",
  fontSize: "13px",
  fontWeight: 700,
  fontVariantNumeric: "tabular-nums",
}

const moreNote: React.CSSProperties = {
  margin: "0",
  padding: "10px 14px",
  borderTop: "1px solid #eaecf0",
  backgroundColor: "#fcfcfd",
  color: "#475467",
  fontSize: "12px",
}

const attestCard: React.CSSProperties = {
  marginTop: "16px",
  border: "1px solid #fedf89",
  backgroundColor: "#fffaeb",
  padding: "12px 14px",
}

const attestTitle: React.CSSProperties = {
  margin: "0 0 8px 0",
  color: "#b54708",
  fontSize: "11px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const attestText: React.CSSProperties = {
  margin: "0 0 6px 0",
  color: "#7a4708",
  fontSize: "12px",
  lineHeight: "1.55",
}

const reasonCard: React.CSSProperties = {
  marginTop: "16px",
  padding: "12px 14px",
  border: "1px solid #e1e1e1",
  backgroundColor: "#fafafa",
}

const reasonLabel: React.CSSProperties = {
  margin: "0 0 6px 0",
  color: "#626262",
  fontWeight: 700,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const reasonText: React.CSSProperties = {
  margin: "0",
  color: "#222222",
  fontSize: "13px",
  lineHeight: "1.6",
  whiteSpace: "pre-wrap",
}

const buttonWrap: React.CSSProperties = {
  textAlign: "center",
  marginTop: "22px",
}

const button: React.CSSProperties = {
  backgroundColor: "#0f4fc5",
  color: "#ffffff",
  borderRadius: "0",
  padding: "13px 26px",
  fontSize: "13px",
  fontWeight: 700,
  textDecoration: "none",
  textTransform: "uppercase",
  letterSpacing: "0.6px",
}

const buttonQuiet: React.CSSProperties = {
  ...button,
  backgroundColor: "#ffffff",
  color: "#0f4fc5",
  border: "1px solid #0f4fc5",
}

const fallbackText: React.CSSProperties = {
  margin: "14px 0 0 0",
  color: "#676767",
  fontSize: "12px",
  lineHeight: "1.5",
  textAlign: "center",
}

const link: React.CSSProperties = {
  color: "#0f4fc5",
  textDecoration: "underline",
}

const hr: React.CSSProperties = {
  borderColor: "#e6e6e6",
  margin: "0",
}

const footer: React.CSSProperties = {
  padding: "16px 32px 20px 32px",
  textAlign: "center",
}

const footerText: React.CSSProperties = {
  margin: "0",
  color: "#7c7c7c",
  fontSize: "12px",
  textAlign: "center",
}

export default PaymentRunApprovalEmail
