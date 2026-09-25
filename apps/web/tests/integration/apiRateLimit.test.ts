import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RateLimitedError, type AccessContext } from "@noahark/core";
import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import { getIdentityClient } from "@noahark/db";
import { createSystemClient } from "@noahark/db/system";
import * as db from "@noahark/db";
import {
  API_WRITE_MAX_PER_TENANT,
  API_WRITE_MAX_PER_TENANT_USER,
  API_WRITE_TENANT,
  API_WRITE_TENANT_USER,
  API_WRITE_WINDOW_MS,
  RETENTION_MS,
  apiWriteCanonicalKey,
  apiWriteWindowStart,
  cleanupExpiredBuckets,
  consumeApiWriteAllowance,
  hashKey,
  type ApiWriteRateLimitPolicy,
} from "@/lib/rateLimiter";
import { enforceTenantWriteRateLimit } from "@/lib/api/apiRateLimit";
import { tenantWriteRoute } from "@/lib/api/tenantRoute";

vi.mock("@/lib/context", () => ({
  resolveTenantContext: vi.fn(),
}));

import { resolveTenantContext } from "@/lib/context";

const resolveTenantContextMock = vi.mocked(resolveTenantContext);

function ids(label: string) {
  const suffix = randomUUID();
  return {
    tenantId: `tenant-${label}-${suffix}`,
    userId: `user-${label}-${suffix}`,
  };
}

function access(tenantId: string, userId: string): AccessContext {
  return {
    requestId: "req-limit",
    userId,
    tenantId,
    legalEntityIds: new Set(["le-a"]),
    permissions: new Set([PERMISSIONS.PARTY_CREATE]),
    legalEntityPermissions: new Map(),
    roleIds: new Set(),
    legalEntityRoleIds: new Map(),
  };
}

async function bucketCount(
  dimension: "EMAIL" | "IP",
  canonicalKey: string,
  windowStart: Date,
): Promise<number | null> {
  const sys = createSystemClient();
  const row = await sys.authRateLimitBucket.findUnique({
    where: {
      dimension_keyHash_windowStart: {
        dimension,
        keyHash: hashKey(canonicalKey),
        windowStart,
      },
    },
  });
  return row?.attemptCount ?? null;
}

