import { redirect } from "next/navigation";

export const instant = false;

export default function BooksAccountantPage() {
  redirect("/books/exports");
}
