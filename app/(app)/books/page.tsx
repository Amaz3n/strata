import { BooksSectionPage } from "./_components/books-section-page"

export const dynamic = "force-dynamic"

export default async function BooksPage() {
  return <BooksSectionPage section="overview" />
}
