import { BooksSectionPage } from "../../_components/books-section-page"

export default function AccountingPeriodClosePage({
  params,
}: {
  params: Promise<{ periodId: string }>
}) {
  return <BooksSectionPage section="close" routeParams={params} />
}
