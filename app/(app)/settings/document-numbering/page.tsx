import { PageLayout } from "@/components/layout/page-layout"
import { getDocumentNumbering } from "@/lib/services/document-numbering"
import { DocumentNumberingForm } from "./document-numbering-form"

export default async function DocumentNumberingPage() {
  const settings = await getDocumentNumbering()
  return <PageLayout title="Document Numbering" breadcrumbs={[{ label: "Settings", href: "/settings?tab=organization" }, { label: "Document Numbering" }]}><div className="space-y-5"><div><h1 className="text-xl font-semibold">Document numbering</h1><p className="mt-1 text-sm text-muted-foreground">Set prefixes and zero-padding for project records. Projects continue to use atomic integer sequences.</p></div><DocumentNumberingForm initial={settings} /></div></PageLayout>
}

