export default function ShareLinkNotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/20 px-4">
      <div className="max-w-md space-y-2 rounded-xl border bg-background p-8 text-center shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Link unavailable
        </p>
        <h1 className="text-xl font-semibold">This share link isn&apos;t active</h1>
        <p className="text-sm text-muted-foreground">
          The link may have expired, reached its usage limit, or been revoked by the
          owner. Ask the sender for a new link.
        </p>
      </div>
    </div>
  )
}
