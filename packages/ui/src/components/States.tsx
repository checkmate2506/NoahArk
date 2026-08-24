import * as React from "react";
import { cn } from "../lib/cn";

/** Required by every admin screen (PHASE_01_FOUNDATION §14): loading,
 * empty, error and permission-denied states, each distinct and legible. */

export function LoadingState({ label = "Loading..." }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-3 p-6 text-sm text-muted-foreground"
    >
      <span
        aria-hidden
        className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground"
      />
      {label}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-10 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      {action}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  description,
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/5 p-6"
    >
      <p className="text-sm font-semibold text-destructive">{title}</p>
      {description && <p className="mt-1 text-sm text-destructive/90">{description}</p>}
    </div>
  );
}

export function PermissionDeniedState({
  description = "You do not have permission to view this.",
}: {
  description?: string;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-border bg-muted/50 p-6 text-center"
    >
      <p className="text-sm font-semibold text-foreground">Access restricted</p>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} />;
}
