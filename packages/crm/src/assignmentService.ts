import { z } from "zod";
import { AUDIT_ACTIONS } from "@noahark/audit";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  StaleVersionError,
  ValidationError,
  type AccessContext,
} from "@noahark/core";
import { withTenantContext } from "@noahark/db";
import { writeAuditEvent, auditActorFields } from "./audit";
import { mapPartyDbError } from "./errors";
import { lockPartyAssignments } from "./locking";
import {
  assertHasLegalEntityAccess,
  requireExpectedVersion,
  requireNonEmptyLegalEntityScope,
  tenantContextInput,
} from "./trustedContext";

export const CreateAssignmentSchema = z.object({
  partyId: z.string().min(1).max(64),
  legalEntityId: z.string().min(1).max(64),
});

export const UpdateAssignmentSchema = z.object({
  expectedVersion: z.number().int().min(1),
  status: z.enum(["ACTIVE", "SUSPENDED"]),
});

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid input", { issues: parsed.error.issues });
  }
  return parsed.data;
}

/** Load an assignment visible in the caller's legal-entity scope.
 * Another entity's assignment id is not found — no existence disclosure. */
export async function getAssignment(ctx: AccessContext, assignmentId: string) {
  requireNonEmptyLegalEntityScope(ctx);
  return withTenantContext(tenantContextInput(ctx), async (tx) => {
    const row = await tx.partyLegalEntityAssignment.findFirst({
      where: {
        id: assignmentId,
        tenantId: ctx.tenantId,
        legalEntityId: { in: Array.from(ctx.legalEntityIds) },
      },
    });
    if (!row) throw new NotFoundError("Assignment");
    return row;
  });
}

export async function listAssignments(
  ctx: AccessContext,
  input: { partyId?: string; legalEntityId?: string } = {},
) {
  requireNonEmptyLegalEntityScope(ctx);
  if (input.legalEntityId) {
    assertHasLegalEntityAccess(ctx, input.legalEntityId);
  }
  const entityFilter = input.legalEntityId
    ? [input.legalEntityId]
    : Array.from(ctx.legalEntityIds);
  return withTenantContext(tenantContextInput(ctx), (tx) =>
    tx.partyLegalEntityAssignment.findMany({
      where: {
        tenantId: ctx.tenantId,
        legalEntityId: { in: entityFilter },
        ...(input.partyId ? { partyId: input.partyId } : {}),
      },
      orderBy: { createdAt: "asc" },
    }),
  );
}

export async function createAssignment(ctx: AccessContext, raw: unknown) {
  const input = parseOrThrow(CreateAssignmentSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  assertHasLegalEntityAccess(ctx, input.legalEntityId);
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      await lockPartyAssignments(tx, ctx.tenantId, input.partyId);
      const party = await tx.party.findFirst({
        where: { id: input.partyId, tenantId: ctx.tenantId },
      });
      if (!party) throw new NotFoundError("Party");
      const assignment = await tx.partyLegalEntityAssignment.create({
        data: {
          tenantId: ctx.tenantId,
          partyId: input.partyId,
          legalEntityId: input.legalEntityId,
        },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: input.legalEntityId,
        action: AUDIT_ACTIONS.PARTY_ASSIGNMENT_CREATED,
        entityType: "party_legal_entity_assignment",
        entityId: assignment.id,
        afterData: {
          id: assignment.id,
          partyId: assignment.partyId,
          legalEntityId: assignment.legalEntityId,
          status: assignment.status,
          version: assignment.version,
        },
      });
      return assignment;
    });
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof ForbiddenError ||
      error instanceof NotFoundError
    ) {
      throw error;
    }
    mapPartyDbError(error, "Assignment");
  }
}

