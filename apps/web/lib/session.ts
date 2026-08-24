import { randomBytes, createHash } from "node:crypto";
import { getIdentityClient } from "@noahark/db";
import { SESSION_COOKIE_NAME } from "./constants";

export { SESSION_COOKIE_NAME };

/**
 * Custom database-session implementation (deliberate deviation — see
 * docs/DECISION_REGISTER.md and the Phase 1 report). Auth.js v5's
 * Credentials provider does not cleanly support the `session: "database"`
 * strategy CLAUDE.md requires: `authorize()` returning a user does not
 * trigger `adapter.createSession`, and community guidance confirms this
 * combination needs to be wired manually. Rather than force a fragile
 * integration we cannot exercise end-to-end in this environment, Phase 1
 * implements its own small, directly-testable DB session layer against the
 * same `Session` table Auth.js's adapter contract expects — so a real
 * Auth.js OAuth/SSO provider (AD-4, later phase) can be added on top of the
 * same schema without a migration.
 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export interface CreatedSession {
  rawToken: string;
  expires: Date;
}

/** The RAW token is returned once, for the cookie — only its SHA-256 hash
 * is ever persisted, so a database leak alone cannot be replayed as a valid
 * session (mirrors why we never store plaintext passwords). */
export async function createSession(userId: string): Promise<CreatedSession> {
  const rawToken = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  const db = getIdentityClient();
  await db.session.create({
    data: { sessionToken: hashToken(rawToken), userId, expires },
  });
  return { rawToken, expires };
}

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

export interface ResolvedSession {
  sessionId: string;
  user: SessionUser;
}

/** Looks up a session by its token hash, and enforces both expiry and
 * disabled-user checks — a disabled user's existing sessions stop working
 * immediately, not just their next sign-in attempt. Expired/invalidated
 * sessions are deleted opportunistically so they cannot be replayed. */
export async function resolveSession(rawToken: string): Promise<ResolvedSession | null> {
  const db = getIdentityClient();
  const session = await db.session.findUnique({
    where: { sessionToken: hashToken(rawToken) },
    include: { user: true },
  });
  if (!session) return null;

  if (session.expires < new Date() || session.user.isDisabled) {
    await db.session.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }

  return {
    sessionId: session.id,
    user: { id: session.user.id, email: session.user.email, name: session.user.name },
  };
}

export async function invalidateSession(rawToken: string): Promise<void> {
  const db = getIdentityClient();
  await db.session.deleteMany({ where: { sessionToken: hashToken(rawToken) } });
}

/** Admin "sign out everywhere" capability (PHASE_01_FOUNDATION §5: "session
 * invalidation capability"). */
export async function invalidateAllSessionsForUser(userId: string): Promise<void> {
  const db = getIdentityClient();
  await db.session.deleteMany({ where: { userId } });
}
