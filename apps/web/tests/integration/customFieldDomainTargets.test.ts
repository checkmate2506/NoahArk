import { afterEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "@noahark/core";
import { archiveParty, updateAssignment, updateCustomerRole } from "@noahark/crm";
import { archiveCatalogItemAssignment } from "@noahark/catalog";
import { createCustomFieldDefinition } from "../../lib/services/customFieldDomain";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  createAssignedCatalogGraph,
  createAssignedPartyGraph,
  createStringDefinition,
  fieldKey,
  setStringValue,
  setupCustomFieldDomainFixture,
  type CustomFieldDomainFixture,
} from "./customFieldDomainFixture";

describe("P2C.3 — custom-field targets", () => {
  let fixture: CustomFieldDomainFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await cleanupTenant(fixture.setup.tenantId).catch(() => undefined);
      await cleanupUser(fixture.setup.adminUserId).catch(() => undefined);
      await cleanupUser(fixture.userAId).catch(() => undefined);
      await cleanupUser(fixture.userBId).catch(() => undefined);
      fixture = undefined;
    }
  });

  it("writes values for all nine Phase 2 target types", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxAB, leA, leB } = fixture;
    const parties = await createAssignedPartyGraph(ctxAB, leA.id, leB.id);
    const catalog = await createAssignedCatalogGraph(ctxAB, leA.id, leB.id);
    const targets: Array<{ entityType: string; entityId: string }> = [
      { entityType: "party", entityId: parties.party.id },
      { entityType: "party_contact", entityId: parties.contact.id },
      {
        entityType: "party_legal_entity_assignment",
        entityId: parties.ownerAssignment.id,
      },
      { entityType: "customer_role", entityId: parties.customerRole.id },
      { entityType: "vendor_role", entityId: parties.vendorRole.id },
      { entityType: "catalog_item", entityId: catalog.item.id },
      {
        entityType: "catalog_item_legal_entity_assignment",
        entityId: catalog.itemOwnerAssignment.id,
      },
      { entityType: "price_list", entityId: catalog.priceList.id },
      {
        entityType: "price_list_legal_entity_assignment",
        entityId: catalog.priceOwnerAssignment.id,
      },
    ];
    for (const target of targets) {
      const definition = await createStringDefinition(ctxAB, target.entityType);
      const written = await setStringValue(
        ctxAB,
        definition.id,
        target.entityId,
        target.entityType,
      );
      expect(written.entityType).toBe(target.entityType);
      expect(written.entityId).toBe(target.entityId);
      expect(written.legalEntityId).toBe(leA.id);
    }
  });

  it("rejects cross-type substitution and archived targets", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxAB, ctxA, leA, leB } = fixture;
    const parties = await createAssignedPartyGraph(ctxAB, leA.id, leB.id);
    const catalog = await createAssignedCatalogGraph(ctxAB, leA.id, leB.id);
    const partyDef = await createStringDefinition(ctxAB, "party");
    await expect(
      setStringValue(ctxAB, partyDef.id, catalog.item.id, "nope"),
    ).rejects.toBeInstanceOf(NotFoundError);

    const archived = await archiveParty(ctxA, parties.party.id, parties.party.version);
    expect(archived.status).toBe("ARCHIVED");
    await expect(
      setStringValue(ctxA, partyDef.id, parties.party.id, "nope"),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("allows SUSPENDED entity-scoped targets and rejects archived assignments", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxAB, leA, leB } = fixture;
    const parties = await createAssignedPartyGraph(ctxAB, leA.id, leB.id);
    const catalog = await createAssignedCatalogGraph(ctxAB, leA.id, leB.id);
    const suspended = await updateAssignment(ctxAB, parties.ownerAssignment.id, {
      expectedVersion: parties.ownerAssignment.version,
      status: "SUSPENDED",
    });
    expect(suspended.status).toBe("SUSPENDED");
    const assignmentDef = await createStringDefinition(
      ctxAB,
      "party_legal_entity_assignment",
    );
    const written = await setStringValue(
      ctxAB,
      assignmentDef.id,
      parties.ownerAssignment.id,
      "correction",
    );
    expect(written.typedValue.value).toBe("correction");

    const roleDef = await createCustomFieldDefinition(ctxAB, {
      entityType: "customer_role",
      key: fieldKey("role"),
      label: "Role note",
      dataType: "STRING",
    });
    const suspendedRole = await updateCustomerRole(ctxAB, parties.customerRole.id, {
      expectedVersion: parties.customerRole.version,
      status: "SUSPENDED",
    });
    expect(suspendedRole.status).toBe("SUSPENDED");
    await setStringValue(ctxAB, roleDef.id, parties.customerRole.id, "ok");

    const archivedAssignment = await archiveCatalogItemAssignment(
      ctxAB,
      catalog.itemOwnerAssignment.id,
      catalog.itemOwnerAssignment.version,
    );
    expect(archivedAssignment.status).toBe("ARCHIVED");
    const itemAssignDef = await createStringDefinition(
      ctxAB,
      "catalog_item_legal_entity_assignment",
    );
    await expect(
      setStringValue(ctxAB, itemAssignDef.id, catalog.itemOwnerAssignment.id, "nope"),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
