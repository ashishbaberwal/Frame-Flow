import Link from "next/link";

import { cn } from "@/lib/utils";

/**
 * Inline SVGs are a favorite target of browser extensions (Dark Reader and
 * friends inject `data-darkreader-*` attributes before React hydrates),
 * which surfaces as a hydration mismatch error. The markup itself is static
 * and identical on server and client, so the warning is suppressed on the
 * svg subtree — the one legitimate use of suppressHydrationWarning.
 */
export function Logo({ className, href = "/" }: { className?: string; href?: string }) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-2 font-display text-lg font-semibold tracking-tight text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md",
        className
      )}
    >
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className="shrink-0"
        suppressHydrationWarning
      >
        <rect x="2.5" y="2.5" width="19" height="19" rx="3" className="fill-foreground" suppressHydrationWarning />
        <path
          d="M8.5 12.2l2.4 2.9 4.8-6"
          className="stroke-background"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          suppressHydrationWarning
        />
      </svg>
      FrameFlow
    </Link>
  );
}
