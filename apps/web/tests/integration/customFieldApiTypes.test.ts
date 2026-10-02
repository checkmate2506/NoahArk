import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthenticatedError } from "@noahark/core";
import { createSystemClient } from "@noahark/db/system";
import { POST as definitionsPost } from "@/app/api/v1/tenants/[tenantId]/custom-fields/definitions/route";
import {
  GET as valuesGet,
  PUT as valuesPut,
} from "@/app/api/v1/tenants/[tenantId]/custom-fields/values/route";
import { GET as valueGet } from "@/app/api/v1/tenants/[tenantId]/custom-fields/values/[valueId]/route";
import { cleanupTenant, cleanupUser, uniqueSlug } from "./testHelpers";
import {
  createTestParty,
  fieldKey,
  setupCustomFieldDomainFixture,
  type CustomFieldDomainFixture,
} from "./customFieldDomainFixture";
import {
  PHASE2_ENTITY_TYPES,
  SUPPORTED_DATA_TYPES,
} from "@/lib/services/customFieldDomain";
import { OPENAPI_DOC, assertMatchesOpenApi } from "./openapiResponseValidator";

const { customFieldApiAuth } = vi.hoisted(() => ({
  customFieldApiAuth: { userId: undefined as string | undefined },
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
      if (!customFieldApiAuth.userId) throw new UnauthenticatedError();
      return actual.getAccessContext(
        customFieldApiAuth.userId,
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

describe("P2D.4 custom-field typed values", () => {
  let fixture: CustomFieldDomainFixture | undefined;

  afterEach(async () => {
    customFieldApiAuth.userId = undefined;
    if (fixture) {
      await cleanupTenant(fixture.setup.tenantId).catch(() => undefined);
      await cleanupUser(fixture.setup.adminUserId).catch(() => undefined);
      await cleanupUser(fixture.userAId).catch(() => undefined);
      await cleanupUser(fixture.userBId).catch(() => undefined);
      fixture = undefined;
    }
  });

  it("round-trips all six typed envelopes through HTTP and matches OpenAPI enums", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { setup, ctxAB, leA } = fixture;
    const tenantId = setup.tenantId;
    customFieldApiAuth.userId = setup.adminUserId;
    const base = `https://noahark.example/api/v1/tenants/${tenantId}`;
    const party = await createTestParty(ctxAB, leA.id);
    const db = createSystemClient();

    const entityEnum = OPENAPI_DOC.components?.schemas?.CustomFieldEntityType?.enum;
    const dataEnum = OPENAPI_DOC.components?.schemas?.CustomFieldDataType?.enum;
    expect(entityEnum).toEqual([...PHASE2_ENTITY_TYPES]);
    expect(dataEnum).toEqual([...SUPPORTED_DATA_TYPES]);
    expect(entityEnum).not.toContain("demo_approval_subject");
    expect(dataEnum).not.toContain("NUMBER");
    expect(dataEnum).not.toContain("MULTI_SELECT");

    const cases: Array<{
      dataType: "STRING" | "INTEGER" | "DECIMAL" | "BOOLEAN" | "DATE" | "SINGLE_SELECT";
      options?: string[];
      input: unknown;
      expected: unknown;
      column: string;
    }> = [
      {
        dataType: "STRING",
        input: { dataType: "STRING", value: "  hello  " },
        expected: { dataType: "STRING", value: "hello" },
        column: "valueText",
      },
      {
        dataType: "INTEGER",
        input: { dataType: "INTEGER", value: 42 },
        expected: { dataType: "INTEGER", value: 42 },
        column: "valueInteger",
      },
      {
        dataType: "DECIMAL",
        input: { dataType: "DECIMAL", value: "-12.5" },
        expected: { dataType: "DECIMAL", value: "-12.500000" },
        column: "valueDecimal",
      },
      {
        dataType: "BOOLEAN",
        input: { dataType: "BOOLEAN", value: false },
        expected: { dataType: "BOOLEAN", value: false },
        column: "valueBoolean",
      },
      {
        dataType: "DATE",
        input: { dataType: "DATE", value: "2026-07-01" },
        expected: { dataType: "DATE", value: "2026-07-01" },
        column: "valueDate",
      },
      {
        dataType: "SINGLE_SELECT",
        options: ["red", "blue"],
        input: { dataType: "SINGLE_SELECT", value: "red" },
        expected: { dataType: "SINGLE_SELECT", value: "red" },
        column: "valueOption",
      },
    ];

    for (const row of cases) {
      const created = await invoke(
        definitionsPost,
        request(`${base}/custom-fields/definitions`, {
          method: "POST",
          json: {
            entityType: "party",
            key: fieldKey(row.dataType.toLowerCase()),
            label: row.dataType,
            dataType: row.dataType,
            ...(row.options ? { options: row.options } : {}),
          },
        }),
        { tenantId },
      );
      expect(created.status).toBe(201);
      const definition = (
        (await readJson(created)).data as { definition: { id: string } }
      ).definition;
      const setRes = await invoke(
        valuesPut,
        request(`${base}/custom-fields/values`, {
          method: "PUT",
          json: {
            definitionId: definition.id,
            entityId: party.party.id,
            value: row.input,
          },
        }),
        { tenantId },
      );
      expect(setRes.status, row.dataType).toBe(200);
      const setBody = await readJson(setRes);
      assertMatchesOpenApi("setCustomFieldValue", setBody, ["value"]);
      const written = (setBody.data as { value: { id: string; typedValue: unknown } })
        .value;
      expect(written.typedValue).toEqual(row.expected);
      if (row.dataType === "DECIMAL") {
        expect(typeof (written.typedValue as { value: unknown }).value).toBe("string");
      }
      if (row.dataType === "INTEGER") {
        expect(Number.isInteger((written.typedValue as { value: number }).value)).toBe(
          true,
        );
      }

      const getRes = await invoke(
        valueGet,
        request(`${base}/custom-fields/values/${written.id}`),
        { tenantId, valueId: written.id },
      );
      expect(getRes.status).toBe(200);
      const getBody = await readJson(getRes);
      assertMatchesOpenApi("getCustomFieldValue", getBody, ["value"]);
      expect(
        (getBody.data as { value: { typedValue: unknown } }).value.typedValue,
      ).toEqual(row.expected);

      const listRes = await invoke(
        valuesGet,
        request(
          `${base}/custom-fields/values?definitionId=${definition.id}&entityId=${party.party.id}`,
        ),
        { tenantId },
      );
      expect(listRes.status).toBe(200);
      const listBody = await readJson(listRes);
      assertMatchesOpenApi("listCustomFieldValues", listBody, ["values", "nextCursor"]);
      expect(
        (listBody.data as { values: Array<{ typedValue: unknown }> }).values[0]
          ?.typedValue,
      ).toEqual(row.expected);

      const stored = await db.customFieldValue.findUnique({ where: { id: written.id } });
      expect(stored).toBeTruthy();
      expect(stored?.value).toBeNull();
      expect(stored?.valueText ?? null).toBe(row.column === "valueText" ? "hello" : null);
      expect(stored?.valueInteger ?? null).toBe(
        row.column === "valueInteger" ? 42 : null,
      );
      expect(stored?.valueBoolean ?? null).toBe(
        row.column === "valueBoolean" ? false : null,
      );
      expect(stored?.valueOption ?? null).toBe(
        row.column === "valueOption" ? "red" : null,
      );
      if (row.column === "valueDecimal") {
        expect(stored?.valueDecimal?.toFixed(6)).toBe("-12.500000");
      } else {
        expect(stored?.valueDecimal).toBeNull();
      }
      if (row.column === "valueDate") {
        expect(stored?.valueDate?.toISOString().slice(0, 10)).toBe("2026-07-01");
      } else {
        expect(stored?.valueDate).toBeNull();
      }
    }

    const stringDef = await invoke(
      definitionsPost,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        json: {
          entityType: "party",
          key: fieldKey("neg"),
          label: "Neg",
          dataType: "STRING",
        },
      }),
      { tenantId },
    );
    const stringId = ((await readJson(stringDef)).data as { definition: { id: string } })
      .definition.id;
    const decimalDef = await invoke(
      definitionsPost,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        json: {
          entityType: "party",
          key: fieldKey("dec"),
          label: "Dec",
          dataType: "DECIMAL",
        },
      }),
      { tenantId },
    );
    const decimalId = (
      (await readJson(decimalDef)).data as { definition: { id: string } }
    ).definition.id;
    const boolDef = await invoke(
      definitionsPost,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        json: {
          entityType: "party",
          key: fieldKey("bool"),
          label: "Bool",
          dataType: "BOOLEAN",
        },
      }),
      { tenantId },
    );
    const boolId = ((await readJson(boolDef)).data as { definition: { id: string } })
      .definition.id;
    const dateDef = await invoke(
      definitionsPost,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        json: {
          entityType: "party",
          key: fieldKey("date"),
          label: "Date",
          dataType: "DATE",
        },
      }),
      { tenantId },
    );
    const dateId = ((await readJson(dateDef)).data as { definition: { id: string } })
      .definition.id;
    const selectDef = await invoke(
      definitionsPost,
      request(`${base}/custom-fields/definitions`, {
        method: "POST",
        json: {
          entityType: "party",
          key: fieldKey("sel"),
          label: "Sel",
          dataType: "SINGLE_SELECT",
          options: ["red", "blue"],
        },
      }),
      { tenantId },
    );
    const selectId = ((await readJson(selectDef)).data as { definition: { id: string } })
      .definition.id;

    const negatives: Array<{ definitionId: string; value: unknown }> = [
      { definitionId: stringId, value: { dataType: "INTEGER", value: 1 } },
      { definitionId: decimalId, value: { dataType: "DECIMAL", value: 12.5 } },
      { definitionId: boolId, value: { dataType: "BOOLEAN", value: "true" } },
      { definitionId: dateId, value: { dataType: "DATE", value: "2026-02-30" } },
      { definitionId: selectId, value: { dataType: "SINGLE_SELECT", value: "green" } },
      { definitionId: stringId, value: { dataType: "STRING", value: "x".repeat(2001) } },
      { definitionId: stringId, value: { dataType: "INTEGER", value: 1.5 } },
    ];
    for (const neg of negatives) {
      const res = await invoke(
        valuesPut,
        request(`${base}/custom-fields/values`, {
          method: "PUT",
          json: {
            definitionId: neg.definitionId,
            entityId: party.party.id,
            value: neg.value,
          },
        }),
        { tenantId },
      );
      expect(res.status, JSON.stringify(neg.value)).toBe(422);
    }
  }, 180_000);
});
