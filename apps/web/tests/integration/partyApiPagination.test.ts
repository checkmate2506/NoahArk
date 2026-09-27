import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import {
  GET as listCreateGet,
  POST as listCreatePost,
} from "@/app/api/v1/tenants/[tenantId]/parties/route";
import { POST as partyArchive } from "@/app/api/v1/tenants/[tenantId]/parties/[partyId]/archive/route";
import {
  GET as contactsGet,
  POST as contactsPost,
} from "@/app/api/v1/tenants/[tenantId]/parties/[partyId]/contacts/route";
import {
  GET as addressesGet,
  POST as addressesPost,
} from "@/app/api/v1/tenants/[tenantId]/parties/[partyId]/addresses/route";
import { createAddress, createContact, createParty } from "@noahark/crm";
import { cleanupTenant, cleanupUser, uniqueSlug } from "./testHelpers";
import {
  partyCode,
  setupPartyDomainFixture,
  type PartyDomainFixture,
} from "./partyDomainFixture";

const { partyApiAuth } = vi.hoisted(() => ({
  partyApiAuth: { userId: undefined as string | undefined },
}));

vi.mock("@/lib/context", async (importOriginal) => {
  const actual = (await importOriginal()) as {
    getAccessContext: (
      userId: string,
      tenantId: string,
      meta: {
        requestId: string;
        ipAddress?: string | undefined;
        userAgent?: string | undefined;
      },
    ) => Promise<unknown>;
    requestMeta: (
      req: Request,
      requestId: string,
    ) => {
      requestId: string;
      ipAddress?: string | undefined;
      userAgent?: string | undefined;
    };
  };
  return {
    ...actual,
    resolveTenantContext: async (req: Request, requestId: string, tenantId: string) => {
      if (!partyApiAuth.userId) throw new UnauthenticatedError();
      return actual.getAccessContext(
        partyApiAuth.userId,
        tenantId,
        actual.requestMeta(req, requestId),
      );
    },
  };
});

async function invoke<P extends { tenantId: string }>(
  handler: (req: Request, ctx: { params: Promise<P> }) => Promise<Response>,
  req: Request,
  params: P,
): Promise<Response> {
  return handler(req, { params: Promise.resolve(params) });
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function request(url: string, init: RequestInit & { json?: unknown } = {}): Request {
  const headers = new Headers(init.headers);
  if (!headers.has("x-request-id")) headers.set("x-request-id", uniqueSlug("rid"));
  const requestInit: RequestInit = { method: init.method ?? "GET", headers };
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    requestInit.body = JSON.stringify(init.json);
  }
  return new Request(url, requestInit);
}

async function collectPages<P extends { tenantId: string }>(
  handler: (req: Request, ctx: { params: Promise<P> }) => Promise<Response>,
  urlBase: string,
  params: P,
  key: "parties" | "contacts" | "addresses",
  limit: number,
) {
  const ids: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const search = new URLSearchParams();
    search.set("limit", String(limit));
    if (cursor) search.set("cursor", cursor);
    const res = await invoke(handler, request(`${urlBase}?${search.toString()}`), params);
    expect(res.status).toBe(200);
    const data = (await readJson(res)).data as {
      nextCursor: string | null;
    } & Record<string, Array<{ id: string; createdAt: string }>>;
    const rows = data[key] ?? [];
    ids.push(...rows.map((r) => r.id));
    if (rows.length > 1) {
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1]!;
        const cur = rows[i]!;
        if (key === "parties") {
          expect(`${prev.createdAt}|${prev.id}` >= `${cur.createdAt}|${cur.id}`).toBe(
            true,
          );
        } else {
          expect(`${prev.createdAt}|${prev.id}` <= `${cur.createdAt}|${cur.id}`).toBe(
            true,
          );
        }
      }
    }
    cursor = data.nextCursor;
    pages += 1;
    if (!cursor) expect(rows.length).toBeLessThanOrEqual(limit);
  } while (cursor);
  expect(cursor).toBeNull();
  expect(pages).toBeGreaterThan(1);
  expect(new Set(ids).size).toBe(ids.length);
  return ids;
}

