"use client";
import { Button } from "@/components/ui/button";
export default function TradeError({ reset }: { reset: () => void }) {
  return (
    <div className="mx-auto max-w-md space-y-3 p-8 text-center">
      <h1 className="text-base font-semibold">Unable to load Arc Trade</h1>
      <p className="text-sm text-muted-foreground">
        Please try again. If this continues, ask your company administrator to
        check your access.
      </p>
      <Button variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
