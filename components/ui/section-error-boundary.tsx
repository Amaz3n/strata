"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * A per-section error state, so one slow or failing band cannot blank a page.
 *
 * Route-level `error.tsx` is all-or-nothing: a financial timeout would replace
 * the whole project with an error screen. A section that fails should say so in
 * its own frame and leave the rest of the page usable.
 */
export class SectionErrorBoundary extends React.Component<
  { children: React.ReactNode; title: string; className?: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error("Section failed to render", error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <SectionErrorState
        title={this.props.title}
        className={this.props.className}
        onRetry={() => this.setState({ error: null })}
      />
    )
  }
}

function SectionErrorState({
  title,
  className,
  onRetry,
}: {
  title: string
  className?: string
  onRetry: () => void
}) {
  const router = useRouter()
  return (
    <div className={cn("flex flex-col items-start gap-2 px-5 sm:px-8 lg:px-12 py-10", className)}>
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{title}</p>
      <p className="text-sm text-foreground">This section didn&rsquo;t load.</p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          onRetry()
          router.refresh()
        }}
      >
        Try again
      </Button>
    </div>
  )
}
