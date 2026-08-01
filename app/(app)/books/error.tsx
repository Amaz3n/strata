"use client"

import { Button } from "@/components/ui/button"

export default function BooksError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <div className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-4 px-6 text-center"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Arc Books</p><h2 className="text-2xl font-semibold tracking-tight">The ledger workspace could not load.</h2><p className="text-sm text-muted-foreground">Retry the request. If the Books migration has not been approved and applied yet, the workspace will remain unavailable.</p><Button onClick={reset}>Try again</Button></div>
}
