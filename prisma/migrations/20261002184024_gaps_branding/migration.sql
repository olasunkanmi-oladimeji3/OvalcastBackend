-- AlterTable
ALTER TABLE "competitions" ADD COLUMN     "cover_url" TEXT,
ADD COLUMN     "logo_url" TEXT,
ADD COLUMN     "tier" INTEGER;

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "outcome_note" TEXT,
ADD COLUMN     "player_of_match_id" TEXT;

-- AlterTable
ALTER TABLE "organisations" ADD COLUMN     "brand_color" TEXT,
ADD COLUMN     "cover_url" TEXT,
ADD COLUMN     "logo_url" TEXT;

-- AlterTable
ALTER TABLE "players" ADD COLUMN     "guardian_consent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "minor" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "registrations" ADD COLUMN     "approved" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "delete_on" TIMESTAMPTZ,
ADD COLUMN     "follows" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "staff" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "fixture_requests" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "requested_by_name" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ,
    "venue" TEXT,
    "note" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fixture_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fixture_requests_match_id_idx" ON "fixture_requests"("match_id");
