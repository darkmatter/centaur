"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function ThreadScreenFrame({
  header,
  banner,
  content,
  footer,
  mobileNav,
  overlay,
  className,
}: {
  header?: ReactNode;
  banner?: ReactNode;
  content: ReactNode;
  footer?: ReactNode;
  mobileNav?: ReactNode;
  overlay?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("app-shell h-dvh md:h-full flex flex-col bg-background overflow-hidden", className)}>
      {header}
      {banner}
      <div className="mx-auto flex min-h-0 w-full max-w-[960px] flex-1 flex-col px-2 py-2 md:px-4 md:py-3">
        {content}
      </div>
      {footer}
      {mobileNav}
      {overlay}
    </div>
  );
}