async function assertCappedContinuation<P extends { tenantId: string }>(
  handler: (req: Request, ctx: { params: Promise<P> }) => Promise<Response>,
  urlBase: string,
  params: P,
  key: "parties" | "contacts" | "addresses",
) {
  const firstRes = await invoke(handler, request(`${urlBase}?limit=101`), params);
  expect(firstRes.status).toBe(200);
  const firstData = (await readJson(firstRes)).data as {
    nextCursor: string | null;
  } & Record<string, Array<{ id: string }>>;
  const firstRows = firstData[key] ?? [];
  expect(firstRows.length).toBeLessThanOrEqual(100);
  expect(firstRows).toHaveLength(100);
  expect(firstData.nextCursor).not.toBeNull();
  const firstIds = firstRows.map((row) => row.id);
  const secondRes = await invoke(
    handler,
    request(`${urlBase}?limit=101&cursor=${encodeURIComponent(firstData.nextCursor!)}`),
    params,
  );
  expect(secondRes.status).toBe(200);
  const secondData = (await readJson(secondRes)).data as Record<
    string,
    Array<{ id: string }>
  >;
  const secondIds = (secondData[key] ?? []).map((row) => row.id);
  expect(firstIds.some((id) => secondIds.includes(id))).toBe(false);
  expect(new Set([...firstIds, ...secondIds]).size).toBe(
    firstIds.length + secondIds.length,
  );
  expect(firstIds.length + secondIds.length).toBeGreaterThan(100);
}

