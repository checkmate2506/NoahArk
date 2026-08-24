import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Migrations run against DATABASE_MIGRATION_URL (an owner/superuser role)
    // so DDL, RLS policy creation and app-role grants can succeed. The running
    // application NEVER uses this connection — see src/client.ts, which uses
    // DATABASE_URL (the non-superuser noahark_app role) instead.
    url: env("DATABASE_MIGRATION_URL"),
  },
});
