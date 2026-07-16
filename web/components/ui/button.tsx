import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Restyled to the design tokens: square corners (radius 0), token palette only,
// no hard-coded colors. Focus ring uses the brand token.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-none font-medium transition-colors duration-fast outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-0 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-brand text-onbrand hover:bg-brand/90",
        secondary: "bg-panel text-ink hover:bg-panel/70",
        outline: "border border-line bg-surface text-ink hover:bg-panel",
        ghost: "text-ink hover:bg-panel",
        destructive: "bg-error-strong text-onbrand hover:bg-error-strong/90",
        link: "text-brandink underline-offset-4 hover:underline",
      },
      size: {
        sm: "h-8 px-3 text-meta [&_svg]:size-3.5",
        default: "h-9 px-4 text-body [&_svg]:size-4",
        lg: "h-11 px-6 text-body [&_svg]:size-4",
        icon: "size-9 [&_svg]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return (
    <button
      type={type}
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { buttonVariants };
