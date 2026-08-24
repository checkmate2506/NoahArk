#!/usr/bin/env -S npx tsx
/**
 * F-2/F-6 (Phase 1B): read-only operational tool to verify an audit chain's
 * integrity (hash continuity + gapless sequence) against the real database.
 *
 * Connects with DATABASE_MIGRATION_URL (read-only usage here — this script
 * issues SELECT only) so it can read a chain regardless of which tenant
 * context would ordinarily gate it; the equivalent application-layer
 * boundary (withPlatformAuditContext / withTenantContext) is enforced for
 * ordinary request handling, not for this operator tool.
 *
 * Deliberately prints only chain-structural facts (sequence numbers,
 * hashes, pass/fail) — never action, entityType, before/after data, actor
 * id, ip, or user agent, so running this against a real environment cannot
 * itself leak audit content to a terminal/log.
 *
 * Usage:
 *   tsx scripts/verify-audit-chain.ts --tenant <tenantId>
 *   tsx scripts/verify-audit-chain.ts --platform
 *
 * Exit code 0 = chain valid (or empty). Exit code 1 = chain invalid, or a
 * usage/connection error.
 */
import "dotenv/config";
import {
  verifyAuditChain,
  PLATFORM_CHAIN_KEY,
  type AuditChainLink,
} from "@noahark/audit";
import { createSystemClient, disconnectSystemClient } from "../src/systemClient";

function parseArgs(argv: string[]): { chainKey: string; label: string } {
  const tenantIdx = argv.indexOf("--tenant");
  if (tenantIdx !== -1 && argv[tenantIdx + 1]) {
    const tenantId = argv[tenantIdx + 1]!;
    return { chainKey: tenantId, label: `tenant ${tenantId}` };
  }
  if (argv.includes("--platform")) {
    return { chainKey: PLATFORM_CHAIN_KEY, label: "platform" };
  }
  throw new Error("Usage: verify-audit-chain.ts --tenant <tenantId> | --platform");
}

async function main(): Promise<void> {
  const { chainKey, label } = parseArgs(process.argv.slice(2));
  const db = createSystemClient();

  const rows = await db.auditEvent.findMany({
    where: { chainKey },
    orderBy: { sequence: "asc" },
    select: {
      sequence: true,
      prevHash: true,
      hash: true,
      tenantId: true,
      legalEntityId: true,
      actorUserId: true,
      actorType: true,
      action: true,
      entityType: true,
      entityId: true,
      beforeData: true,
      afterData: true,
      outcome: true,
      createdAt: true,
    },
  });

  const links: AuditChainLink[] = rows.map((r) => ({
    prevHash: r.prevHash,
    hash: r.hash,
    sequence: r.sequence,
    payload: {
      tenantId: r.tenantId,
      legalEntityId: r.legalEntityId,
      actorUserId: r.actorUserId,
      actorType: r.actorType,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      beforeData: r.beforeData,
      afterData: r.afterData,
      outcome: r.outcome,
      createdAt: r.createdAt.toISOString(),
      chainKey,
      sequence: r.sequence.toString(),
    },
  }));

  const result = verifyAuditChain(links);

  console.warn(`Chain: ${label}`);
  console.warn(`Events checked: ${links.length}`);
  if (result.valid) {
    console.warn("Result: VALID");
    process.exitCode = 0;
  } else {
    const badSequence = links[result.firstInvalidIndex]?.sequence ?? "unknown";
    console.error(
      `Result: INVALID — first bad link at array index ${result.firstInvalidIndex} (sequence ${badSequence})`,
    );
    console.error(`Reason: ${result.reason}`);
    process.exitCode = 1;
  }

  await disconnectSystemClient();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
