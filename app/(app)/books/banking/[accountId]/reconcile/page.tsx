import { BooksSectionPage } from "../../../_components/books-section-page"

export default async function BankReconciliationPage({
  params,
}: {
  params: Promise<{ accountId: string }>
}) {
  const { accountId } = await params
  return <BooksSectionPage section="banking" bankAccountId={accountId} />
}
