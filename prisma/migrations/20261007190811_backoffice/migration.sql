-- AlterTable
ALTER TABLE "match_passes" ADD COLUMN     "fee" INTEGER,
ADD COLUMN     "host_share" INTEGER;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "last_seen_at" TIMESTAMPTZ,
ADD COLUMN     "suspended_at" TIMESTAMPTZ,
ADD COLUMN     "suspended_reason" TEXT;

-- CreateTable
CREATE TABLE "staff_actions" (
    "id" TEXT NOT NULL,
    "staff_id" TEXT NOT NULL,
    "staff_name" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_kind" TEXT NOT NULL,
    "target_id" TEXT,
    "note" TEXT,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "staff_actions_at_idx" ON "staff_actions"("at");

-- CreateIndex
CREATE INDEX "staff_actions_target_kind_target_id_idx" ON "staff_actions"("target_kind", "target_id");
