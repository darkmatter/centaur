import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { cn } from "@/lib/utils";

const sheetActionVariants = cva(
  "sheet-action disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "text-foreground [&>svg]:text-muted-foreground",
        destructive: "text-destructive hover:!bg-destructive/10",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function SheetAction({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof sheetActionVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="sheet-action"
      className={cn(sheetActionVariants({ variant, className }))}
      {...props}
    />
  );
}

export { SheetAction, sheetActionVariants };
