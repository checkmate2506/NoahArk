import { z } from "zod";

// F-10 (Phase 1B): known placeholder/example secret values that must never
// be accepted as a real AUTH_SECRET, however long they happen to be —
// `.env.example`'s own placeholder text is >=32 characters and would
// otherwise pass the length-only check below. Matched case-insensitively
// against the whole value AND checked for low entropy (a repeated
// character run), since a placeholder swapped for "aaaaaaaa...a" would
// dodge an exact-string list.
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-random-secret",
  "changeme",
  "change-me",
  "secret",
  "password",
  "your-secret-here",
  "your-secret-key",
  "test-secret",
  "development-secret",
]);

function isLowEntropySecret(value: string): boolean {
  // Flags a value where a single character (case-insensitive) makes up
  // more than 60% of it — catches "aaaaaaaa...a" and similar padding
  // tricks used to satisfy a length check without real randomness.
  const counts = new Map<string, number>();
  for (const ch of value.toLowerCase()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const maxCount = Math.max(...counts.values());
  return maxCount / value.length > 0.6;
}

const AuthSecretSchema = z
  .string()
  .min(32, "AUTH_SECRET must be at least 32 characters")
  .superRefine((value, ctx) => {
    if (KNOWN_PLACEHOLDER_SECRETS.has(value.toLowerCase())) {
      ctx.addIssue({
        code: "custom",
        message: "AUTH_SECRET is a known placeholder value — generate a real secret",
      });
    }
    if (isLowEntropySecret(value)) {
      ctx.addIssue({
        code: "custom",
        message: "AUTH_SECRET has too little entropy to be a real secret",
      });
    }
  });

// N-3 (Phase 1D): this is the APPLICATION RUNTIME env schema — the one
// `loadEnv()` validates, and `loadEnv()` is called from real request-handling
// code (apps/web/lib/services/mfaService.ts, fileServiceWrapper.ts), not
// from tooling. It deliberately does NOT declare DATABASE_MIGRATION_URL
// (owner/superuser role — bypasses RLS entirely) or DATABASE_WORKER_URL
// (cross-tenant queue-polling role): the running app must be able to boot
// and serve requests with only a least-privileged `noahark_app` connection.
// Requiring either administrative credential here would mean a compromised
// or misconfigured app process could never even START without secrets it
// has no legitimate use for at request time.
//
// Migration/seed/provisioning tooling (packages/db/src/systemClient.ts,
// prisma/seed.ts, prisma.config.ts, provisioning/provision-roles.mjs) and
// the worker's queue client (packages/db/src/workerClient.ts) read
// `process.env.DATABASE_MIGRATION_URL` / `DATABASE_WORKER_URL` directly,
// each with its own explicit "is it set?" guard — they intentionally do NOT
// go through this schema, so adding a field here would not even affect
// them. If a future script wants well-formedness validation of its own
// migration URL, use `z.url().parse(process.env.X)` locally rather than
// widening this shared runtime schema.
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

    DATABASE_URL: z.url(),

    AUTH_SECRET: AuthSecretSchema,
    AUTH_URL: z.url(),

    FILES_LOCAL_ROOT: z.string().min(1),

    // "console" is the only production-safe-by-default value in Phase 1 —
    // real provider selection is deferred (AD-3).
    EMAIL_PROVIDER: z.enum(["console"]).default("console"),

    // Comma-separated list of origins allowed to make cookie-authenticated
    // state-changing requests (F-8) — see apps/web's csrf.ts. Defaults to
    // AUTH_URL's own origin if unset.
    TRUSTED_ORIGINS: z.string().optional(),

    // F-9 (Phase 1B.1): number of trusted reverse-proxy hops in front of
    // this app — used to safely extract the real client IP from
    // X-Forwarded-For for rate limiting (apps/web/lib/rateLimiter.ts).
    // Defaults to "0" (no proxy trusted, IP-dimension rate limiting
    // disabled) — the safe default, since trusting an unconfigured value
    // would let a client spoof its own rate-limit key via the header.
    TRUSTED_PROXY_COUNT: z.string().optional(),

    // F-14/E2E (Phase 1B.1): activates test-only capture of "sent" emails
    // (apps/web/lib/testEmailCapture.ts) so an E2E suite driving the real
    // product can retrieve a verification/invitation link. Doubly gated —
    // this alone is NOT sufficient to activate capture; NODE_ENV !==
    // "production" is also required, checked again in code, so a stray
    // "1" surviving into a production .env is still inert. Must be exactly
    // "1" — anything else (including "true") is treated as unset.
    TEST_NOTIFICATION_CAPTURE: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // F-10: production gets a stricter bar — reject anything that merely
    // scrapes past the length/placeholder checks above but is still
    // obviously not independently generated per environment (e.g. reusing
    // a value that looks exactly like the documented example format).
    if (env.NODE_ENV === "production" && env.AUTH_SECRET.length < 44) {
      ctx.addIssue({
        code: "custom",
        path: ["AUTH_SECRET"],
        message:
          "AUTH_SECRET must be at least 44 characters in production (e.g. `openssl rand -base64 32`)",
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Parses and validates process.env once per process. Throws a descriptive
 * ValidationError-shaped ZodError on first use if required variables are
 * missing or malformed — fail fast at boot, not deep inside a request. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test-only escape hatch so unit tests can reset the cache between cases. */
export function __resetEnvCacheForTests(): void {
  cached = undefined;
}
