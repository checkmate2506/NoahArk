-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Jurisdiction" AS ENUM ('SG', 'MY', 'ID');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('SGD', 'MYR', 'IDR');

-- CreateEnum
CREATE TYPE "Language" AS ENUM ('EN', 'MS', 'ID');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "LegalEntityStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ApprovalRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalDecisionAction" AS ENUM ('APPROVE', 'REJECT', 'CANCEL');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'FAILURE', 'DENIED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "FileStatus" AS ENUM ('ACTIVE', 'DELETED', 'QUARANTINED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL');

-- CreateEnum
CREATE TYPE "CustomFieldDataType" AS ENUM ('STRING', 'NUMBER', 'BOOLEAN', 'DATE');

-- CreateEnum
CREATE TYPE "RateLimitDimension" AS ENUM ('EMAIL', 'IP', 'MFA_ACCOUNT', 'MFA_IP');

-- CreateTable
CREATE TABLE "tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_entitlement" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "module_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_entitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_setting" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_user_id" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_entity" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "jurisdiction" "Jurisdiction" NOT NULL,
    "functional_currency" "Currency" NOT NULL,
    "time_zone" TEXT NOT NULL,
    "default_language" "Language" NOT NULL DEFAULT 'EN',
    "status" "LegalEntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "registered_identifier" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "legal_entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_entity_setting" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "legal_entity_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_user_id" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "legal_entity_setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_unit" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "legal_entity_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "legal_entity_id" TEXT NOT NULL,
    "business_unit_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "legal_entity_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "legal_entity_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "legal_entity_id" TEXT NOT NULL,
    "branch_id" TEXT,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_centre" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "legal_entity_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_centre_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" TIMESTAMPTZ(3),
    "name" TEXT,
    "image" TEXT,
    "preferred_language" "Language",
    "is_disabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_credential" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'argon2id',
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_credential" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "secret_encrypted" TEXT NOT NULL,
    "confirmed_at" TIMESTAMPTZ(3),
    "last_used_totp_counter" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mfa_credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_recovery_code" (
    "id" TEXT NOT NULL,
    "mfa_credential_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "session_token" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires" TIMESTAMPTZ(3) NOT NULL,
    "active_tenant_id" TEXT,
    "active_legal_entity_id" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_token" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMPTZ(3) NOT NULL
);

