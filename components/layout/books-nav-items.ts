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
    { title: "Revenue policies", url: "/books/revenue-policies", isActive: pathname.startsWith("/books/revenue-policies"), requiredAny: ["books.read"] },
    { title: "Cost allocations", url: "/books/cost-allocations", isActive: pathname.startsWith("/books/cost-allocations"), requiredAny: ["books.read"] },
    { title: "Owned inventory", url: "/books/inventory", isActive: pathname.startsWith("/books/inventory"), requiredAny: ["books.read"] },
    { title: "Companies", url: "/books/entities", isActive: pathname.startsWith("/books/entities"), requiredAny: ["books.read"] },
  ];
}
