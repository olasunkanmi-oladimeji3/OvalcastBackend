-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "scoring_device_id" TEXT;

-- AlterTable
ALTER TABLE "players" ADD COLUMN     "claimed_by_user_id" TEXT;

-- AlterTable
ALTER TABLE "streams" ADD COLUMN     "live_input_id" TEXT,
ADD COLUMN     "started_by" TEXT;

-- CreateTable
CREATE TABLE "scorer_handovers" (
    "match_id" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "from_user" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "scorer_handovers_pkey" PRIMARY KEY ("match_id")
);

-- CreateTable
CREATE TABLE "rule_documents" (
    "id" TEXT NOT NULL,
    "competition_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "size_kb" INTEGER NOT NULL,
    "file_key" TEXT NOT NULL,
    "uploaded_by" TEXT NOT NULL,
    "uploaded_by_name" TEXT NOT NULL,
    "uploaded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_claims" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "player_name" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "user_name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMPTZ,

    CONSTRAINT "player_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "youtube_keys" (
    "owner_id" TEXT NOT NULL,
    "owner_kind" TEXT NOT NULL,
    "key_enc" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "youtube_keys_pkey" PRIMARY KEY ("owner_id")
);

-- CreateTable
CREATE TABLE "api_clients" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "sandbox" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "usage_month" TEXT NOT NULL DEFAULT '',
    "requests_this_month" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "api_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner_webhooks" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "webhook_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rule_documents_competition_id_version_key" ON "rule_documents"("competition_id", "version");

-- CreateIndex
CREATE INDEX "player_claims_team_id_status_idx" ON "player_claims"("team_id", "status");

-- CreateIndex
CREATE INDEX "player_claims_player_id_idx" ON "player_claims"("player_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_clients_key_hash_key" ON "api_clients"("key_hash");

-- CreateIndex
CREATE INDEX "api_clients_org_id_idx" ON "api_clients"("org_id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "partner_webhooks" ADD CONSTRAINT "partner_webhooks_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "api_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "partner_webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
