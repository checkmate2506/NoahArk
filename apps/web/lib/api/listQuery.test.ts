import { describe, expect, it } from "vitest";
import { ValidationError } from "@noahark/core";
import {
  LIST_QUERY_BOOLEAN,
  LIST_QUERY_INTEGER,
  LIST_QUERY_STRING,
  parseListQuery,
} from "./listQuery";

const SPEC = {
  cursor: LIST_QUERY_STRING,
  q: LIST_QUERY_STRING,
  status: LIST_QUERY_STRING,
  limit: LIST_QUERY_INTEGER,
  includeArchived: LIST_QUERY_BOOLEAN,
  isActive: LIST_QUERY_BOOLEAN,
} as const;

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe("parseListQuery", () => {
  it("coerces an integer limit and preserves an opaque cursor", () => {
    const cursor = "abc+/=_-opaque";
    const result = parseListQuery(
      params(`limit=25&cursor=${encodeURIComponent(cursor)}`),
      SPEC,
    );
    expect(result.limit).toBe(25);
    expect(result.cursor).toBe(cursor);
  });

  it("coerces true and false booleans", () => {
    const result = parseListQuery(params("includeArchived=true&isActive=false"), SPEC);
    expect(result.includeArchived).toBe(true);
    expect(result.isActive).toBe(false);
  });

  it("rejects a malformed integer", () => {
    expect(() => parseListQuery(params("limit=25abc"), SPEC)).toThrow(ValidationError);
    expect(() => parseListQuery(params("limit=1e2"), SPEC)).toThrow(ValidationError);
    expect(() => parseListQuery(params("limit=25.5"), SPEC)).toThrow(ValidationError);
    expect(() => parseListQuery(params("limit=+25"), SPEC)).toThrow(ValidationError);
    expect(() => parseListQuery(params("limit=025"), SPEC)).toThrow(ValidationError);
  });

  it("rejects a malformed boolean and does not treat 1 as true", () => {
    expect(() => parseListQuery(params("includeArchived=1"), SPEC)).toThrow(
      ValidationError,
    );
    expect(() => parseListQuery(params("includeArchived=TRUE"), SPEC)).toThrow(
      ValidationError,
    );
    expect(() => parseListQuery(params("isActive=yes"), SPEC)).toThrow(ValidationError);
  });

  it("rejects an empty value consistently", () => {
    expect(() => parseListQuery(params("limit="), SPEC)).toThrow(ValidationError);
    expect(() => parseListQuery(params("includeArchived="), SPEC)).toThrow(
      ValidationError,
    );
    expect(() => parseListQuery(params("cursor="), SPEC)).toThrow(ValidationError);
  });

  it("rejects a repeated singleton parameter", () => {
    expect(() => parseListQuery(params("limit=10&limit=20"), SPEC)).toThrow(
      ValidationError,
    );
  });

  it("rejects an unknown parameter when an allowed-key spec is supplied", () => {
    expect(() => parseListQuery(params("limit=10&extra=1"), SPEC)).toThrow(
      ValidationError,
    );
  });

  it("omits absent optional keys", () => {
    const result = parseListQuery(params("limit=10"), SPEC);
    expect(result).toEqual({ limit: 10 });
    expect("cursor" in result).toBe(false);
    expect("includeArchived" in result).toBe(false);
  });

  it("preserves search and status strings exactly", () => {
    const result = parseListQuery(params("q=Acme+%26+Co&status=ACTIVE"), SPEC);
    expect(result.q).toBe("Acme & Co");
    expect(result.status).toBe("ACTIVE");
  });

  it("accepts zero and negative integers without silent truncation", () => {
    expect(parseListQuery(params("limit=0"), SPEC).limit).toBe(0);
    expect(parseListQuery(params("limit=-3"), SPEC).limit).toBe(-3);
  });
});
