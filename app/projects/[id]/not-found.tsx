import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Building2 } from "@/components/icons"

export default function ProjectNotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] p-4 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-6">
        <Building2 className="h-8 w-8 text-muted-foreground" />
      </div>
      <h1 className="text-2xl font-bold mb-2">Project Not Found</h1>
      <p className="text-muted-foreground mb-6 max-w-md">
        The project you're looking for doesn't exist or you don't have access to view it.
      </p>
      <Button asChild>
        <Link href="/projects">Back to Projects</Link>
      </Button>
    </div>
  )
}






