import { redirect } from "next/navigation";
import { requireCurrentUser } from "@/lib/context";

export default async function RootPage() {
  try {
    await requireCurrentUser();
  } catch {
    redirect("/sign-in");
  }
  redirect("/app");
}
