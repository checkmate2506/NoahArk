import { Suspense } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  LoadingState,
} from "@noahark/ui";
import { AcceptInvitationForm } from "@/components/AcceptInvitationForm";

export default function AcceptInvitationPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Accept invitation</CardTitle>
          <CardDescription>Join a NoahArk workspace</CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<LoadingState label="Loading..." />}>
            <AcceptInvitationForm />
          </Suspense>
        </CardContent>
      </Card>
    </main>
  );
}
