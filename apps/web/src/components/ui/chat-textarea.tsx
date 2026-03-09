import * as React from "react"

import { cn } from "@/lib/utils"

function ChatTextarea({
  className,
  disabled,
  ...props
}: React.ComponentProps<"textarea"> & { disabled?: boolean }) {
  return (
    <textarea
      data-slot="chat-textarea"
      className={cn(
        "chat-textarea flex-1 min-w-0 min-h-input-min resize-none",
        "text-input-base md:text-input-base",
        "border-none bg-transparent py-1.5 shadow-none outline-none",
        "placeholder:text-muted-foreground/60 text-foreground",
        "focus-visible:outline-none",
        disabled && "opacity-50",
        className,
      )}
      {...props}
    />
  )
}

export { ChatTextarea }