-- CreateTable
CREATE TABLE "auth_rate_limit_bucket" (
    "id" TEXT NOT NULL,
    "dimension" "RateLimitDimension" NOT NULL,
    "key_hash" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "auth_rate_limit_bucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_email_capture" (
    "id" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_email_capture_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_membership" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "invited_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_invitation" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by_user_id" TEXT NOT NULL,
    "intended_role_id" TEXT,
    "intended_legal_entity_id" TEXT,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_entity_membership" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "legal_entity_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "granted_by_user_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "legal_entity_membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_role" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "tenant_membership_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "legal_entity_id" TEXT,
    "assigned_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_policy" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "entity_type" TEXT NOT NULL,
    "field_name" TEXT NOT NULL,
    "required_permission_id" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "field_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_policy" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "legal_entity_id" TEXT,
    "subject_type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "allow_self_approval" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "approval_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_step" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "approval_policy_id" TEXT NOT NULL,
    "step_order" INTEGER NOT NULL,
    "approver_role_id" TEXT NOT NULL,
    "name" TEXT,

    CONSTRAINT "approval_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_request" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "legal_entity_id" TEXT,
    "approval_policy_id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "status" "ApprovalRequestStatus" NOT NULL DEFAULT 'PENDING',
    "current_step_order" INTEGER NOT NULL DEFAULT 1,
    "submitted_by_user_id" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "approval_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_decision" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "approval_request_id" TEXT NOT NULL,
    "step_order" INTEGER NOT NULL,
    "action" "ApprovalDecisionAction" NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "comment" TEXT,
    "decided_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_decision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demo_approval_subject" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "legal_entity_id" TEXT,
    "title" TEXT NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_approval_subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "legal_entity_id" TEXT,
    "actor_user_id" TEXT,
    "actor_type" "AuditActorType" NOT NULL DEFAULT 'USER',
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before_data" JSONB,
    "after_data" JSONB,
    "request_id" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "outcome" "AuditOutcome" NOT NULL DEFAULT 'SUCCESS',
    "chain_key" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "prev_hash" TEXT,
    "hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "legal_entity_id" TEXT,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_expires_at" TIMESTAMPTZ(3),
    "heartbeat_at" TIMESTAMPTZ(3),
    "locked_at" TIMESTAMPTZ(3),
    "locked_by" TEXT,
    "last_error" TEXT,
    "correlation_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "background_job" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "legal_entity_id" TEXT,
    "job_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "run_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_expires_at" TIMESTAMPTZ(3),
    "heartbeat_at" TIMESTAMPTZ(3),
    "locked_at" TIMESTAMPTZ(3),
    "locked_by" TEXT,
    "last_error" TEXT,
    "correlation_id" TEXT,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "background_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "legal_entity_id" TEXT,
    "recipient_user_id" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'IN_APP',
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preference" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_object" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "legal_entity_id" TEXT,
    "storage_key" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploaded_by_user_id" TEXT NOT NULL,
    "status" "FileStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),
    "storage_purged_at" TIMESTAMPTZ(3),

    CONSTRAINT "file_object_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachment" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "file_object_id" TEXT NOT NULL,
    "owner_entity_type" TEXT NOT NULL,
    "owner_entity_id" TEXT NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_definition" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "legal_entity_id" TEXT,
    "entity_type" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "data_type" "CustomFieldDataType" NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "options" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "custom_field_definition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_field_value" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "definition_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "custom_field_value_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_entitlement_tenant_id_module_key_key" ON "tenant_entitlement"("tenant_id", "module_key");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_setting_tenant_id_key_key" ON "tenant_setting"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "legal_entity_tenant_id_idx" ON "legal_entity"("tenant_id");

-- CreateIndex
CREATE INDEX "legal_entity_setting_tenant_id_legal_entity_id_idx" ON "legal_entity_setting"("tenant_id", "legal_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "legal_entity_setting_legal_entity_id_key_key" ON "legal_entity_setting"("legal_entity_id", "key");

-- CreateIndex
CREATE INDEX "business_unit_tenant_id_legal_entity_id_idx" ON "business_unit"("tenant_id", "legal_entity_id");

-- CreateIndex
CREATE INDEX "department_tenant_id_legal_entity_id_idx" ON "department"("tenant_id", "legal_entity_id");

-- CreateIndex
CREATE INDEX "team_tenant_id_legal_entity_id_idx" ON "team"("tenant_id", "legal_entity_id");

-- CreateIndex
CREATE INDEX "branch_tenant_id_legal_entity_id_idx" ON "branch"("tenant_id", "legal_entity_id");

-- CreateIndex
CREATE INDEX "warehouse_tenant_id_legal_entity_id_idx" ON "warehouse"("tenant_id", "legal_entity_id");

-- CreateIndex
CREATE INDEX "cost_centre_tenant_id_legal_entity_id_idx" ON "cost_centre"("tenant_id", "legal_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "cost_centre_legal_entity_id_code_key" ON "cost_centre"("legal_entity_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_credential_user_id_key" ON "user_credential"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_credential_user_id_key" ON "mfa_credential"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_recovery_code_code_hash_key" ON "mfa_recovery_code"("code_hash");

-- CreateIndex
CREATE INDEX "mfa_recovery_code_mfa_credential_id_idx" ON "mfa_recovery_code"("mfa_credential_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_provider_provider_account_id_key" ON "account"("provider", "provider_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_session_token_key" ON "session"("session_token");

-- CreateIndex
CREATE INDEX "session_expires_idx" ON "session"("expires");

-- CreateIndex
CREATE UNIQUE INDEX "verification_token_token_key" ON "verification_token"("token");

-- CreateIndex
CREATE INDEX "verification_token_expires_idx" ON "verification_token"("expires");

-- CreateIndex
CREATE UNIQUE INDEX "verification_token_identifier_token_key" ON "verification_token"("identifier", "token");

-- CreateIndex
CREATE INDEX "auth_rate_limit_bucket_window_start_idx" ON "auth_rate_limit_bucket"("window_start");

-- CreateIndex
CREATE UNIQUE INDEX "auth_rate_limit_bucket_dimension_key_hash_window_start_key" ON "auth_rate_limit_bucket"("dimension", "key_hash", "window_start");

-- CreateIndex
CREATE INDEX "test_email_capture_to_created_at_idx" ON "test_email_capture"("to", "created_at");

-- CreateIndex
CREATE INDEX "test_email_capture_created_at_idx" ON "test_email_capture"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_membership_tenant_id_user_id_key" ON "tenant_membership"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "membership_invitation_token_hash_key" ON "membership_invitation"("token_hash");

-- CreateIndex
CREATE INDEX "membership_invitation_tenant_id_email_idx" ON "membership_invitation"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "membership_invitation_status_expires_at_idx" ON "membership_invitation"("status", "expires_at");

-- CreateIndex
CREATE INDEX "legal_entity_membership_tenant_id_legal_entity_id_idx" ON "legal_entity_membership"("tenant_id", "legal_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "legal_entity_membership_legal_entity_id_user_id_key" ON "legal_entity_membership"("legal_entity_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "permission_key_key" ON "permission"("key");

-- CreateIndex
CREATE UNIQUE INDEX "role_tenant_id_key_key" ON "role"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "role_permission_tenant_id_idx" ON "role_permission"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_permission_role_id_permission_id_key" ON "role_permission"("role_id", "permission_id");

-- CreateIndex
CREATE INDEX "membership_role_tenant_id_legal_entity_id_idx" ON "membership_role"("tenant_id", "legal_entity_id");

-- CreateIndex
CREATE INDEX "field_policy_tenant_id_idx" ON "field_policy"("tenant_id");

-- CreateIndex
CREATE INDEX "approval_policy_tenant_id_legal_entity_id_idx" ON "approval_policy"("tenant_id", "legal_entity_id");

-- CreateIndex
CREATE INDEX "approval_step_tenant_id_idx" ON "approval_step"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_step_approval_policy_id_step_order_key" ON "approval_step"("approval_policy_id", "step_order");

-- CreateIndex
CREATE INDEX "approval_request_subject_type_subject_id_idx" ON "approval_request"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "approval_request_tenant_id_legal_entity_id_idx" ON "approval_request"("tenant_id", "legal_entity_id");

-- CreateIndex
CREATE INDEX "approval_decision_tenant_id_idx" ON "approval_decision"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "approval_decision_approval_request_id_step_order_key" ON "approval_decision"("approval_request_id", "step_order");

-- CreateIndex
CREATE INDEX "demo_approval_subject_tenant_id_legal_entity_id_idx" ON "demo_approval_subject"("tenant_id", "legal_entity_id");

-- CreateIndex
CREATE INDEX "audit_event_tenant_id_created_at_idx" ON "audit_event"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_event_chain_key_sequence_key" ON "audit_event"("chain_key", "sequence");

-- CreateIndex
CREATE INDEX "outbox_event_status_created_at_idx" ON "outbox_event"("status", "created_at");

-- CreateIndex
CREATE INDEX "outbox_event_status_lease_expires_at_idx" ON "outbox_event"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "outbox_event_tenant_id_legal_entity_id_idx" ON "outbox_event"("tenant_id", "legal_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "background_job_idempotency_key_key" ON "background_job"("idempotency_key");

-- CreateIndex
CREATE INDEX "background_job_status_run_at_idx" ON "background_job"("status", "run_at");

-- CreateIndex
CREATE INDEX "background_job_status_lease_expires_at_idx" ON "background_job"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "background_job_tenant_id_legal_entity_id_idx" ON "background_job"("tenant_id", "legal_entity_id");

-- CreateIndex
CREATE INDEX "background_job_status_updated_at_idx" ON "background_job"("status", "updated_at");

-- CreateIndex
CREATE INDEX "notification_recipient_user_id_read_at_idx" ON "notification"("recipient_user_id", "read_at");

-- CreateIndex
CREATE INDEX "notification_tenant_id_legal_entity_id_idx" ON "notification"("tenant_id", "legal_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preference_tenant_id_user_id_channel_type_key" ON "notification_preference"("tenant_id", "user_id", "channel", "type");

-- CreateIndex
CREATE UNIQUE INDEX "file_object_storage_key_key" ON "file_object"("storage_key");

-- CreateIndex
CREATE INDEX "file_object_tenant_id_legal_entity_id_idx" ON "file_object"("tenant_id", "legal_entity_id");

-- CreateIndex
CREATE INDEX "file_object_status_deleted_at_storage_purged_at_idx" ON "file_object"("status", "deleted_at", "storage_purged_at");

-- CreateIndex
CREATE INDEX "attachment_owner_entity_type_owner_entity_id_idx" ON "attachment"("owner_entity_type", "owner_entity_id");

-- CreateIndex
CREATE INDEX "attachment_tenant_id_idx" ON "attachment"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_definition_tenant_id_entity_type_key_key" ON "custom_field_definition"("tenant_id", "entity_type", "key");

-- CreateIndex
CREATE INDEX "custom_field_value_tenant_id_idx" ON "custom_field_value"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_value_definition_id_entity_id_key" ON "custom_field_value"("definition_id", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_key_tenant_id_key_key" ON "idempotency_key"("tenant_id", "key");

-- AddForeignKey
ALTER TABLE "tenant_entitlement" ADD CONSTRAINT "tenant_entitlement_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_setting" ADD CONSTRAINT "tenant_setting_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_entity" ADD CONSTRAINT "legal_entity_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_entity_setting" ADD CONSTRAINT "legal_entity_setting_legal_entity_id_fkey" FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_unit" ADD CONSTRAINT "business_unit_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_unit" ADD CONSTRAINT "business_unit_legal_entity_id_fkey" FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department" ADD CONSTRAINT "department_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department" ADD CONSTRAINT "department_legal_entity_id_fkey" FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department" ADD CONSTRAINT "department_business_unit_id_fkey" FOREIGN KEY ("business_unit_id") REFERENCES "business_unit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team" ADD CONSTRAINT "team_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team" ADD CONSTRAINT "team_legal_entity_id_fkey" FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team" ADD CONSTRAINT "team_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch" ADD CONSTRAINT "branch_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch" ADD CONSTRAINT "branch_legal_entity_id_fkey" FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_legal_entity_id_fkey" FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_centre" ADD CONSTRAINT "cost_centre_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_centre" ADD CONSTRAINT "cost_centre_legal_entity_id_fkey" FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_credential" ADD CONSTRAINT "user_credential_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_credential" ADD CONSTRAINT "mfa_credential_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_recovery_code" ADD CONSTRAINT "mfa_recovery_code_mfa_credential_id_fkey" FOREIGN KEY ("mfa_credential_id") REFERENCES "mfa_credential"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_membership" ADD CONSTRAINT "tenant_membership_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_membership" ADD CONSTRAINT "tenant_membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_invitation" ADD CONSTRAINT "membership_invitation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_invitation" ADD CONSTRAINT "membership_invitation_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_entity_membership" ADD CONSTRAINT "legal_entity_membership_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_entity_membership" ADD CONSTRAINT "legal_entity_membership_legal_entity_id_fkey" FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_entity_membership" ADD CONSTRAINT "legal_entity_membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_entity_membership" ADD CONSTRAINT "legal_entity_membership_granted_by_user_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_role" ADD CONSTRAINT "membership_role_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_role" ADD CONSTRAINT "membership_role_tenant_membership_id_fkey" FOREIGN KEY ("tenant_membership_id") REFERENCES "tenant_membership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_role" ADD CONSTRAINT "membership_role_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_role" ADD CONSTRAINT "membership_role_legal_entity_id_fkey" FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_role" ADD CONSTRAINT "membership_role_assigned_by_user_id_fkey" FOREIGN KEY ("assigned_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_policy" ADD CONSTRAINT "field_policy_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_policy" ADD CONSTRAINT "field_policy_required_permission_id_fkey" FOREIGN KEY ("required_permission_id") REFERENCES "permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_policy" ADD CONSTRAINT "approval_policy_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_policy" ADD CONSTRAINT "approval_policy_legal_entity_id_fkey" FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_step" ADD CONSTRAINT "approval_step_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_step" ADD CONSTRAINT "approval_step_approval_policy_id_fkey" FOREIGN KEY ("approval_policy_id") REFERENCES "approval_policy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_step" ADD CONSTRAINT "approval_step_approver_role_id_fkey" FOREIGN KEY ("approver_role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_legal_entity_id_fkey" FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_approval_policy_id_fkey" FOREIGN KEY ("approval_policy_id") REFERENCES "approval_policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_submitted_by_user_id_fkey" FOREIGN KEY ("submitted_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decision" ADD CONSTRAINT "approval_decision_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decision" ADD CONSTRAINT "approval_decision_approval_request_id_fkey" FOREIGN KEY ("approval_request_id") REFERENCES "approval_request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decision" ADD CONSTRAINT "approval_decision_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demo_approval_subject" ADD CONSTRAINT "demo_approval_subject_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demo_approval_subject" ADD CONSTRAINT "demo_approval_subject_legal_entity_id_fkey" FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demo_approval_subject" ADD CONSTRAINT "demo_approval_subject_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_legal_entity_id_fkey" FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_legal_entity_id_fkey" FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_legal_entity_id_fkey" FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_object" ADD CONSTRAINT "file_object_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_object" ADD CONSTRAINT "file_object_legal_entity_id_fkey" FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_object" ADD CONSTRAINT "file_object_uploaded_by_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_file_object_id_fkey" FOREIGN KEY ("file_object_id") REFERENCES "file_object"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_definition" ADD CONSTRAINT "custom_field_definition_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_definition" ADD CONSTRAINT "custom_field_definition_legal_entity_id_fkey" FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_value" ADD CONSTRAINT "custom_field_value_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_value" ADD CONSTRAINT "custom_field_value_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "custom_field_definition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