describe("P2D.2a party API pagination", () => {
  let fixture: PartyDomainFixture | undefined;

  afterEach(async () => {
    partyApiAuth.userId = undefined;
    if (fixture) {
      await cleanupTenant(fixture.setup.tenantId).catch(() => undefined);
      await cleanupUser(fixture.setup.adminUserId).catch(() => undefined);
      await cleanupUser(fixture.userAId).catch(() => undefined);
      await cleanupUser(fixture.userBId).catch(() => undefined);
      fixture = undefined;
    }
  });

  it("paginates parties, contacts and addresses with committed limits and archive filters", async () => {
    fixture = await setupPartyDomainFixture();
    const { setup, leA, ctxAB } = fixture;
    const tenantId = setup.tenantId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    partyApiAuth.userId = setup.adminUserId;

    const partyIds: string[] = [];
    let firstPartyId = "";
    let firstPartyVersion = 1;
    for (let i = 0; i < 28; i++) {
      const res = await invoke(
        listCreatePost,
        request(`${base}/parties`, {
          method: "POST",
          json: {
            ownerLegalEntityId: leA.id,
            code: partyCode(),
            partyType: "ORGANISATION",
            legalName: `Page Co ${i.toString().padStart(2, "0")}`,
          },
        }),
        { tenantId },
      );
      expect(res.status).toBe(201);
      const party = (
        (await readJson(res)).data as { party: { id: string; version: number } }
      ).party;
      partyIds.push(party.id);
      if (i === 0) {
        firstPartyId = party.id;
        firstPartyVersion = party.version;
      }
    }

    const defaultPage = await invoke(listCreateGet, request(`${base}/parties`), {
      tenantId,
    });
    expect(defaultPage.status).toBe(200);
    const defaultData = (await readJson(defaultPage)).data as {
      parties: unknown[];
      nextCursor: string | null;
    };
    expect(defaultData.parties).toHaveLength(25);
    expect(defaultData.nextCursor).toBeTruthy();

    while (partyIds.length < 105) {
      const extra = await createParty(ctxAB, {
        ownerLegalEntityId: leA.id,
        code: partyCode(),
        partyType: "ORGANISATION",
        legalName: `Cap Co ${partyIds.length.toString().padStart(3, "0")}`,
      });
      partyIds.push(extra.party.id);
    }
    await assertCappedContinuation(
      listCreateGet,
      `${base}/parties`,
      { tenantId },
      "parties",
    );
    expect(
      (
        (
          await readJson(
            await invoke(listCreateGet, request(`${base}/parties?limit=100`), {
              tenantId,
            }),
          )
        ).data as { parties: unknown[] }
      ).parties.length,
    ).toBeLessThanOrEqual(100);

    const traversed = await collectPages(
      listCreateGet,
      `${base}/parties`,
      { tenantId },
      "parties",
      10,
    );
    expect(traversed.length).toBe(partyIds.length);
    expect(new Set(traversed)).toEqual(new Set(partyIds));

    await invoke(
      partyArchive,
      request(`${base}/parties/${firstPartyId}/archive`, {
        method: "POST",
        json: { expectedVersion: firstPartyVersion },
      }),
      { tenantId, partyId: firstPartyId },
    );
    const active = await collectPages(
      listCreateGet,
      `${base}/parties`,
      { tenantId },
      "parties",
      25,
    );
    expect(active).not.toContain(firstPartyId);
    const withArchivedIds: string[] = [];
    let archivedCursor: string | null = null;
    do {
      const search = new URLSearchParams({ limit: "100", includeArchived: "true" });
      if (archivedCursor) search.set("cursor", archivedCursor);
      const res = await invoke(
        listCreateGet,
        request(`${base}/parties?${search.toString()}`),
        { tenantId },
      );
      expect(res.status).toBe(200);
      const data = (await readJson(res)).data as {
        parties: Array<{ id: string }>;
        nextCursor: string | null;
      };
      withArchivedIds.push(...data.parties.map((p) => p.id));
      archivedCursor = data.nextCursor;
    } while (archivedCursor);
    expect(withArchivedIds).toContain(firstPartyId);
    const onlyArchived = await invoke(
      listCreateGet,
      request(`${base}/parties?status=ARCHIVED`),
      { tenantId },
    );
    expect(
      (
        (await readJson(onlyArchived)).data as { parties: Array<{ id: string }> }
      ).parties.map((p) => p.id),
    ).toContain(firstPartyId);

    const livePartyId = partyIds[1]!;
    const contactIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await invoke(
        contactsPost,
        request(`${base}/parties/${livePartyId}/contacts`, {
          method: "POST",
          json: {
            givenName: `C${i}`,
            isPrimary: i === 7,
          },
        }),
        { tenantId, partyId: livePartyId },
      );
      expect(res.status).toBe(201);
      contactIds.push(
        ((await readJson(res)).data as { contact: { id: string } }).contact.id,
      );
    }
    const contactPage = await invoke(
      contactsGet,
      request(`${base}/parties/${livePartyId}/contacts?limit=3`),
      { tenantId, partyId: livePartyId },
    );
    const firstContacts = (
      (await readJson(contactPage)).data as {
        contacts: Array<{ id: string; isPrimary: boolean }>;
      }
    ).contacts;
    expect(firstContacts[0]?.id).toBe(contactIds[0]);
    expect(firstContacts[0]?.isPrimary).toBe(false);
    const allContacts = await collectPages(
      contactsGet,
      `${base}/parties/${livePartyId}/contacts`,
      { tenantId, partyId: livePartyId },
      "contacts",
      3,
    );
    expect(allContacts).toEqual(contactIds);
    while (contactIds.length < 105) {
      const extra = await createContact(ctxAB, {
        partyId: livePartyId,
        givenName: `CapC${contactIds.length}`,
      });
      contactIds.push(extra.id);
    }
    await assertCappedContinuation(
      contactsGet,
      `${base}/parties/${livePartyId}/contacts`,
      { tenantId, partyId: livePartyId },
      "contacts",
    );

    const addressIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await invoke(
        addressesPost,
        request(`${base}/parties/${livePartyId}/addresses`, {
          method: "POST",
          json: { addressType: "GENERAL", line1: `${i} Street`, countryCode: "SG" },
        }),
        { tenantId, partyId: livePartyId },
      );
      expect(res.status).toBe(201);
      addressIds.push(
        ((await readJson(res)).data as { address: { id: string } }).address.id,
      );
    }
    expect(
      await collectPages(
        addressesGet,
        `${base}/parties/${livePartyId}/addresses`,
        { tenantId, partyId: livePartyId },
        "addresses",
        3,
      ),
    ).toEqual(addressIds);
    while (addressIds.length < 105) {
      const extra = await createAddress(ctxAB, {
        partyId: livePartyId,
        addressType: "GENERAL",
        line1: `${addressIds.length} Cap Street`,
        countryCode: "SG",
      });
      addressIds.push(extra.id);
    }
    await assertCappedContinuation(
      addressesGet,
      `${base}/parties/${livePartyId}/addresses`,
      { tenantId, partyId: livePartyId },
      "addresses",
    );

    expect(
      (await invoke(listCreateGet, request(`${base}/parties?limit=abc`), { tenantId }))
        .status,
    ).toBe(422);
    expect(
      (
        await invoke(listCreateGet, request(`${base}/parties?limit=1&limit=2`), {
          tenantId,
        })
      ).status,
    ).toBe(422);
    expect(
      (await invoke(listCreateGet, request(`${base}/parties?unknown=1`), { tenantId }))
        .status,
    ).toBe(422);
    expect(
      (await invoke(listCreateGet, request(`${base}/parties?cursor=%%%`), { tenantId }))
        .status,
    ).toBe(422);
    expect(
      (
        await invoke(listCreateGet, request(`${base}/parties?cursor=not-a-cursor`), {
          tenantId,
        })
      ).status,
    ).toBe(422);
    const truncated = defaultData.nextCursor!.slice(0, 8);
    expect(
      (
        await invoke(listCreateGet, request(`${base}/parties?cursor=${truncated}`), {
          tenantId,
        })
      ).status,
    ).toBe(422);
  }, 120_000);
});
