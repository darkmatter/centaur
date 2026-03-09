import * as React from "react";
import { cn } from "@/lib/utils";
import { SurfaceBar } from "@/components/ui/surface-bar";

type MobileHeaderProps = React.ComponentProps<"div"> & {
  title: React.ReactNode;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
};

function MobileHeader({
  title,
  leading,
  trailing,
  className,
  ...props
}: MobileHeaderProps) {
  return (
    <SurfaceBar
      data-slot="mobile-header"
      className={cn(
        "md:hidden flex items-center justify-between border-b border-border/60 px-3 py-2",
        className,
      )}
      {...props}
    >
      {leading ?? <span className="size-10" aria-hidden="true" />}
      <span className="min-w-0 truncate text-sm font-medium text-foreground">
        {title}
      </span>
      {trailing ?? <span className="size-10" aria-hidden="true" />}
    </SurfaceBar>
  );
}

export { MobileHeader };
