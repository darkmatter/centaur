import * as React from "react";
import { Slot } from "radix-ui";
import { cn } from "@/lib/utils";

function OverlayBackdrop({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "div";
  return (
    <Comp
      data-slot="overlay-backdrop"
      className={cn("overlay-backdrop", className)}
      {...props}
    />
  );
}

export { OverlayBackdrop };
