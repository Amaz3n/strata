/** The same accounting destinations on desktop and mobile. Books has no overview. */
export function buildBooksNavItems(pathname: string) {
  return [
    {
      title: "Banking",
      url: "/books/banking",
      isActive:
        pathname.startsWith("/books/banking") ||
        pathname === "/books/transactions",
    },
    {
      title: "General ledger",
      url: "/books/ledger",
      isActive: pathname.startsWith("/books/ledger"),
    },
    {
      title: "Assets & loans",
      url: "/books/assets",
      isActive: pathname.startsWith("/books/assets"),
      requiredAny: ["books.adjust"],
    },
    {
      title: "Company budget",
      url: "/books/overhead",
      isActive: pathname.startsWith("/books/overhead"),
    },
    {
      title: "Close",
      url: "/books/close",
      isActive:
        pathname.startsWith("/books/close") ||
        pathname.startsWith("/books/exports") ||
        pathname.startsWith("/books/taxes"),
    },
    { title: "Legal entities", url: "/books/entities", isActive: pathname.startsWith("/books/entities"), requiredAny: ["books.read"] },
  ];
}
