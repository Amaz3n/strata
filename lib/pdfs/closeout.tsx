import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer"

type CloseoutPdfItem = {
  title: string
  status: string
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
  cellTitle: { flexGrow: 1 },
  cellStatus: { width: 120, textAlign: "right" },
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
            <Text style={styles.cellStatus}>Status</Text>
          </View>
          {data.items.map((item, idx) => (
            <View key={`${item.title}-${idx}`} style={styles.row}>
              <Text style={styles.cellTitle}>{item.title}</Text>
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