describe("API write limiter (T-11, real PostgreSQL)", () => {
  afterEach(() => {
    resolveTenantContextMock.mockReset();
    vi.restoreAllMocks();
  });

  it("uses a disposable test database, never persistent noahark", () => {
    const url = process.env.DATABASE_URL;
    expect(url).toBeTruthy();
    const name = new URL(url ?? "").pathname.replace(/^\//, "");
    expect(name.startsWith("noahark_test_")).toBe(true);
    expect(name).not.toBe("noahark");
  });

  it("records PostgreSQL version", async () => {
    const sys = createSystemClient();
    const rows = await sys.$queryRaw<Array<{ version: string }>>`SELECT version()`;
    expect(rows[0]?.version).toMatch(/^PostgreSQL /);
  });

  it("allows the first N tenant-user writes and rejects N+1 as RATE_LIMITED", async () => {
    const { tenantId, userId } = ids("user-cap");
    const now = Date.now();
    const policy = { tenantUserMax: 3, tenantMax: 100, windowMs: API_WRITE_WINDOW_MS };
    for (let i = 0; i < policy.tenantUserMax; i++) {
      expect(await consumeApiWriteAllowance({ tenantId, userId }, { now, policy })).toBe(
        "ok",
      );
    }
    expect(await consumeApiWriteAllowance({ tenantId, userId }, { now, policy })).toBe(
      "limited",
    );
    await expect(
      enforceTenantWriteRateLimit(access(tenantId, userId), { now, policy }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("enforces the tenant aggregate dimension independently of the user dimension", async () => {
    const tenantId = `tenant-agg-${randomUUID()}`;
    const policy = { tenantUserMax: 50, tenantMax: 4, windowMs: API_WRITE_WINDOW_MS };
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      expect(
        await consumeApiWriteAllowance(
          { tenantId, userId: `user-agg-${i}-${randomUUID()}` },
          { now, policy },
        ),
      ).toBe("ok");
    }
    expect(
      await consumeApiWriteAllowance(
        { tenantId, userId: `user-agg-overflow-${randomUUID()}` },
        { now, policy },
      ),
    ).toBe("limited");
  });

  it("keeps a different user independent until the tenant aggregate is reached", async () => {
    const tenantId = `tenant-users-${randomUUID()}`;
    const userA = `user-a-${randomUUID()}`;
    const userB = `user-b-${randomUUID()}`;
    const now = Date.now();
    const policy: ApiWriteRateLimitPolicy = {
      tenantUserMax: 3,
      tenantMax: 5,
      windowMs: API_WRITE_WINDOW_MS,
    };
    for (let i = 0; i < 3; i++) {
      expect(
        await consumeApiWriteAllowance({ tenantId, userId: userA }, { now, policy }),
      ).toBe("ok");
    }
    expect(
      await consumeApiWriteAllowance({ tenantId, userId: userB }, { now, policy }),
    ).toBe("ok");
    expect(
      await consumeApiWriteAllowance({ tenantId, userId: userB }, { now, policy }),
    ).toBe("ok");
    expect(
      await consumeApiWriteAllowance({ tenantId, userId: userB }, { now, policy }),
    ).toBe("limited");
    expect(
      await consumeApiWriteAllowance({ tenantId, userId: userA }, { now, policy }),
    ).toBe("limited");
  });

  it("does not consume another tenant's bucket", async () => {
    const tenantA = `tenant-iso-a-${randomUUID()}`;
    const tenantB = `tenant-iso-b-${randomUUID()}`;
    const userA = `user-iso-a-${randomUUID()}`;
    const userB = `user-iso-b-${randomUUID()}`;
    const now = Date.now();
    const policy = { tenantUserMax: 2, tenantMax: 2, windowMs: API_WRITE_WINDOW_MS };
    expect(
      await consumeApiWriteAllowance(
        { tenantId: tenantA, userId: userA },
        { now, policy },
      ),
    ).toBe("ok");
    expect(
      await consumeApiWriteAllowance(
        { tenantId: tenantA, userId: userA },
        { now, policy },
      ),
    ).toBe("ok");
    expect(
      await consumeApiWriteAllowance(
        { tenantId: tenantA, userId: userA },
        { now, policy },
      ),
    ).toBe("limited");
    expect(
      await consumeApiWriteAllowance(
        { tenantId: tenantB, userId: userB },
        { now, policy },
      ),
    ).toBe("ok");
  });

  it("rolls over when the fixed window elapses", async () => {
    const { tenantId, userId } = ids("window");
    const now = Date.now();
    const policy = { tenantUserMax: 1, tenantMax: 10, windowMs: API_WRITE_WINDOW_MS };
    expect(await consumeApiWriteAllowance({ tenantId, userId }, { now, policy })).toBe(
      "ok",
    );
    expect(await consumeApiWriteAllowance({ tenantId, userId }, { now, policy })).toBe(
      "limited",
    );
    expect(
      await consumeApiWriteAllowance(
        { tenantId, userId },
        { now: now + API_WRITE_WINDOW_MS + 1, policy },
      ),
    ).toBe("ok");
  });

  it("concurrent increments cannot exceed the configured allowance and do not lose updates", async () => {
    const { tenantId, userId } = ids("concurrent");
    const now = Date.now();
    const policy = { tenantUserMax: 5, tenantMax: 100, windowMs: API_WRITE_WINDOW_MS };
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        consumeApiWriteAllowance({ tenantId, userId }, { now, policy }),
      ),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(5);
    expect(results.filter((r) => r === "limited")).toHaveLength(15);
    const windowStart = apiWriteWindowStart(now, policy.windowMs);
    expect(
      await bucketCount(
        "EMAIL",
        apiWriteCanonicalKey(API_WRITE_TENANT_USER, tenantId, userId),
        windowStart,
      ),
    ).toBe(20);
  });

  it("fails open on recognised infrastructure failure and does not treat exhaustion as infrastructure failure", async () => {
    const { tenantId, userId } = ids("failopen");
    const now = Date.now();
    const policy = { tenantUserMax: 1, tenantMax: 1, windowMs: API_WRITE_WINDOW_MS };
    const spy = vi.spyOn(db, "getIdentityClient").mockReturnValue({
      $transaction: async () => {
        throw Object.assign(new Error("connect"), { code: "ECONNREFUSED" });
      },
    } as never);
    try {
      expect(await consumeApiWriteAllowance({ tenantId, userId }, { now, policy })).toBe(
        "ok",
      );
      await expect(
        enforceTenantWriteRateLimit(access(tenantId, userId), { now, policy }),
      ).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(await consumeApiWriteAllowance({ tenantId, userId }, { now, policy })).toBe(
      "ok",
    );
    expect(await consumeApiWriteAllowance({ tenantId, userId }, { now, policy })).toBe(
      "limited",
    );
  });

  it("rolls back both buckets when the second increment fails after the first would succeed", async () => {
    const { tenantId, userId } = ids("atomic");
    const now = Date.now();
    const policy = { tenantUserMax: 10, tenantMax: 10, windowMs: API_WRITE_WINDOW_MS };
    const windowStart = apiWriteWindowStart(now, policy.windowMs);
    const userKey = apiWriteCanonicalKey(API_WRITE_TENANT_USER, tenantId, userId);
    const tenantKey = apiWriteCanonicalKey(API_WRITE_TENANT, tenantId);
    const real = getIdentityClient();

    const failSecond = vi.spyOn(db, "getIdentityClient").mockImplementation(
      () =>
        ({
          $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
            real.$transaction(async (tx) => {
              let n = 0;
              const wrapped = {
                $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
                  n += 1;
                  if (n === 2) {
                    throw Object.assign(new Error("read ECONNRESET"), {
                      code: "ECONNRESET",
                    });
                  }
                  return tx.$queryRaw(strings, ...values);
                },
              };
              return fn(wrapped);
            }),
        }) as never,
    );
    try {
      expect(await consumeApiWriteAllowance({ tenantId, userId }, { now, policy })).toBe(
        "ok",
      );
      expect(await bucketCount("EMAIL", userKey, windowStart)).toBeNull();
      expect(await bucketCount("IP", tenantKey, windowStart)).toBeNull();
    } finally {
      failSecond.mockRestore();
    }

    const invariantSecond = vi.spyOn(db, "getIdentityClient").mockImplementation(
      () =>
        ({
          $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
            real.$transaction(async (tx) => {
              let n = 0;
              const wrapped = {
                $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
                  n += 1;
                  if (n === 2) return [{ attempt_count: "nope" }];
                  return tx.$queryRaw(strings, ...values);
                },
              };
              return fn(wrapped);
            }),
        }) as never,
    );
    try {
      await expect(
        consumeApiWriteAllowance({ tenantId, userId }, { now, policy }),
      ).rejects.toThrow(/non-integer count/);
      expect(await bucketCount("EMAIL", userKey, windowStart)).toBeNull();
      expect(await bucketCount("IP", tenantKey, windowStart)).toBeNull();
    } finally {
      invariantSecond.mockRestore();
    }

    expect(await consumeApiWriteAllowance({ tenantId, userId }, { now, policy })).toBe(
      "ok",
    );
    expect(await bucketCount("EMAIL", userKey, windowStart)).toBe(1);
    expect(await bucketCount("IP", tenantKey, windowStart)).toBe(1);
  });

  it("cleanup removes expired buckets only", async () => {
    const { tenantId, userId } = ids("cleanup");
    const now = Date.now();
    const policy = { tenantUserMax: 10, tenantMax: 10, windowMs: API_WRITE_WINDOW_MS };
    expect(await consumeApiWriteAllowance({ tenantId, userId }, { now, policy })).toBe(
      "ok",
    );
    const sys = createSystemClient();
    const staleHash = hashKey(
      apiWriteCanonicalKey(API_WRITE_TENANT_USER, `stale-${randomUUID()}`, "user"),
    );
    await sys.authRateLimitBucket.create({
      data: {
        dimension: "EMAIL",
        keyHash: staleHash,
        windowStart: new Date(now - RETENTION_MS - 60_000),
        attemptCount: 4,
      },
    });
    const deleted = await cleanupExpiredBuckets(now);
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(
      await sys.authRateLimitBucket.findFirst({ where: { keyHash: staleHash } }),
    ).toBeNull();
    expect(
      await bucketCount(
        "EMAIL",
        apiWriteCanonicalKey(API_WRITE_TENANT_USER, tenantId, userId),
        apiWriteWindowStart(now, policy.windowMs),
      ),
    ).toBe(1);
  });

  it("tenantWriteRoute uses the production limiter and returns 429 without a business route", async () => {
    const { tenantId, userId } = ids("route");
    const handler = vi.fn(async () => jsonOk({ ok: true }));
    resolveTenantContextMock.mockResolvedValue(access(tenantId, userId));
    const route = tenantWriteRoute({
      permission: PERMISSIONS.PARTY_CREATE,
      handler,
    });
    const invoke = () =>
      route(
        new Request("https://noahark.example/api/v1/tenants/t/parties", {
          method: "POST",
        }),
        { params: Promise.resolve({ tenantId }) },
      );
    expect((await invoke()).status).toBe(200);
    for (let i = 1; i < API_WRITE_MAX_PER_TENANT_USER; i++) {
      expect(await consumeApiWriteAllowance({ tenantId, userId })).toBe("ok");
    }
    const limited = await invoke();
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { error: { code: string } };
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(API_WRITE_MAX_PER_TENANT_USER).toBe(120);
    expect(API_WRITE_MAX_PER_TENANT).toBe(1_200);
    expect(API_WRITE_TENANT_USER).toBe("API_WRITE_TENANT_USER");
    expect(API_WRITE_TENANT).toBe("API_WRITE_TENANT");
  });
});
