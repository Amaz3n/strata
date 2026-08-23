import { CompanyTabSkeleton } from "@/components/companies/account/company-account-skeleton";

// A four-figure strip over a full-bleed roster, matching the real panel for
// either kind of party so the page does not jump when the access records land.
export default function Loading() {
  return <CompanyTabSkeleton rows={6} flush summaryFigures={4} />;
}
