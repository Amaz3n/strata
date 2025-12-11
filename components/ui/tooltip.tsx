import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

const TooltipProvider = TooltipPrimitive.Provider

function Tooltip({ children, ...props }: TooltipPrimitive.TooltipProps) {
  return <TooltipPrimitive.Root {...props}>{children}</TooltipPrimitive.Root>
}

const TooltipTrigger = TooltipPrimitive.Trigger
const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Content
    ref={ref}
    sideOffset={sideOffset}
    className={`z-50 overflow-hidden rounded-md bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md ${className ?? ""}`}
    {...props}
  />
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent }
