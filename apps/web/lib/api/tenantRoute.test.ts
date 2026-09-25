import { describe, expect, it, vi, beforeEach } from "vitest";
import { jsonOk } from "@/lib/apiHandler";
import { PERMISSIONS } from "@noahark/authz";
import {
  ForbiddenError,
  RateLimitedError,
  UnauthenticatedError,
  type AccessContext,
} from "@noahark/core";
import { tenantReadPostRoute, tenantReadRoute, tenantWriteRoute } from "./tenantRoute";
import * as tenantRouteModule from "./tenantRoute";
import {
  API_WRITE_TENANT,
  API_WRITE_TENANT_USER,
  apiWriteCanonicalKey,
  consumeApiWriteAllowance,
  hashKey,
} from "@/lib/rateLimiter";

vi.mock("@/lib/context", () => ({
  resolveTenantContext: vi.fn(),
}));

vi.mock("@/lib/api/apiRateLimit", async (importOriginal) => {
  const actual = (await importOriginal()) as {
    enforceTenantWriteRateLimit: typeof enforceTenantWriteRateLimit;
  };
  return {
    ...actual,
    enforceTenantWriteRateLimit: vi.fn(actual.enforceTenantWriteRateLimit),
  };
});

import { resolveTenantContext } from "@/lib/context";
import { enforceTenantWriteRateLimit } from "./apiRateLimit";
import * as db from "@noahark/db";

const resolveTenantContextMock = vi.mocked(resolveTenantContext);
const enforceWriteMock = vi.mocked(enforceTenantWriteRateLimit);

function ctx(overrides: Partial<AccessContext> = {}): AccessContext {
  return {
    requestId: "req-p2d1",
    userId: "user-1",
    tenantId: "tenant-1",
    legalEntityIds: new Set(["le-a", "le-b"]),
    permissions: new Set([PERMISSIONS.PARTY_READ]),
    legalEntityPermissions: new Map(),
    roleIds: new Set(),
    legalEntityRoleIds: new Map(),
    ...overrides,
  };
}

function makeRequest(init: RequestInit & { url?: string } = {}): Request {
  const requestInit: RequestInit = { method: init.method ?? "GET" };
  if (init.headers !== undefined) requestInit.headers = init.headers;
  if (init.body !== undefined) requestInit.body = init.body;
  return new Request(
    init.url ?? "https://noahark.example/api/v1/tenants/tenant-1/parties",
    requestInit,
  );
}

type AnyTenantRoute =
  | ReturnType<typeof tenantReadRoute>
  | ReturnType<typeof tenantReadPostRoute>
  | ReturnType<typeof tenantWriteRoute>;

async function invoke(
  route: AnyTenantRoute,
  req: Request,
  tenantId = "tenant-1",
): Promise<Response> {
  return route(req, { params: Promise.resolve({ tenantId }) });
}

async function readError(res: Response): Promise<{
  error: { code: string; message: string; requestId: string };
}> {
  return (await res.json()) as {
    error: { code: string; message: string; requestId: string };
  };
}

async function useRealWriteLimiter(): Promise<void> {
  const actual = (await vi.importActual("./apiRateLimit")) as {
    enforceTenantWriteRateLimit: typeof enforceTenantWriteRateLimit;
  };
  enforceWriteMock.mockImplementation(actual.enforceTenantWriteRateLimit);
}

function mockIdentityTransaction(queryRaw: ReturnType<typeof vi.fn>) {
  return vi.spyOn(db, "getIdentityClient").mockReturnValue({
    $transaction: async (fn: (tx: { $queryRaw: typeof queryRaw }) => Promise<unknown>) =>
      fn({ $queryRaw: queryRaw }),
  } as never);
}

function infraError(code: string): Error {
  return Object.assign(new Error("limiter infrastructure"), { code });
}

