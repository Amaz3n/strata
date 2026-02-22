import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components"

export type WeeklySnapshotMetric = {
  label: string
  value: string
}

export type WeeklySnapshotWatchlistItem = {
  projectName: string
  schedule: string
  cost: string
  docs: string
}

export type WeeklySnapshotDecisionItem = {
  typeLabel: string
  title: string
  projectName?: string | null
  owner?: string | null
  dueBy?: string | null
  ageLabel: string
  impactLabel: string
}

export type WeeklySnapshotDriftItem = {
  label: string
  current: string
  delta: string
}

export interface WeeklyExecutiveSnapshotEmailProps {
  weekLabel: string
  orgName?: string | null
  orgLogoUrl?: string | null
  recipientName?: string | null
  generatedAtLabel: string
  controlTowerLink: string
  metrics: WeeklySnapshotMetric[]
  watchlist: WeeklySnapshotWatchlistItem[]
  decisions: WeeklySnapshotDecisionItem[]
  drift: WeeklySnapshotDriftItem[]
  executiveNotes?: string[]
}

function fixedLengthRows<T>(items: T[], size: number): Array<T | null> {
  const next = items.slice(0, size) as Array<T | null>
  while (next.length < size) next.push(null)
  return next
}

export function WeeklyExecutiveSnapshotEmail({
  weekLabel = "Week of Feb 16 - Feb 22, 2026",
  orgName,
  orgLogoUrl,
  recipientName,
  generatedAtLabel = "Generated Feb 22, 2026 at 8:00 AM EST",
  controlTowerLink = "#",
  metrics = [
    { label: "Active Projects", value: "18" },
    { label: "Exec Attention", value: "4" },
    { label: "AR 30+ Days", value: "$128K" },
    { label: "Pending CO Value", value: "$412K" },
    { label: "Decisions This Week", value: "9" },
  ],
  watchlist = [
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
  decisions = [
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
  drift = [
    { label: "Critical Delays", current: "6", delta: "-1 vs prior 7d" },
    { label: "AR 30+ Days", current: "$128K", delta: "+$22K vs prior 7d" },
    { label: "Pending COs", current: "$412K", delta: "+$58K vs prior 7d" },
    { label: "Overdue RFIs", current: "11", delta: "-3 vs prior 7d" },
  ],
  executiveNotes = [
    "Biggest immediate lever: close 2 high-value decisions by Thursday to prevent schedule carryover into next week.",
    "Cash trend is mixed: collections slowed in medical and multifamily portfolios while AP approvals remain backlogged.",
    "Current risk concentration is acceptable if Naples steel and Southport glazing decisions are resolved on time.",
  ],
}: WeeklyExecutiveSnapshotEmailProps) {
  const displayOrgName = orgName ?? "Arc"
  const greeting = recipientName ? `Hi ${recipientName},` : "Hello,"
  const previewText = `${displayOrgName} weekly executive snapshot · ${weekLabel}`
  const metricCells = metrics.slice(0, 5)
  const watchRows = fixedLengthRows(watchlist, 4)
  const decisionRows = fixedLengthRows(decisions, 4)
  const driftRows = fixedLengthRows(drift, 4)
  const noteRows = fixedLengthRows(executiveNotes, 3)

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
            <Text style={brandSub}>Weekly Executive Snapshot</Text>
          </Section>

          <Section style={hero}>
            <Text style={heroKicker}>{weekLabel}</Text>
            <Heading style={heroHeading}>Control Tower Brief</Heading>
            <Text style={heroMeta}>{generatedAtLabel}</Text>
          </Section>

          <Section style={content}>
            <Text style={paragraph}>{greeting}</Text>
            <Text style={paragraph}>
              Portfolio summary for the week is below. This report highlights schedule pressure, financial exposure,
              and decisions requiring leadership action.
            </Text>

            <Section style={sectionCard}>
              <Text style={sectionTitle}>Portfolio Health</Text>
              <table style={metricsTable} cellPadding={0} cellSpacing={0} role="presentation">
                <tbody>
                  <tr>
                    {metricCells.map((metric) => (
                      <td key={metric.label} style={metricCell}>
                        <Text style={metricLabel}>{metric.label}</Text>
                        <Text style={metricValue}>{metric.value}</Text>
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </Section>

            <table style={splitTable} cellPadding={0} cellSpacing={0} role="presentation">
              <tbody>
                <tr>
                  <td style={splitColumn} valign="top">
                    <table style={splitCardTall} cellPadding={0} cellSpacing={0} role="presentation">
                      <tbody>
                        <tr>
                          <td style={cardHeaderCell}>
                            <Text style={sectionTitle}>Watchlist</Text>
                          </td>
                        </tr>
                        <tr>
                          <td style={cardBodyTall} valign="top">
                            <table style={listTable} cellPadding={0} cellSpacing={0} role="presentation">
                              <tbody>
                                {watchRows.map((item, index) => (
                                  <tr key={item ? `${item.projectName}-${index}` : `watch-empty-${index}`} style={pairedRow}>
                                    <td style={pairedRowCell}>
                                      {item ? (
                                        <>
                                          <Text style={watchProject}>{item.projectName}</Text>
                                          <Text style={watchMeta}>
                                            <span style={watchLabel}>Critical Path:</span> {item.schedule}
                                          </Text>
                                          <Text style={watchMeta}>
                                            <span style={watchLabel}>Commercial:</span> {item.cost}
                                          </Text>
                                          <Text style={watchMeta}>
                                            <span style={watchLabel}>Exec Action:</span> {item.docs}
                                          </Text>
                                        </>
                                      ) : (
                                        <>
                                          <Text style={watchProjectMuted}>No additional flagged project</Text>
                                          <Text style={watchMetaMuted}>No executive action required in this slot.</Text>
                                          <Text style={watchMetaMuted}>No executive action required in this slot.</Text>
                                          <Text style={watchMetaMuted}>No executive action required in this slot.</Text>
                                        </>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                  <td style={splitGap} />
                  <td style={splitColumn} valign="top">
                    <table style={splitCardTall} cellPadding={0} cellSpacing={0} role="presentation">
                      <tbody>
                        <tr>
                          <td style={cardHeaderCell}>
                            <Text style={sectionTitle}>Decision Queue</Text>
                          </td>
                        </tr>
                        <tr>
                          <td style={cardBodyTall} valign="top">
                            <table style={listTable} cellPadding={0} cellSpacing={0} role="presentation">
                              <tbody>
                                {decisionRows.map((item, index) => (
                                  <tr
                                    key={item ? `${item.typeLabel}-${item.title}-${index}` : `decision-empty-${index}`}
                                    style={pairedRow}
                                  >
                                    <td style={pairedRowCell}>
                                      {item ? (
                                        <>
                                          <Text style={decisionType}>{item.typeLabel}</Text>
                                          <Text style={decisionTitle}>{item.title}</Text>
                                          <Text style={decisionMeta}>
                                            {item.projectName ? `${item.projectName}` : "Portfolio"} ·{" "}
                                            {item.owner ? `${item.owner}` : "Executive Owner"}
                                          </Text>
                                          <Text style={decisionMetaStrong}>
                                            {item.ageLabel} open · {item.dueBy ? `Due ${item.dueBy}` : "Due this week"} · {item.impactLabel}
                                          </Text>
                                        </>
                                      ) : (
                                        <>
                                          <Text style={decisionTypeMuted}>No additional decision</Text>
                                          <Text style={decisionMetaMuted}>Decision backlog clear for this slot.</Text>
                                          <Text style={decisionMetaMuted}>Decision backlog clear for this slot.</Text>
                                          <Text style={decisionMetaMuted}>Decision backlog clear for this slot.</Text>
                                        </>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>

            <table style={splitTable} cellPadding={0} cellSpacing={0} role="presentation">
              <tbody>
                <tr>
                  <td style={splitColumn} valign="top">
                    <table style={splitCardShort} cellPadding={0} cellSpacing={0} role="presentation">
                      <tbody>
                        <tr>
                          <td style={cardHeaderCell}>
                            <Text style={sectionTitle}>14-Day Drift</Text>
                          </td>
                        </tr>
                        <tr>
                          <td style={cardBodyShort} valign="top">
                            <table style={driftTable} cellPadding={0} cellSpacing={0} role="presentation">
                              <tbody>
                                <tr style={driftRow}>
                                  {driftRows.map((item, index) => (
                                    <td
                                      key={item ? item.label : `drift-empty-${index}`}
                                      style={index === 3 ? driftCellLast : driftCell}
                                    >
                                      {item ? (
                                        <>
                                          <Text style={driftLabel}>{item.label}</Text>
                                          <Text style={driftValue}>{item.current}</Text>
                                          <Text style={driftDelta}>{item.delta}</Text>
                                        </>
                                      ) : (
                                        <>
                                          <Text style={driftLabel}>No Signal</Text>
                                          <Text style={driftValue}>-</Text>
                                          <Text style={driftDelta}>No change this period</Text>
                                        </>
                                      )}
                                    </td>
                                  ))}
                                </tr>
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                  <td style={splitGap} />
                  <td style={splitColumn} valign="top">
                    <table style={splitCardShort} cellPadding={0} cellSpacing={0} role="presentation">
                      <tbody>
                        <tr>
                          <td style={cardHeaderCell}>
                            <Text style={sectionTitle}>Executive Notes</Text>
                          </td>
                        </tr>
                        <tr>
                          <td style={cardBodyShort} valign="top">
                            <table style={notesTable} cellPadding={0} cellSpacing={0} role="presentation">
                              <tbody>
                                {noteRows.map((note, index) => (
                                  <tr key={`note-row-${index}`} style={noteRow}>
                                    <td style={index === noteRows.length - 1 ? noteCellLast : noteCell}>
                                      <Text style={note ? noteText : noteTextMuted}>
                                        • {note ?? "No additional executive note for this slot."}
                                      </Text>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </td>
                </tr>
              </tbody>
            </table>

            <Section style={buttonWrap}>
              <Button style={button} href={controlTowerLink}>
                Open Control Tower
              </Button>
            </Section>

            <Text style={fallbackText}>
              If the button does not open,{" "}
              <Link href={controlTowerLink} style={link}>
                open secure link
              </Link>
            </Text>
          </Section>

          <Hr style={hr} />
          <Section style={footer}>
            <table style={footerTable} cellPadding={0} cellSpacing={0} role="presentation">
              <tbody>
                <tr>
                  <td style={footerCell} align="center">
                    <Text style={footerText}>Sent via Arc</Text>
                  </td>
                </tr>
              </tbody>
            </table>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = {
  backgroundColor: "#e9edf5",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, Arial, sans-serif',
  margin: "0",
  padding: "24px 0",
}

const container: React.CSSProperties = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  maxWidth: "920px",
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
  padding: "26px 40px",
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
  fontSize: "34px",
  lineHeight: "1.08",
  fontWeight: 700,
  letterSpacing: "-0.9px",
}

const heroMeta: React.CSSProperties = {
  margin: "12px 0 0 0",
  color: "#d5e2ff",
  fontSize: "13px",
  lineHeight: "1.4",
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
  marginTop: "14px",
  border: "1px solid #e3e3e3",
  backgroundColor: "#ffffff",
}

const splitCardTall: React.CSSProperties = {
  margin: "0",
  border: "1px solid #deebff",
  backgroundColor: "#ffffff",
  height: "368px",
  verticalAlign: "top",
  overflow: "hidden",
  width: "100%",
  borderCollapse: "collapse",
  tableLayout: "fixed",
}

const splitCardShort: React.CSSProperties = {
  margin: "0",
  border: "1px solid #deebff",
  backgroundColor: "#ffffff",
  height: "236px",
  verticalAlign: "top",
  overflow: "hidden",
  width: "100%",
  borderCollapse: "collapse",
  tableLayout: "fixed",
}

const cardHeaderCell: React.CSSProperties = {
  padding: "0",
}

const cardBodyTall: React.CSSProperties = {
  height: "328px",
  verticalAlign: "top",
  padding: "0",
}

const cardBodyShort: React.CSSProperties = {
  height: "196px",
  verticalAlign: "top",
  padding: "0",
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
}

const metricCell: React.CSSProperties = {
  width: "20%",
  padding: "12px",
  borderRight: "1px solid #deebff",
  verticalAlign: "top",
}

const metricLabel: React.CSSProperties = {
  margin: "0 0 8px 0",
  color: "#666666",
  fontSize: "10px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const metricValue: React.CSSProperties = {
  margin: "0",
  color: "#0f4fc5",
  fontSize: "20px",
  fontWeight: 700,
  lineHeight: "1.15",
  letterSpacing: "-0.3px",
}

const splitTable: React.CSSProperties = {
  width: "100%",
  borderCollapse: "separate",
  borderSpacing: "0",
  tableLayout: "fixed",
  marginTop: "14px",
}

const splitColumn: React.CSSProperties = {
  width: "50%",
  verticalAlign: "top",
}

const splitGap: React.CSSProperties = {
  width: "12px",
  fontSize: "0",
  lineHeight: "0",
}

const listTable: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  tableLayout: "fixed",
  height: "100%",
}

const pairedRow: React.CSSProperties = {
  height: "82px",
}

const pairedRowCell: React.CSSProperties = {
  padding: "8px 12px",
  borderBottom: "1px solid #eaf1ff",
  height: "82px",
  maxHeight: "82px",
  verticalAlign: "top",
  overflow: "hidden",
}

const watchProject: React.CSSProperties = {
  margin: "0 0 5px 0",
  color: "#111111",
  fontSize: "13px",
  fontWeight: 700,
  lineHeight: "1.3",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
}

const watchMeta: React.CSSProperties = {
  margin: "0 0 1px 0",
  color: "#32465f",
  fontSize: "11px",
  fontWeight: 500,
  lineHeight: "1.34",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
}

const watchProjectMuted: React.CSSProperties = {
  margin: "0 0 1px 0",
  color: "#7a8696",
  fontSize: "11px",
  fontWeight: 600,
  lineHeight: "1.34",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
}

const watchMetaMuted: React.CSSProperties = {
  margin: "0 0 1px 0",
  color: "#8a96a6",
  fontSize: "11px",
  fontWeight: 500,
  lineHeight: "1.34",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
}

const watchLabel: React.CSSProperties = {
  color: "#1f5ecf",
  fontWeight: 700,
}

const decisionType: React.CSSProperties = {
  margin: "0 0 1px 0",
  color: "#1f5ecf",
  fontSize: "10px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.8px",
  lineHeight: "1.34",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
}

const decisionTitle: React.CSSProperties = {
  margin: "0 0 1px 0",
  color: "#111111",
  fontSize: "13px",
  fontWeight: 600,
  lineHeight: "1.34",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
}

const decisionMeta: React.CSSProperties = {
  margin: "0 0 1px 0",
  color: "#4d5f75",
  fontSize: "11px",
  lineHeight: "1.34",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
}

const decisionMetaStrong: React.CSSProperties = {
  margin: "0",
  color: "#304358",
  fontSize: "11px",
  fontWeight: 600,
  lineHeight: "1.34",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
}

const decisionTypeMuted: React.CSSProperties = {
  margin: "0 0 1px 0",
  color: "#8290a1",
  fontSize: "10px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.8px",
  lineHeight: "1.34",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
}

const decisionMetaMuted: React.CSSProperties = {
  margin: "0 0 1px 0",
  color: "#93a0b0",
  fontSize: "11px",
  fontWeight: 500,
  lineHeight: "1.34",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
}

const driftTable: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  tableLayout: "fixed",
  height: "100%",
}

const driftRow: React.CSSProperties = {
  height: "100%",
}

const driftCell: React.CSSProperties = {
  width: "25%",
  borderRight: "1px solid #deebff",
  padding: "12px 10px",
  verticalAlign: "top",
}

const driftCellLast: React.CSSProperties = {
  width: "25%",
  padding: "12px 10px",
  verticalAlign: "top",
}

const driftLabel: React.CSSProperties = {
  margin: "0 0 6px 0",
  color: "#666666",
  fontSize: "10px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const driftValue: React.CSSProperties = {
  margin: "0",
  color: "#0f4fc5",
  fontSize: "20px",
  fontWeight: 700,
  lineHeight: "1.15",
}

const driftDelta: React.CSSProperties = {
  margin: "6px 0 0 0",
  color: "#555555",
  fontSize: "11px",
  fontWeight: 500,
  lineHeight: "1.4",
}

const noteText: React.CSSProperties = {
  margin: "0",
  color: "#2d3d52",
  fontSize: "12px",
  lineHeight: "1.45",
}

const noteTextMuted: React.CSSProperties = {
  margin: "0",
  color: "#7f8ea2",
  fontSize: "12px",
  lineHeight: "1.45",
}

const notesTable: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  tableLayout: "fixed",
  height: "100%",
}

const noteRow: React.CSSProperties = {
  height: "64px",
}

const noteCell: React.CSSProperties = {
  padding: "8px 12px",
  verticalAlign: "top",
  borderBottom: "1px solid #eaf1ff",
}

const noteCellLast: React.CSSProperties = {
  padding: "8px 12px",
  verticalAlign: "top",
}

const buttonWrap: React.CSSProperties = {
  textAlign: "center",
  marginTop: "18px",
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
  padding: "16px 40px 20px 40px",
  textAlign: "center",
}

const footerTable: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
}

const footerCell: React.CSSProperties = {
  textAlign: "center",
}

const footerText: React.CSSProperties = {
  margin: "0",
  color: "#7c7c7c",
  fontSize: "12px",
  textAlign: "center",
}
