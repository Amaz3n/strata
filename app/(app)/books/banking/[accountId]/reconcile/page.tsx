import { BooksSectionPage } from "../../../_components/books-section-page"

export default function BankReconciliationPage({
  params,
}: {
  params: Promise<{ accountId: string }>
}) {
  return <BooksSectionPage section="banking" routeParams={params} />
}
