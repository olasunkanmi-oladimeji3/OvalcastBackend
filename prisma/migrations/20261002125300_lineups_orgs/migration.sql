-- AlterTable
ALTER TABLE "competitions" ADD COLUMN     "category" TEXT NOT NULL DEFAULT 'league';

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "leaders" JSONB,
ADD COLUMN     "practice" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "organisations" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'league';

-- AlterTable
ALTER TABLE "teams" ADD COLUMN     "parent_team_id" TEXT;

-- CreateTable
CREATE TABLE "team_sheets" (
    "match_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "player_ids" JSONB NOT NULL,
    "reserves" JSONB NOT NULL DEFAULT '[]',
    "captain_id" TEXT,
    "keeper_id" TEXT,
    "submitted_by" TEXT NOT NULL,
    "submitted_by_name" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_sheets_pkey" PRIMARY KEY ("match_id","team_id")
);