describe("tenant route constructors", () => {
  const handler = vi.fn(async () => jsonOk({ ok: true }));

  beforeEach(() => {
    handler.mockClear();
    handler.mockImplementation(async () => jsonOk({ ok: true }));
    resolveTenantContextMock.mockReset();
    enforceWriteMock.mockReset();
    enforceWriteMock.mockResolvedValue(undefined);
  });

  it("does not export a generic tenantRoute helper", () => {
    expect("tenantRoute" in tenantRouteModule).toBe(false);
  });

  it("returns 401 when unauthenticated and does not call the handler", async () => {
    resolveTenantContextMock.mockRejectedValue(new UnauthenticatedError());
    const route = tenantReadRoute({
      permission: PERMISSIONS.PARTY_READ,
      handler,
    });
    const res = await invoke(
      route,
      makeRequest({ headers: { "x-request-id": "rid-401" } }),
    );
    expect(res.status).toBe(401);
    const body = await readError(res);
    expect(body.error.code).toBe("UNAUTHENTICATED");
    expect(body.error.requestId).toBe("rid-401");
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 403 when the session has no active tenant membership", async () => {
    resolveTenantContextMock.mockRejectedValue(
      new ForbiddenError("No active membership in this tenant"),
    );
    const route = tenantReadRoute({
      permission: PERMISSIONS.PARTY_READ,
      handler,
    });
    const res = await invoke(
      route,
      makeRequest({ headers: { "x-request-id": "rid-403m" } }),
    );
    expect(res.status).toBe(403);
    const body = await readError(res);
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.requestId).toBe("rid-403m");
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 403 when the required permission is missing", async () => {
    resolveTenantContextMock.mockResolvedValue(ctx({ permissions: new Set() }));
    const route = tenantWriteRoute({
      permission: PERMISSIONS.PARTY_CREATE,
      handler,
    });
    const res = await invoke(route, makeRequest({ method: "POST" }));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(enforceWriteMock).not.toHaveBeenCalled();
  });

  it("returns 403 when only a neighbouring permission is held", async () => {
    resolveTenantContextMock.mockResolvedValue(
      ctx({ permissions: new Set([PERMISSIONS.PARTY_READ]) }),
    );
    const route = tenantWriteRoute({
      permission: PERMISSIONS.PARTY_CREATE,
      handler,
    });
    const res = await invoke(route, makeRequest({ method: "POST" }));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("allows a tenant-wide permission for legalEntityId null (T-3)", async () => {
    const access = ctx({ permissions: new Set([PERMISSIONS.PARTY_CREATE]) });
    resolveTenantContextMock.mockResolvedValue(access);
    let seen: AccessContext | undefined;
    const route = tenantWriteRoute({
      permission: PERMISSIONS.PARTY_CREATE,
      handler: async (_req, _requestId, _params, requestCtx) => {
        seen = requestCtx;
        return jsonOk({ ok: true });
      },
    });
    const res = await invoke(route, makeRequest({ method: "POST" }));
    expect(res.status).toBe(200);
    expect(seen).toBe(access);
  });

  it("refuses an entity-scoped-only permission for legalEntityId null (T-3)", async () => {
    resolveTenantContextMock.mockResolvedValue(
      ctx({
        permissions: new Set(),
        legalEntityPermissions: new Map([["le-a", new Set([PERMISSIONS.PARTY_CREATE])]]),
      }),
    );
    const route = tenantWriteRoute({
      permission: PERMISSIONS.PARTY_CREATE,
      handler,
    });
    const res = await invoke(route, makeRequest({ method: "POST" }));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(enforceWriteMock).not.toHaveBeenCalled();
  });

  it("allows the matching explicit legal-entity permission", async () => {
    const access = ctx({
      permissions: new Set(),
      legalEntityPermissions: new Map([["le-a", new Set([PERMISSIONS.PARTY_CREATE])]]),
    });
    resolveTenantContextMock.mockResolvedValue(access);
    const route = tenantWriteRoute({
      permission: PERMISSIONS.PARTY_CREATE,
      handler,
      legalEntityIdFrom: () => "le-a",
    });
    const res = await invoke(route, makeRequest({ method: "POST" }));
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("refuses a permission held only for a different legal entity", async () => {
    resolveTenantContextMock.mockResolvedValue(
      ctx({
        permissions: new Set(),
        legalEntityPermissions: new Map([["le-a", new Set([PERMISSIONS.PARTY_CREATE])]]),
      }),
    );
    const route = tenantWriteRoute({
      permission: PERMISSIONS.PARTY_CREATE,
      handler,
      legalEntityIdFrom: () => "le-b",
    });
    const res = await invoke(route, makeRequest({ method: "POST" }));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not invoke the write limiter for GET reads", async () => {
    resolveTenantContextMock.mockResolvedValue(ctx());
    const route = tenantReadRoute({
      permission: PERMISSIONS.PARTY_READ,
      handler,
    });
    const res = await invoke(route, makeRequest());
    expect(res.status).toBe(200);
    expect(enforceWriteMock).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not invoke the write limiter for read-only POST", async () => {
    resolveTenantContextMock.mockResolvedValue(ctx());
    const route = tenantReadPostRoute({
      permission: PERMISSIONS.PARTY_READ,
      handler,
    });
    const res = await invoke(route, makeRequest({ method: "POST" }));
    expect(res.status).toBe(200);
    expect(enforceWriteMock).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("invokes the shared write limiter (both buckets) inside one transaction", async () => {
    const access = ctx({ permissions: new Set([PERMISSIONS.PARTY_CREATE]) });
    resolveTenantContextMock.mockResolvedValue(access);
    await useRealWriteLimiter();
    const queryRaw = vi.fn().mockResolvedValue([{ attempt_count: 1 }]);
    const identitySpy = mockIdentityTransaction(queryRaw);
    try {
      const route = tenantWriteRoute({
        permission: PERMISSIONS.PARTY_CREATE,
        handler,
      });
      const res = await invoke(route, makeRequest({ method: "POST" }));
      expect(res.status).toBe(200);
      expect(queryRaw).toHaveBeenCalledTimes(2);
    } finally {
      identitySpy.mockRestore();
    }
  });

  it("returns 429 when the write limiter rejects and does not call the handler", async () => {
    resolveTenantContextMock.mockResolvedValue(
      ctx({ permissions: new Set([PERMISSIONS.PARTY_CREATE]) }),
    );
    enforceWriteMock.mockRejectedValue(
      new RateLimitedError("Too many write attempts — try again later"),
    );
    const route = tenantWriteRoute({
      permission: PERMISSIONS.PARTY_CREATE,
      handler,
    });
    const res = await invoke(
      route,
      makeRequest({ method: "POST", headers: { "x-request-id": "rid-429" } }),
    );
    expect(res.status).toBe(429);
    const body = await readError(res);
    expect(body.error.code).toBe("RATE_LIMITED");
    expect(body.error.requestId).toBe("rid-429");
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails open on recognised infrastructure failure", async () => {
    resolveTenantContextMock.mockResolvedValue(
      ctx({ permissions: new Set([PERMISSIONS.PARTY_CREATE]) }),
    );
    await useRealWriteLimiter();
    const identitySpy = vi.spyOn(db, "getIdentityClient").mockReturnValue({
      $transaction: async () => {
        throw infraError("ECONNREFUSED");
      },
    } as never);
    try {
      const route = tenantWriteRoute({
        permission: PERMISSIONS.PARTY_CREATE,
        handler,
      });
      const res = await invoke(route, makeRequest({ method: "POST" }));
      expect(res.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      identitySpy.mockRestore();
    }
  });

  it("does not fail open on a malformed count and does not call the handler", async () => {
    resolveTenantContextMock.mockResolvedValue(
      ctx({ permissions: new Set([PERMISSIONS.PARTY_CREATE]) }),
    );
    await useRealWriteLimiter();
    const identitySpy = mockIdentityTransaction(
      vi.fn().mockResolvedValue([{ attempt_count: "nope" }]),
    );
    try {
      const route = tenantWriteRoute({
        permission: PERMISSIONS.PARTY_CREATE,
        handler,
      });
      const res = await invoke(
        route,
        makeRequest({ method: "POST", headers: { "x-request-id": "rid-count" } }),
      );
      expect(res.status).toBe(500);
      const body = await readError(res);
      expect(body.error.code).toBe("INTERNAL_ERROR");
      expect(body.error.message).not.toMatch(/nope|tenant-1|user-1|Prisma|SQL/i);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      identitySpy.mockRestore();
    }
  });

  it("propagates an unknown limiter error and does not call the handler", async () => {
    resolveTenantContextMock.mockResolvedValue(
      ctx({ permissions: new Set([PERMISSIONS.PARTY_CREATE]) }),
    );
    await useRealWriteLimiter();
    const identitySpy = vi.spyOn(db, "getIdentityClient").mockReturnValue({
      $transaction: async () => {
        throw new Error("unexpected limiter bug");
      },
    } as never);
    try {
      const route = tenantWriteRoute({
        permission: PERMISSIONS.PARTY_CREATE,
        handler,
      });
      const res = await invoke(route, makeRequest({ method: "POST" }));
      expect(res.status).toBe(500);
      const body = await readError(res);
      expect(body.error.code).toBe("INTERNAL_ERROR");
      expect(body.error.message).not.toMatch(/unexpected limiter bug/);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      identitySpy.mockRestore();
    }
  });

  it("propagates configuration errors and does not call the handler", async () => {
    resolveTenantContextMock.mockResolvedValue(
      ctx({ permissions: new Set([PERMISSIONS.PARTY_CREATE]) }),
    );
    await useRealWriteLimiter();
    await expect(
      consumeApiWriteAllowance(
        { tenantId: "tenant-1", userId: "user-1" },
        { policy: { tenantUserMax: 0, tenantMax: 1, windowMs: 1000 } },
      ),
    ).rejects.toThrow(/tenantUserMax/);
    const route = tenantWriteRoute({
      permission: PERMISSIONS.PARTY_CREATE,
      handler,
    });
    const identitySpy = vi.spyOn(db, "getIdentityClient").mockReturnValue({
      $transaction: async () => {
        throw new TypeError("cannot read");
      },
    } as never);
    try {
      const res = await invoke(route, makeRequest({ method: "POST" }));
      expect(res.status).toBe(500);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      identitySpy.mockRestore();
    }
  });

  it("fails closed when the HTTP method does not match the constructor", async () => {
    resolveTenantContextMock.mockResolvedValue(ctx());
    const read = tenantReadRoute({
      permission: PERMISSIONS.PARTY_READ,
      handler,
    });
    const write = tenantWriteRoute({
      permission: PERMISSIONS.PARTY_CREATE,
      handler,
    });
    const readPost = tenantReadPostRoute({
      permission: PERMISSIONS.PARTY_READ,
      handler,
    });
    const getOnWrite = await invoke(write, makeRequest({ method: "GET" }));
    expect(getOnWrite.status).toBe(403);
    const postOnRead = await invoke(read, makeRequest({ method: "POST" }));
    expect(postOnRead.status).toBe(403);
    const getOnReadPost = await invoke(readPost, makeRequest({ method: "GET" }));
    expect(getOnReadPost.status).toBe(403);
    const deleteOnWrite = await invoke(write, makeRequest({ method: "DELETE" }));
    expect(deleteOnWrite.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect(resolveTenantContextMock).not.toHaveBeenCalled();
    expect(enforceWriteMock).not.toHaveBeenCalled();
  });

  it("allows PUT and PATCH through tenantWriteRoute after the limiter", async () => {
    resolveTenantContextMock.mockResolvedValue(
      ctx({ permissions: new Set([PERMISSIONS.PARTY_CREATE]) }),
    );
    const route = tenantWriteRoute({
      permission: PERMISSIONS.PARTY_CREATE,
      handler,
    });
    expect((await invoke(route, makeRequest({ method: "PUT" }))).status).toBe(200);
    expect((await invoke(route, makeRequest({ method: "PATCH" }))).status).toBe(200);
    expect(enforceWriteMock).toHaveBeenCalledTimes(2);
  });

  it("passes a clone to legalEntityIdFrom so the handler can still read the body", async () => {
    const access = ctx({
      permissions: new Set(),
      legalEntityPermissions: new Map([["le-a", new Set([PERMISSIONS.PARTY_CREATE])]]),
    });
    resolveTenantContextMock.mockResolvedValue(access);
    let resolverBody = "";
    let handlerBody = "";
    const route = tenantWriteRoute({
      permission: PERMISSIONS.PARTY_CREATE,
      legalEntityIdFrom: async (req) => {
        resolverBody = await req.text();
        return "le-a";
      },
      handler: async (req) => {
        handlerBody = await req.text();
        return jsonOk({ ok: true });
      },
    });
    const payload = JSON.stringify({ expectedVersion: 1, legalEntityId: "forged" });
    const res = await invoke(
      route,
      makeRequest({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      }),
    );
    expect(res.status).toBe(200);
    expect(resolverBody).toBe(payload);
    expect(handlerBody).toBe(payload);
  });

  it("uses session-resolved trusted context, not body-supplied actor fields", async () => {
    const access = ctx({
      userId: "session-user",
      tenantId: "tenant-1",
      requestId: "req-p2d1",
      permissions: new Set([PERMISSIONS.PARTY_READ]),
    });
    resolveTenantContextMock.mockResolvedValue(access);
    let seen: AccessContext | undefined;
    const route = tenantReadRoute({
      permission: PERMISSIONS.PARTY_READ,
      handler: async (_req, _requestId, _params, requestCtx) => {
        seen = requestCtx;
        return jsonOk({ userId: requestCtx.userId, tenantId: requestCtx.tenantId });
      },
    });
    const res = await invoke(
      route,
      makeRequest({
        method: "GET",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    expect(seen).toBe(access);
    expect(seen?.userId).toBe("session-user");
    expect(seen?.tenantId).toBe("tenant-1");
    const json = (await res.json()) as { data: { userId: string; tenantId: string } };
    expect(json.data.userId).toBe("session-user");
    expect(json.data.tenantId).toBe("tenant-1");
  });

  it("propagates the request id into the resolved context path", async () => {
    resolveTenantContextMock.mockResolvedValue(ctx());
    const route = tenantReadRoute({
      permission: PERMISSIONS.PARTY_READ,
      handler,
    });
    await invoke(route, makeRequest({ headers: { "x-request-id": "rid-ctx" } }));
    expect(resolveTenantContextMock).toHaveBeenCalledWith(
      expect.any(Request),
      "rid-ctx",
      "tenant-1",
    );
  });

  it("rejects construction without a permission at runtime", () => {
    expect(() =>
      tenantReadRoute({
        permission: undefined as unknown as typeof PERMISSIONS.PARTY_READ,
        handler,
      }),
    ).toThrow(/permission/);
    expect(() =>
      tenantWriteRoute({
        permission: PERMISSIONS.PARTY_CREATE,
        handler: undefined as never,
      }),
    ).toThrow(/handler/);
  });
});

describe("API write limiter encoding and fail-open classification", () => {
  it("encodes canonical JSON arrays so delimiter-containing identifiers cannot collide", () => {
    const left = apiWriteCanonicalKey(API_WRITE_TENANT_USER, "t:u", "v");
    const right = apiWriteCanonicalKey(API_WRITE_TENANT_USER, "t", "u:v");
    expect(left).toBe(JSON.stringify(["API_WRITE_TENANT_USER", "t:u", "v"]));
    expect(right).toBe(JSON.stringify(["API_WRITE_TENANT_USER", "t", "u:v"]));
    expect(left).not.toBe(right);
    expect(hashKey(left)).not.toBe(hashKey(right));
    const quotedTenant = apiWriteCanonicalKey(
      API_WRITE_TENANT,
      'x","API_WRITE_TENANT_USER","y',
    );
    const userPair = apiWriteCanonicalKey(API_WRITE_TENANT_USER, "x", "y");
    expect(quotedTenant).not.toBe(userPair);
    expect(hashKey(quotedTenant)).not.toBe(hashKey(userPair));
    expect(apiWriteCanonicalKey(API_WRITE_TENANT, "tenant-1")).toBe(
      JSON.stringify(["API_WRITE_TENANT", "tenant-1"]),
    );
  });

  it("fails open only for recognised infrastructure codes, including nested cause", async () => {
    const nested = Object.assign(new Error("wrapper"), {
      cause: infraError("P2024"),
    });
    const spy = vi.spyOn(db, "getIdentityClient").mockReturnValue({
      $transaction: async () => {
        throw nested;
      },
    } as never);
    try {
      await expect(
        consumeApiWriteAllowance({ tenantId: "tenant-1", userId: "user-1" }),
      ).resolves.toBe("ok");
    } finally {
      spy.mockRestore();
    }
  });

  it("does not fail open for Prisma data errors such as P2002", async () => {
    const spy = vi.spyOn(db, "getIdentityClient").mockReturnValue({
      $transaction: async () => {
        throw Object.assign(new Error("unique"), { code: "P2002" });
      },
    } as never);
    try {
      await expect(
        consumeApiWriteAllowance({ tenantId: "tenant-1", userId: "user-1" }),
      ).rejects.toThrow(/unique/);
    } finally {
      spy.mockRestore();
    }
  });
});
