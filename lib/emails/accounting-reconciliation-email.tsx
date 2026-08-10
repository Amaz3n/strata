import { Body, Button, Container, Head, Heading, Hr, Html, Img, Link, Preview, Section, Text } from "@react-email/components"

export type ReconciliationEmailSeverity = "critical" | "warning" | "info"

export type ReconciliationEmailFinding = {
  label: string
  severity: ReconciliationEmailSeverity
  description: string
  /** Project name when the finding belongs to one; org-wide findings have none. */
  projectName?: string | null
  amountLabel?: string | null
  href?: string | null
}

export type ReconciliationEmailGroup = {
  label: string
  severity: ReconciliationEmailSeverity
  countLabel: string
  amountLabel?: string | null
}

export interface AccountingReconciliationEmailProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  recipientName?: string | null
  runDateLabel: string
  headline: string
  /** New / Open / Critical / Unexplained money / Cleared — five at most, they sit in one row. */
  metrics: Array<{ label: string; value: string; tone?: ReconciliationEmailSeverity | "neutral" }>
  findings: ReconciliationEmailFinding[]
  /** How many findings exist beyond the ones listed, so the list never reads as the whole queue. */
  remainingCount: number
  groups: ReconciliationEmailGroup[]
  coverageNotes: string[]
  queueUrl: string
}

const SEVERITY_LABEL: Record<ReconciliationEmailSeverity, string> = {
  critical: "Critical",
  warning: "Review",
  info: "Info",
}

