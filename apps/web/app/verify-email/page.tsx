import { Suspense } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  LoadingState,
} from "@noahark/ui";
import { VerifyEmailConfirm } from "@/components/VerifyEmailConfirm";

export default function VerifyEmailPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Verify email</CardTitle>
          <CardDescription>Confirming your NoahArk email address</CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<LoadingState label="Loading..." />}>
            <VerifyEmailConfirm />
          </Suspense>
        </CardContent>
      </Card>
    </main>
  );
}
