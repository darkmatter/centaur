import * as React from "react";
import { Slot } from "radix-ui";
import { cn } from "@/lib/utils";

function SurfaceBar({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<"div"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "div";
  return (
    <Comp
      data-slot="surface-bar"
      className={cn("surface-bar", className)}
      {...props}
    />
  );
}

export { SurfaceBar };