export function AccountingReconciliationEmail({
  orgName,
  orgLogoUrl,
  recipientName,
  runDateLabel = "Nightly pass · Aug 8, 2026",
  headline = "24 new findings",
  metrics = [],
  findings = [],
  remainingCount = 0,
  groups = [],
  coverageNotes = [],
  queueUrl = "#",
}: AccountingReconciliationEmailProps) {
  const displayOrgName = orgName ?? "Arc"
  const greeting = recipientName ? `Hi ${recipientName},` : "Hello,"
  const criticalFindings = findings.filter((finding) => finding.severity === "critical").length
  const previewText = `${headline} · ${displayOrgName} accounting reconciliation`

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            {orgLogoUrl ? (
              <Img src={orgLogoUrl} alt={displayOrgName} width="56" height="56" style={logoImage} />
            ) : (
              <Text style={logoFallback}>{displayOrgName.slice(0, 1).toUpperCase()}</Text>
            )}
            <Text style={brandName}>{displayOrgName}</Text>
            <Text style={brandSub}>Accounting Reconciliation</Text>
          </Section>

          <Section style={hero}>
            <Text style={heroKicker}>{runDateLabel}</Text>
            <Heading style={heroHeading}>{headline}</Heading>
            <Text style={heroMeta}>
              {criticalFindings > 0
                ? "Findings marked critical mean the books are currently wrong, not just unproven. Those are listed first."
                : "Nothing critical in this pass. The items below are unproven rather than known-wrong."}
            </Text>
          </Section>

          <Section style={content}>
            <Text style={paragraph}>{greeting}</Text>
            <Text style={paragraph}>
              The nightly reconciliation compared Arc against your bank, your payment rails, and your accounting system.
              Here is what it could not tie out.
            </Text>

            {metrics.length > 0 ? (
              <Section style={sectionCard}>
                <Text style={sectionTitle}>This Pass</Text>
                <table style={metricsTable} cellPadding={0} cellSpacing={0} role="presentation">
                  <tbody>
                    <tr>
                      {metrics.slice(0, 5).map((metric, index) => (
                        <td
                          key={metric.label}
                          style={index === Math.min(metrics.length, 5) - 1 ? metricCellLast : metricCell}
                        >
                          <Text style={metricLabel}>{metric.label}</Text>
                          <Text style={metric.tone === "critical" ? metricValueCritical : metricValue}>
                            {metric.value}
                          </Text>
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </Section>
            ) : null}

            <Section style={sectionCard}>
              <Text style={sectionTitle}>Take These First</Text>
              <table style={findingTable} cellPadding={0} cellSpacing={0} role="presentation">
                <tbody>
                  {findings.map((finding, index) => (
                    <tr key={`${finding.label}-${index}`}>
                      <td style={index === findings.length - 1 ? findingCellLast : findingCell}>
                        <Text style={findingHeadRow}>
                          <span style={severityChip(finding.severity)}>{SEVERITY_LABEL[finding.severity]}</span>
                          <span style={findingLabel}>{finding.label}</span>
                        </Text>
                        <Text style={findingDescription}>{finding.description}</Text>
                        <Text style={findingMeta}>
                          {finding.projectName ? <span style={findingProject}>{finding.projectName}</span> : null}
                          {finding.projectName && finding.amountLabel ? <span style={metaDivider}> · </span> : null}
                          {finding.amountLabel ? <span style={findingAmount}>{finding.amountLabel} unexplained</span> : null}
                          {(finding.projectName || finding.amountLabel) && finding.href ? (
                            <span style={metaDivider}> · </span>
                          ) : null}
                          {finding.href ? (
                            <Link href={finding.href} style={link}>
                              Open the record
                            </Link>
                          ) : null}
                        </Text>
                      </td>
                    </tr>
                  ))}
                  {findings.length === 0 ? (
                    <tr>
                      <td style={findingCellLast}>
                        <Text style={findingDescription}>No open findings carry detail for this pass.</Text>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
              {remainingCount > 0 ? (
                <Text style={moreNote}>
                  + {remainingCount} more open finding{remainingCount === 1 ? "" : "s"} in the queue.
                </Text>
              ) : null}
            </Section>

            {groups.length > 0 ? (
              <Section style={sectionCard}>
                <Text style={sectionTitle}>Everything Open, By Type</Text>
                <table style={groupTable} cellPadding={0} cellSpacing={0} role="presentation">
                  <tbody>
                    {groups.map((group, index) => (
                      <tr key={group.label}>
                        <td style={index === groups.length - 1 ? groupCellLast : groupCell}>
                          <span style={severityDot(group.severity)} />
                          <span style={groupLabel}>{group.label}</span>
                        </td>
                        <td style={index === groups.length - 1 ? groupNumberCellLast : groupNumberCell} align="right">
                          <span style={groupCount}>{group.countLabel}</span>
                        </td>
                        <td style={index === groups.length - 1 ? groupNumberCellLast : groupNumberCell} align="right">
                          <span style={groupAmount}>{group.amountLabel ?? "—"}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Section>
            ) : null}

            {coverageNotes.length > 0 ? (
              <Section style={coverageCard}>
                <Text style={coverageTitle}>What this pass did not cover</Text>
                {coverageNotes.map((note, index) => (
                  <Text key={`coverage-${index}`} style={coverageText}>
                    • {note}
                  </Text>
                ))}
              </Section>
            ) : null}

            <Section style={buttonWrap}>
              <Button style={button} href={queueUrl}>
                Open the finding queue
              </Button>
            </Section>

            <Text style={fallbackText}>
              Each finding can be resolved, explained, or ignored from{" "}
              <Link href={queueUrl} style={link}>
                Books · Period close
              </Link>
              . Explaining one keeps it out of tomorrow&apos;s email unless the amount changes.
            </Text>
          </Section>

          <Hr style={hr} />
          <Section style={footer}>
            <Text style={footerText}>Sent via Arc · You receive this because you can reconcile the books for {displayOrgName}.</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

const SEVERITY_COLOR: Record<ReconciliationEmailSeverity, string> = {
  critical: "#b42318",
  warning: "#b54708",
  info: "#475467",
}

const SEVERITY_BACKGROUND: Record<ReconciliationEmailSeverity, string> = {
  critical: "#fef3f2",
  warning: "#fffaeb",
  info: "#f2f4f7",
}

function severityChip(severity: ReconciliationEmailSeverity): React.CSSProperties {
  return {
    display: "inline-block",
    marginRight: "8px",
    padding: "2px 6px",
    backgroundColor: SEVERITY_BACKGROUND[severity],
    color: SEVERITY_COLOR[severity],
    border: `1px solid ${SEVERITY_COLOR[severity]}33`,
    fontSize: "10px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.6px",
  }
}

function severityDot(severity: ReconciliationEmailSeverity): React.CSSProperties {
  return {
    display: "inline-block",
    width: "8px",
    height: "8px",
    marginRight: "8px",
    borderRadius: "9999px",
    backgroundColor: SEVERITY_COLOR[severity],
  }
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

const heroMeta: React.CSSProperties = {
  margin: "12px 0 0 0",
  color: "#d5e2ff",
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

const metricsTable: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  tableLayout: "fixed",
}

const metricCell: React.CSSProperties = {
  padding: "12px",
  borderRight: "1px solid #eaecf0",
  verticalAlign: "top",
}

const metricCellLast: React.CSSProperties = {
  padding: "12px",
  verticalAlign: "top",
}

const metricLabel: React.CSSProperties = {
  margin: "0 0 8px 0",
  color: "#666666",
  fontSize: "10px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.6px",
  lineHeight: "1.3",
}

const metricValue: React.CSSProperties = {
  margin: "0",
  color: "#0f4fc5",
  fontSize: "20px",
  fontWeight: 700,
  lineHeight: "1.15",
  letterSpacing: "-0.3px",
}

const metricValueCritical: React.CSSProperties = {
  ...metricValue,
  color: "#b42318",
}

const findingTable: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  tableLayout: "fixed",
}

const findingCell: React.CSSProperties = {
  padding: "12px 14px",
  borderBottom: "1px solid #eaecf0",
  verticalAlign: "top",
}

const findingCellLast: React.CSSProperties = {
  padding: "12px 14px",
  verticalAlign: "top",
}

const findingHeadRow: React.CSSProperties = {
  margin: "0 0 6px 0",
  lineHeight: "1.4",
}

const findingLabel: React.CSSProperties = {
  color: "#101828",
  fontSize: "13px",
  fontWeight: 700,
}

const findingDescription: React.CSSProperties = {
  margin: "0 0 6px 0",
  color: "#344054",
  fontSize: "13px",
  lineHeight: "1.5",
}

const findingMeta: React.CSSProperties = {
  margin: "0",
  fontSize: "12px",
  lineHeight: "1.5",
}

const findingProject: React.CSSProperties = {
  color: "#475467",
  fontWeight: 600,
}

const findingAmount: React.CSSProperties = {
  color: "#b42318",
  fontWeight: 700,
}

const metaDivider: React.CSSProperties = {
  color: "#98a2b3",
}

const moreNote: React.CSSProperties = {
  margin: "0",
  padding: "10px 14px",
  borderTop: "1px solid #eaecf0",
  backgroundColor: "#fcfcfd",
  color: "#475467",
  fontSize: "12px",
}

const groupTable: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
}

const groupCell: React.CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid #eaecf0",
  verticalAlign: "middle",
}

const groupCellLast: React.CSSProperties = {
  padding: "10px 14px",
  verticalAlign: "middle",
}

const groupNumberCell: React.CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid #eaecf0",
  verticalAlign: "middle",
  textAlign: "right",
  width: "84px",
}

const groupNumberCellLast: React.CSSProperties = {
  padding: "10px 14px",
  verticalAlign: "middle",
  textAlign: "right",
  width: "84px",
}

const groupLabel: React.CSSProperties = {
  color: "#101828",
  fontSize: "13px",
  fontWeight: 500,
}

const groupCount: React.CSSProperties = {
  color: "#101828",
  fontSize: "13px",
  fontWeight: 700,
  fontVariantNumeric: "tabular-nums",
}

const groupAmount: React.CSSProperties = {
  color: "#475467",
  fontSize: "13px",
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
}

const coverageCard: React.CSSProperties = {
  marginTop: "16px",
  border: "1px solid #fedf89",
  backgroundColor: "#fffaeb",
  padding: "12px 14px",
}

const coverageTitle: React.CSSProperties = {
  margin: "0 0 6px 0",
  color: "#b54708",
  fontSize: "11px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const coverageText: React.CSSProperties = {
  margin: "0 0 4px 0",
  color: "#7a4708",
  fontSize: "12px",
  lineHeight: "1.5",
}

const buttonWrap: React.CSSProperties = {
  textAlign: "center",
  marginTop: "20px",
}

const button: React.CSSProperties = {
  backgroundColor: "#0f4fc5",
  color: "#ffffff",
  borderRadius: "0",
  padding: "12px 22px",
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
