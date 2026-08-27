import { describe, expect, it } from "vitest";
import {
  boundDuplicateCandidates,
  compareDuplicateCandidates,
  type DuplicateCandidate,
} from "./duplicates";
import {
  isEmailShape,
  normaliseEmail,
  normaliseText,
  partyDisplayName,
} from "./normalize";
import {
  boundPageSize,
  decodeCreatedAtIdCursor,
  encodeCreatedAtIdCursor,
} from "./pagination";
import { maskPartyContact, PENDING_PARTY_CONTACT_PERMISSIONS } from "./masking";
import type { AccessContext } from "@noahark/core";
import { ValidationError } from "@noahark/core";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function ctx(permissions: string[] = []): AccessContext {
  return {
    requestId: "r1",
    userId: "u1",
    tenantId: "t1",
    legalEntityIds: new Set(["le1"]),
    permissions: new Set(permissions),
    legalEntityPermissions: new Map(),
    roleIds: new Set(),
    legalEntityRoleIds: new Map(),
  };
}

describe("normaliseText", () => {
  it("is deterministic and collapses unicode/whitespace independently of host locale", () => {
    expect(normaliseText("  Acme   Pte Ltd  ")).toBe("acme pte ltd");
    expect(normaliseText("\u212B")).toBe("\u00E5");
    expect(normaliseEmail("  Foo.Bar@Example.COM ")).toBe("foo.bar@example.com");
    expect(isEmailShape("not-an-email")).toBe(false);
    expect(isEmailShape("a@b.c")).toBe(true);
    expect(
      partyDisplayName({
        partyType: "INDIVIDUAL",
        givenName: "Ada",
        familyName: "Lovelace",
      }),
    ).toBe("Ada Lovelace");
  });
});

describe("pagination", () => {
  it("bounds page size and round-trips cursors", () => {
    expect(boundPageSize(undefined)).toBe(25);
    expect(boundPageSize(1000)).toBe(100);
    expect(() => boundPageSize(0)).toThrow(ValidationError);
    const at = new Date("2026-08-25T10:00:00.000Z");
    const encoded = encodeCreatedAtIdCursor(at, "abc");
    expect(decodeCreatedAtIdCursor(encoded)).toEqual({ createdAt: at, id: "abc" });
    expect(() => decodeCreatedAtIdCursor("%%%")).toThrow(ValidationError);
  });
});

describe("maskPartyContact", () => {
  it("fails closed without pending read permissions and is consistent", () => {
    const record = { id: "c1", email: "a@b.c", phone: "+65 1" };
    const masked = maskPartyContact(ctx(), record, "le1");
    expect(masked.email).toBeNull();
    expect(masked.phone).toBeNull();
    const detail = maskPartyContact(ctx(), { ...record }, "le1");
    expect(detail).toEqual(masked);
  });

  it("returns original values when pending permissions are present", () => {
    const record = { id: "c1", email: "a@b.c", phone: "+65 1" };
    const allowed = maskPartyContact(
      ctx([
        PENDING_PARTY_CONTACT_PERMISSIONS.EMAIL_READ,
        PENDING_PARTY_CONTACT_PERMISSIONS.PHONE_READ,
      ]),
      record,
      "le1",
    );
    expect(allowed.email).toBe("a@b.c");
    expect(allowed.phone).toBe("+65 1");
  });
});

describe("duplicate-candidate ordering", () => {
  it("is locale-pinned, sorts the full set, then applies the bound", () => {
    const extras: DuplicateCandidate[] = [
      { partyId: "clq-zz", partyType: "ORGANISATION", matchReasons: ["name"] },
      { partyId: "clq-aa", partyType: "INDIVIDUAL", matchReasons: ["email"] },
      { partyId: "clq-mm", partyType: "ORGANISATION", matchReasons: ["tax_identifier"] },
    ];
    const overflow: DuplicateCandidate[] = Array.from({ length: 12 }, (_, i) => ({
      partyId: `id-${String.fromCharCode(108 - i)}`,
      partyType: "ORGANISATION" as const,
      matchReasons: ["name" as const],
    }));
    const mixed = [...overflow, ...extras].reverse();
    const bounded = boundDuplicateCandidates(mixed);
    expect(bounded).toHaveLength(10);
    const expectedIds = [...mixed]
      .sort(compareDuplicateCandidates)
      .slice(0, 10)
      .map((c) => c.partyId);
    expect(bounded.map((c) => c.partyId)).toEqual(expectedIds);
    expect(bounded.map((c) => c.partyId)).toEqual([
      "clq-aa",
      "clq-mm",
      "clq-zz",
      "id-a",
      "id-b",
      "id-c",
      "id-d",
      "id-e",
      "id-f",
      "id-g",
    ]);
    expect(bounded.some((c) => c.partyId === "id-l")).toBe(false);
    const equalId: DuplicateCandidate[] = [
      { partyId: "same", partyType: "ORGANISATION", matchReasons: ["tax_identifier"] },
      { partyId: "same", partyType: "INDIVIDUAL", matchReasons: ["email"] },
      { partyId: "same", partyType: "INDIVIDUAL", matchReasons: ["name"] },
    ];
    expect(
      boundDuplicateCandidates(equalId).map(
        (c) => `${c.partyType}:${c.matchReasons.join(",")}`,
      ),
    ).toEqual(["INDIVIDUAL:email", "INDIVIDUAL:name", "ORGANISATION:tax_identifier"]);
  });
});

describe("P2B source has no hard-delete path", () => {
  it("does not call delete/deleteMany on party domain models", () => {
    const root = join(import.meta.dirname, "..");
    const files: string[] = [];
    function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) files.push(full);
      }
    }
    walk(join(root, "src"));
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (
        /\.(party|partyContact|partyAddress|partyLegalEntityAssignment|customerRole|vendorRole)\.delete(Many)?\s*\(/.test(
          text,
        )
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
