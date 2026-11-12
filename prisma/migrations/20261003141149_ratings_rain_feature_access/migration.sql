-- AlterTable
ALTER TABLE "competitions" ADD COLUMN     "rain_rule" TEXT NOT NULL DEFAULT 'arr';

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "reduced" JSONB;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "playing" JSONB;

-- CreateTable
CREATE TABLE "ratings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "rater_id" TEXT NOT NULL,
    "rater_name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "match_id" TEXT,
    "scores" JSONB NOT NULL,
    "comment" TEXT,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "ratings_user_id_role_idx" ON "ratings"("user_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "ratings_user_id_rater_id_role_match_id_key" ON "ratings"("user_id", "rater_id", "role", "match_id");
