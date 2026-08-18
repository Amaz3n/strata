import { Body, Button, Container, Head, Heading, Hr, Html, Img, Link, Preview, Section, Text } from "@react-email/components"

/**
 * A bank account changed and a second human has to look at it.
 *
 * - `funding_review`     someone added or changed the bank Arc debits, and it
 *                        needs an independent approval before it can be used
 * - `payout_destination` a vendor's payout bank changed, so payments to them
 *                        are frozen for a cooling period
 *
 * Both are the classic payment-fraud vector, so neither variant ever offers a
 * one-click "approve" from the email — the decision is made in Arc, by someone
 * who signed in.
 */
export type BankChangeKind = "funding_review" | "payout_destination"

export interface BankChangeReviewEmailProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  recipientName?: string | null
  kind: BankChangeKind
  /** "First National ···· 4821" — masked only, never a full account number. */
  bankLabel?: string | null
  previousBankLabel?: string | null
  /** Vendor whose payout account changed; absent for a funding-bank review. */
  vendorName?: string | null
  requestedByName?: string | null
  /** When the hold lifts, or when the funding bank becomes usable. */
  effectiveLabel?: string | null
  actionUrl: string
}

export function BankChangeReviewEmail({
  orgName,
  orgLogoUrl,
  recipientName,
  kind = "funding_review",
  bankLabel = null,
  previousBankLabel = null,
  vendorName = null,
  requestedByName = null,
  effectiveLabel = null,
  actionUrl = "#",
}: BankChangeReviewEmailProps) {
  const displayOrgName = orgName ?? "Arc"
  const greeting = recipientName ? `Hi ${recipientName},` : "Hello,"
  const funding = kind === "funding_review"

  const kicker = funding ? "Funding Bank Review" : "Payout Bank Changed"
  const heading = funding
    ? "A funding bank needs your approval"
    : `${vendorName ?? "A vendor"}'s payout bank changed`
  const lead = funding
    ? "Nothing can be debited from this account until a second person approves it. Approving it makes it the account Arc Pay runs draw from."
    : "Payments to this vendor are frozen for a cooling period. If the vendor did not tell you about this change through a channel you already trusted, treat it as fraud until proven otherwise."

  const checks = funding
    ? [
        "You know who added this account and why.",
        "The masked digits match a bank statement or voided check you already have — not one that arrived with the request.",
        "You did not learn about this change from an inbound email, text, or call.",
      ]
    : [
        "Call the vendor on a number you already had on file. Not a number in any recent email.",
        "Ask them to confirm the change and the last four digits. Do not read the digits to them first.",
        "If they did not make the change, keep the hold and tell Arc support before it expires.",
      ]

  return (
    <Html>
      <Head />
      <Preview>{`${heading} · ${displayOrgName}`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            {orgLogoUrl ? (
              <Img src={orgLogoUrl} alt={displayOrgName} width="56" height="56" style={logoImage} />
            ) : (
              <Text style={logoFallback}>{displayOrgName.slice(0, 1).toUpperCase()}</Text>
            )}
            <Text style={brandName}>{displayOrgName}</Text>
            <Text style={brandSub}>Arc Pay · {kicker}</Text>
          </Section>

          <Section style={hero}>
            <Text style={heroKicker}>{kicker}</Text>
            <Heading style={heroHeading}>{heading}</Heading>
            <Text style={heroMeta}>{lead}</Text>
          </Section>

          <Section style={content}>
            <Text style={paragraph}>{greeting}</Text>

            <Section style={sectionCard}>
              <Text style={sectionTitle}>The Change</Text>
              <table style={factTable} cellPadding={0} cellSpacing={0} role="presentation">
                <tbody>
                  {vendorName ? (
                    <tr>
                      <td style={factLabelCell}>Vendor</td>
                      <td style={factValueCell} align="right">
                        {vendorName}
                      </td>
                    </tr>
                  ) : null}
                  <tr>
                    <td style={factLabelCell}>New account</td>
                    <td style={factValueCellStrong} align="right">
                      {bankLabel ?? "—"}
                    </td>
                  </tr>
                  {previousBankLabel ? (
                    <tr>
                      <td style={factLabelCell}>Previous account</td>
                      <td style={factValueCell} align="right">
                        {previousBankLabel}
                      </td>
                    </tr>
                  ) : null}
                  {requestedByName ? (
                    <tr>
                      <td style={factLabelCell}>Requested by</td>
                      <td style={factValueCell} align="right">
                        {requestedByName}
                      </td>
                    </tr>
                  ) : null}
                  <tr>
                    <td style={factLabelCellLast}>{funding ? "Usable from" : "Hold lifts"}</td>
                    <td style={factValueCellLast} align="right">
                      {effectiveLabel ?? "After review"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </Section>

            <Section style={checkCard}>
              <Text style={checkTitle}>Before you decide</Text>
              {checks.map((check, index) => (
                <Text key={`check-${index}`} style={checkText}>
                  • {check}
                </Text>
              ))}
              <Text style={checkTextStrong}>
                Arc only ever shows the last four digits. Anyone asking you to send or confirm a full account or
                routing number by email is not Arc.
              </Text>
            </Section>

            <Section style={buttonWrap}>
              <Button style={button} href={actionUrl}>
                {funding ? "Review in Arc" : "Open vendor in Arc"}
              </Button>
            </Section>

            <Text style={fallbackText}>
              Decisions are recorded in Arc, never by replying to this email. If the button does not open,{" "}
              <Link href={actionUrl} style={link}>
                open it directly
              </Link>
              .
            </Text>
          </Section>

          <Hr style={hr} />
          <Section style={footer}>
            <Text style={footerText}>Sent via Arc · {displayOrgName} payment controls</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = {
  backgroundColor: "#f2eee2",
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
  color: "#b54708",
  fontSize: "11px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "1px",
}

const hero: React.CSSProperties = {
  backgroundColor: "#7a3c07",
  color: "#fff8ee",
  padding: "26px 32px",
  borderBottom: "1px solid #f0d9b5",
}

const heroKicker: React.CSSProperties = {
  margin: "0 0 10px 0",
  color: "#f6dcb4",
  fontSize: "11px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "1px",
}

const heroHeading: React.CSSProperties = {
  margin: "0",
  color: "#fff8ee",
  fontSize: "28px",
  lineHeight: "1.15",
  fontWeight: 700,
  letterSpacing: "-0.6px",
}

const heroMeta: React.CSSProperties = {
  margin: "12px 0 0 0",
  color: "#f3e0c4",
  fontSize: "13px",
  lineHeight: "1.55",
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
  borderBottom: "1px solid #f4e3c8",
  backgroundColor: "#fffaeb",
  color: "#b54708",
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
  color: "#b54708",
  fontSize: "17px",
  fontWeight: 700,
  letterSpacing: "-0.2px",
}

const checkCard: React.CSSProperties = {
  marginTop: "16px",
  border: "1px solid #fedf89",
  backgroundColor: "#fffaeb",
  padding: "12px 14px",
}

const checkTitle: React.CSSProperties = {
  margin: "0 0 8px 0",
  color: "#b54708",
  fontSize: "11px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const checkText: React.CSSProperties = {
  margin: "0 0 6px 0",
  color: "#7a4708",
  fontSize: "12px",
  lineHeight: "1.55",
}

const checkTextStrong: React.CSSProperties = {
  ...checkText,
  marginTop: "10px",
  marginBottom: "0",
  fontWeight: 700,
}

const buttonWrap: React.CSSProperties = {
  textAlign: "center",
  marginTop: "22px",
}

const button: React.CSSProperties = {
  backgroundColor: "#b54708",
  color: "#ffffff",
  borderRadius: "0",
  padding: "13px 26px",
  fontSize: "13px",
  fontWeight: 700,
  textDecoration: "none",
  textTransform: "uppercase",
  letterSpacing: "0.6px",
}

const fallbackText: React.CSSProperties = {
  margin: "14px 0 0 0",
  color: "#676767",
  fontSize: "12px",
  lineHeight: "1.5",
  textAlign: "center",
}

const link: React.CSSProperties = {
  color: "#b54708",
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

export default BankChangeReviewEmail
