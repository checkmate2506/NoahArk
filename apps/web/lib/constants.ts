/** Deliberately dependency-free (no @noahark/db import) — middleware.ts runs
 * on the Edge runtime and must not bundle Node-only code (the `pg` driver,
 * argon2 bindings) that a `./session.js` import would drag in. */
export const SESSION_COOKIE_NAME = "noahark_session";
