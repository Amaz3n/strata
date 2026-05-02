import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer"

type CloseoutPdfItem = {
  title: string
  status: string
  dueDate?: string
  responsibleParty?: string
  notes?: string
}

type CloseoutPdfData = {
  orgName?: string
  projectName?: string
  status?: string
  items: CloseoutPdfItem[]
}

const styles = StyleSheet.create({
  page: { padding: 36, fontSize: 10, fontFamily: "Helvetica" },
  header: { marginBottom: 16 },
  title: { fontSize: 18, fontWeight: "bold" },
  subTitle: { fontSize: 10, color: "#5b5b5b", marginTop: 4 },
  section: { marginTop: 12 },
  label: { fontSize: 9, color: "#6b6b6b", marginBottom: 4 },
  tableHeader: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderColor: "#e5e5e5",
    paddingBottom: 6,
    marginBottom: 6,
  },
  row: {
    flexDirection: "row",
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderColor: "#f0f0f0",
  },
  cellTitle: { width: 210 },
  cellOwner: { width: 110 },
  cellDue: { width: 80 },
  cellStatus: { width: 80, textAlign: "right" },
  notes: { color: "#6b6b6b", fontSize: 9, marginTop: 2 },
})

function CloseoutDocument({ data }: { data: CloseoutPdfData }) {
  return (
    <Document>
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.title}>Closeout Package</Text>
          <Text style={styles.subTitle}>
            {data.orgName ? `${data.orgName} · ` : ""}{data.projectName ?? "Project"} · {data.status ?? "in_progress"}
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Items</Text>
          <View style={styles.tableHeader}>
            <Text style={styles.cellTitle}>Item</Text>
            <Text style={styles.cellOwner}>Responsible</Text>
            <Text style={styles.cellDue}>Due</Text>
            <Text style={styles.cellStatus}>Status</Text>
          </View>
          {data.items.map((item, idx) => (
            <View key={`${item.title}-${idx}`} style={styles.row}>
              <View style={styles.cellTitle}>
                <Text>{item.title}</Text>
                {item.notes ? <Text style={styles.notes}>{item.notes}</Text> : null}
              </View>
              <Text style={styles.cellOwner}>{item.responsibleParty ?? ""}</Text>
              <Text style={styles.cellDue}>{item.dueDate ?? ""}</Text>
              <Text style={styles.cellStatus}>{item.status}</Text>
            </View>
          ))}
        </View>
      </Page>
    </Document>
  )
}

export async function renderCloseoutPdf(data: CloseoutPdfData) {
  const pdf = await renderToBuffer(<CloseoutDocument data={data} />)
  return Buffer.from(pdf)
}
