"use client"

import Link from "next/link"
import { FolderOpen } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

interface NoProjectSelectedProps {
  title?: string
  description?: string
  primaryLabel?: string
  primaryHref?: string
}

export function NoProjectSelected({
  title = "Choose a project to get started",
  description = "Everything in Arc is scoped to a project. Select one to continue.",
  primaryLabel = "View projects",
  primaryHref = "/projects",
}: NoProjectSelectedProps) {
  return (
    <Empty className="min-h-[320px]">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FolderOpen className="h-5 w-5" />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild>
          <Link href={primaryHref}>{primaryLabel}</Link>
        </Button>
      </EmptyContent>
    </Empty>
  )
}
