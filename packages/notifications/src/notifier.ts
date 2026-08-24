import type { TransactionClient } from "@noahark/db";
import type { EmailProvider } from "./emailProvider";

export type NotifyChannel = "IN_APP" | "EMAIL";

export interface NotifyInput {
  tenantId: string;
  legalEntityId?: string | null;
  recipientUserId: string;
  recipientEmail?: string; // required only if the EMAIL channel ends up enabled
  type: string;
  title: string;
  body: string;
  /** Defaults to IN_APP only. EMAIL must be explicitly requested by the
   * caller AND not be disabled by the recipient's NotificationPreference. */
  channels?: readonly NotifyChannel[];
}

/**
 * Writes an in-app Notification row (inside the caller's transaction) and,
 * if EMAIL was requested and not disabled by the recipient's preferences,
 * asks `emailProvider` to send it. The email provider is injected so
 * callers in tests use InMemoryEmailProvider and production/dev code uses
 * ConsoleEmailProvider (or a real provider once AD-3 is resolved) —
 * notifier.ts itself never decides which provider is "real".
 */
export async function notify(
  tx: TransactionClient,
  emailProvider: EmailProvider,
  input: NotifyInput,
): Promise<void> {
  const channels = input.channels ?? ["IN_APP"];

  if (channels.includes("IN_APP")) {
    await tx.notification.create({
      data: {
        tenantId: input.tenantId,
        legalEntityId: input.legalEntityId ?? null,
        recipientUserId: input.recipientUserId,
        channel: "IN_APP",
        type: input.type,
        title: input.title,
        body: input.body,
      },
    });
  }

  if (channels.includes("EMAIL")) {
    const preference = await tx.notificationPreference.findUnique({
      where: {
        tenantId_userId_channel_type: {
          tenantId: input.tenantId,
          userId: input.recipientUserId,
          channel: "EMAIL",
          type: input.type,
        },
      },
    });
    const enabled = preference?.enabled ?? true; // opt-out model: enabled by default
    if (enabled && input.recipientEmail) {
      await emailProvider.send({
        to: input.recipientEmail,
        subject: input.title,
        body: input.body,
      });
      await tx.notification.create({
        data: {
          tenantId: input.tenantId,
          legalEntityId: input.legalEntityId ?? null,
          recipientUserId: input.recipientUserId,
          channel: "EMAIL",
          type: input.type,
          title: input.title,
          body: input.body,
        },
      });
    }
  }
}

export async function markNotificationRead(
  tx: TransactionClient,
  notificationId: string,
  recipientUserId: string,
): Promise<void> {
  // recipientUserId is included in the WHERE clause (not just the id) so a
  // user can never mark someone else's notification as read even if they
  // guess/enumerate an id — belt-and-braces alongside RLS tenant scoping.
  await tx.notification.updateMany({
    where: { id: notificationId, recipientUserId },
    data: { readAt: new Date() },
  });
}
