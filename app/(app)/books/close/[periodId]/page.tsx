import { BooksSectionPage } from "../../_components/books-section-page"

export default async function AccountingPeriodClosePage({
  params,
}: {
  params: Promise<{ periodId: string }>
}) {
  const { periodId } = await params
  return <BooksSectionPage section="close" periodId={periodId} />
}