export async function updateAssignment(
  ctx: AccessContext,
  assignmentId: string,
  raw: unknown,
) {
  const input = parseOrThrow(UpdateAssignmentSchema, raw);
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(input.expectedVersion, "Assignment");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const existing = await tx.partyLegalEntityAssignment.findFirst({
        where: {
          id: assignmentId,
          tenantId: ctx.tenantId,
          legalEntityId: { in: Array.from(ctx.legalEntityIds) },
        },
      });
      if (!existing) throw new NotFoundError("Assignment");
      if (existing.status === "ARCHIVED") {
        throw new ValidationError("Archived assignments cannot be updated");
      }
      if (existing.version !== input.expectedVersion) {
        throw new StaleVersionError("Assignment");
      }
      if (input.status === "SUSPENDED" && existing.status === "ACTIVE") {
        await lockPartyAssignments(tx, ctx.tenantId, existing.partyId);
        const activeCount = await tx.partyLegalEntityAssignment.count({
          where: {
            tenantId: ctx.tenantId,
            partyId: existing.partyId,
            status: "ACTIVE",
          },
        });
        if (activeCount <= 1) {
          throw new ConflictError("A party must keep at least one active assignment");
        }
      }
      const updated = await tx.partyLegalEntityAssignment.updateMany({
        where: {
          id: assignmentId,
          tenantId: ctx.tenantId,
          version: input.expectedVersion,
          legalEntityId: existing.legalEntityId,
        },
        data: {
          status: input.status,
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Assignment");
      const after = await tx.partyLegalEntityAssignment.findFirstOrThrow({
        where: { id: assignmentId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: after.legalEntityId,
        action: AUDIT_ACTIONS.PARTY_ASSIGNMENT_UPDATED,
        entityType: "party_legal_entity_assignment",
        entityId: after.id,
        beforeData: { version: existing.version, status: existing.status },
        afterData: { version: after.version, status: after.status },
      });
      return after;
    });
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof ForbiddenError ||
      error instanceof NotFoundError ||
      error instanceof StaleVersionError ||
      error instanceof ConflictError
    ) {
      throw error;
    }
    mapPartyDbError(error, "Assignment");
  }
}

export async function revokeAssignment(
  ctx: AccessContext,
  assignmentId: string,
  expectedVersion: number,
) {
  requireNonEmptyLegalEntityScope(ctx);
  requireExpectedVersion(expectedVersion, "Assignment");
  try {
    return await withTenantContext(tenantContextInput(ctx), async (tx) => {
      const existing = await tx.partyLegalEntityAssignment.findFirst({
        where: {
          id: assignmentId,
          tenantId: ctx.tenantId,
          legalEntityId: { in: Array.from(ctx.legalEntityIds) },
        },
      });
      if (!existing) throw new NotFoundError("Assignment");
      if (existing.version !== expectedVersion) throw new StaleVersionError("Assignment");
      if (existing.status === "ARCHIVED") {
        throw new ValidationError("Assignment is already revoked");
      }

      await lockPartyAssignments(tx, ctx.tenantId, existing.partyId);

      const activeCount = await tx.partyLegalEntityAssignment.count({
        where: {
          tenantId: ctx.tenantId,
          partyId: existing.partyId,
          status: "ACTIVE",
        },
      });
      if (existing.status === "ACTIVE" && activeCount <= 1) {
        throw new ConflictError("A party must keep at least one active assignment");
      }

      const archivedAt = new Date();
      const updated = await tx.partyLegalEntityAssignment.updateMany({
        where: {
          id: assignmentId,
          tenantId: ctx.tenantId,
          version: expectedVersion,
          legalEntityId: existing.legalEntityId,
        },
        data: {
          status: "ARCHIVED",
          archivedAt,
          version: { increment: 1 },
          updatedAt: archivedAt,
        },
      });
      if (updated.count === 0) throw new StaleVersionError("Assignment");
      const after = await tx.partyLegalEntityAssignment.findFirstOrThrow({
        where: { id: assignmentId, tenantId: ctx.tenantId },
      });
      await writeAuditEvent(tx, {
        ...auditActorFields(ctx),
        legalEntityId: after.legalEntityId,
        action: AUDIT_ACTIONS.PARTY_ASSIGNMENT_REVOKED,
        entityType: "party_legal_entity_assignment",
        entityId: after.id,
        beforeData: { version: existing.version, status: existing.status },
        afterData: { version: after.version, status: after.status },
      });
      return after;
    });
  } catch (error) {
    if (
      error instanceof ValidationError ||
      error instanceof ForbiddenError ||
      error instanceof NotFoundError ||
      error instanceof StaleVersionError ||
      error instanceof ConflictError
    ) {
      throw error;
    }
    mapPartyDbError(error, "Assignment");
  }
}
