import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

/**
 * Connects as `noahark_worker` (DATABASE_WORKER_URL). F-12 (Phase 1B): this
 * role is NOBYPASSRLS, like every other application role — it previously
 * had BYPASSRLS, which (a) requires CREATEROLE/superuser-equivalent
 * privilege to grant, unavailable on Azure Database for PostgreSQL Flexible
 * Server's azure_pg_admin login, and (b) is a blanket attribute that would
 * silently expose every row of any table this role is ever GRANTed access
 * to in a future migration, RLS or not. Its cross-tenant visibility into
 * `background_job`/`outbox_event` (queue rows legitimately span every
 * tenant, since the whole point is polling for work across all of them)
 * comes from an explicit RLS policy scoped `TO noahark_worker` on exactly
 * those two tables (see the RLS migration §9) plus a GRANT SELECT, UPDATE
 * on them — no GRANT exists on any other table, so Postgres rejects any
 * query against business data with a permission error regardless of what
 * TypeScript allows you to write, structurally preventing this client from
 * ever reading tenant data even if job-handling code were compromised.
 *
 * F-20 (Phase 1B.1): this client is used ONLY inside packages/jobs'
 * queue.ts/outbox.ts (claim/complete/fail/heartbeat/reap) and is NEVER
 * passed to a job/outbox handler — see worker.ts's JobHandlerContext/
 * OutboxHandlerContext, whose `tx` field is always a real scoped
 * `TransactionClient` from `withTenantContext` (the ordinary RLS-enforced
 * `noahark_app` role, via context.ts's `withJobTenantContext`), never this
 * client. There is no code path from a handler back to this client.
 */
let workerClient: PrismaClient | undefined;

export function getWorkerClient(): PrismaClient {
  if (!workerClient) {
    const url = process.env.DATABASE_WORKER_URL;
    if (!url) throw new Error("DATABASE_WORKER_URL is not set");
    const adapter = new PrismaPg({ connectionString: url });
    workerClient = new PrismaClient({ adapter });
  }
  return workerClient;
}

export async function disconnectWorkerClient(): Promise<void> {
  if (workerClient) {
    await workerClient.$disconnect();
    workerClient = undefined;
  }
}
