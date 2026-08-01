import type { ReactNode } from "react"

interface PortalPageHeaderProps {
  title: string
  description?: string
  actions?: ReactNode
}

/** Shared page title block so every portal page opens the same way. */
export function PortalPageHeader({ title, description, actions }: PortalPageHeaderProps) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}
