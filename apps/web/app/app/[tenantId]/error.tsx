"use client";

import { useEffect } from "react";
import { Button, ErrorState, PermissionDeniedState } from "@noahark/ui";

/**
 * Next.js error boundary for every /app/[tenantId]/* page. Several pages
 * call service functions that perform their own authorize() check
 * internally (list functions shared with the API routes) rather than
 * duplicating a can() pre-check on every page — this boundary is what
 * turns an uncaught ForbiddenError into the required permission-denied
 * state instead of a raw framework error screen, for exactly those pages.
 * Pages that already know in advance a permission is missing (legal-entity
 * detail, settings, audit) still show PermissionDeniedState directly, which
 * reads better because it can include page-specific context.
 */
export default function TenantSectionError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const looksLikePermissionDenial =
    /permission|forbidden|access|authority|membership/i.test(error.message);

  if (looksLikePermissionDenial) {
    return <PermissionDeniedState description={error.message} />;
  }

  return (
    <div className="flex flex-col items-start gap-4">
      <ErrorState description={error.message} />
      <Button variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
