"use client";

import { Button } from "@/components/ui/button";

export default function DealError({ reset }: { reset: () => void }) {
  return (
    <div role="alert" className="flex h-full items-center justify-center px-6">
      <div className="max-w-sm text-center">
        <p className="text-sm font-medium">This deal didn&apos;t load</p>
        <p className="mt-1.5 text-sm text-muted-foreground">
          It may have been removed, or you may not have access to its project.
        </p>
        <Button className="mt-4" variant="outline" size="sm" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  );
}
