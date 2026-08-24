export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

/** Provider-neutral email interface. Production provider selection is
 * deferred (decision AD-3) — nothing in Phase 1 depends on a specific
 * vendor, and no provider here makes a real network call. */
export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

/** Development-safe default: logs instead of sending. Never point
 * EMAIL_PROVIDER at anything else in Phase 1 (see packages/config/env.ts,
 * which only accepts "console"). */
export class ConsoleEmailProvider implements EmailProvider {
  async send(message: EmailMessage): Promise<void> {
    console.warn(
      `[email:console] to=${message.to} subject=${JSON.stringify(message.subject)}`,
    );
  }
}

/** Test double — captures sent messages in memory instead of logging, so
 * tests can assert on notification content without touching stdout or any
 * external recipient. */
export class InMemoryEmailProvider implements EmailProvider {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}
