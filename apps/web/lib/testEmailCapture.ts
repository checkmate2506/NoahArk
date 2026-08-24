import { getIdentityClient } from "@noahark/db";
import {
  ConsoleEmailProvider,
  type EmailMessage,
  type EmailProvider,
} from "@noahark/notifications";

/**
 * E2E test-safe notification capture (F-14/E2E, Phase 1B.1). Email
 * verification and invitation links are otherwise only ever logged to
 * server stdout (ConsoleEmailProvider — Phase 1 has no production email
 * provider, AD-3), which an E2E suite driving the real HTTP/browser
 * surface has no way to read. This is the ONLY code path that reads or
 * writes the `test_email_capture` table, and it is doubly gated:
 *
 *   1. `NODE_ENV !== "production"` — a real production deployment always
 *      sets NODE_ENV=production, which disables this unconditionally,
 *      regardless of the second flag.
 *   2. `TEST_NOTIFICATION_CAPTURE === "1"` — must be explicitly opted into
 *      (set only in local/CI E2E environments' .env — see .env.example).
 *
 * Both checks must pass; a misconfigured production `.env` that
 * accidentally carries `TEST_NOTIFICATION_CAPTURE=1` forward is still
 * blocked by check 1. When inactive, sending falls back to the ordinary
 * ConsoleEmailProvider (identical to Phase 1B behaviour) and the read
 * endpoint (app/api/v1/test/email-captures) responds 404.
 *
 * N-6 (Phase 1D): that 404 is NOT literally indistinguishable from a route
 * that doesn't exist — an earlier version of this comment claimed it was,
 * which was never actually verified and turned out to be inaccurate. Both
 * are HTTP 404, but this one carries the app's own structured JSON error
 * envelope (`{ error: { code: "NOT_FOUND", message, requestId } }`, see
 * apiHandler.ts's jsonError), while a genuinely unmatched Next.js route
 * returns Next's own bare/HTML 404 with no such body. The distinction is
 * inert either way — it only reveals that this path exists in the source
 * tree, and every real deployment sets NODE_ENV=production, which alone
 * forces this closed path regardless of TEST_NOTIFICATION_CAPTURE — but
 * the claim itself needed correcting. See lib/testEmailCapture.test.ts for
 * the automated coverage this previously had none of.
 */
export function isTestEmailCaptureActive(): boolean {
  return (
    process.env.NODE_ENV !== "production" && process.env.TEST_NOTIFICATION_CAPTURE === "1"
  );
}

class TestCaptureEmailProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<void> {
    // Still log to console too — local dev output is unaffected either way.
    console.warn(
      `[email:console+capture] to=${message.to} subject=${JSON.stringify(message.subject)}`,
    );
    const db = getIdentityClient();
    await db.testEmailCapture.create({
      data: { to: message.to, subject: message.subject, body: message.body },
    });
  }
}

let sharedProvider: EmailProvider | undefined;

/** The email provider every service (emailVerificationService,
 * invitationService) should send through — capturing when E2E test mode is
 * active, plain console logging otherwise. Centralised here so the
 * activation gate exists in exactly one place. */
export function getSharedEmailProvider(): EmailProvider {
  if (!sharedProvider) {
    sharedProvider = isTestEmailCaptureActive()
      ? new TestCaptureEmailProvider()
      : new ConsoleEmailProvider();
  }
  return sharedProvider;
}

export interface CapturedEmail {
  to: string;
  subject: string;
  body: string;
  createdAt: Date;
}

/** Returns captured messages for `to`, most recent first. Returns `null`
 * (never an empty array) when capture mode is inactive, so the route can
 * translate that into a 404 rather than a misleadingly-empty 200. */
export async function readCapturedEmails(to: string): Promise<CapturedEmail[] | null> {
  if (!isTestEmailCaptureActive()) return null;
  const db = getIdentityClient();
  return db.testEmailCapture.findMany({
    where: { to },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
}
