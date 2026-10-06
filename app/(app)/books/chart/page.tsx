import { redirect } from "next/navigation";

export const instant = false;

export default function BooksChartPage() {
  redirect("/settings/accounting/chart-of-accounts");
}
