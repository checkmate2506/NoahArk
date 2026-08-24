import { Suspense } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  LoadingState,
} from "@noahark/ui";
import { SignInForm } from "@/components/SignInForm";

export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>NoahArk</CardTitle>
          <CardDescription>Sign in to your workspace</CardDescription>
        </CardHeader>
        <CardContent>
          {/* useSearchParams() (for callbackUrl) requires a Suspense boundary
           * for static prerendering — the form itself is a client component. */}
          <Suspense fallback={<LoadingState label="Loading..." />}>
            <SignInForm />
          </Suspense>
        </CardContent>
      </Card>
    </main>
  );
}
