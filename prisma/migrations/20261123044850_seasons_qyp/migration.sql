-- CreateTable
CREATE TABLE "org_seasons" (
    "org_id" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "qyp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "qyp_max_age" INTEGER NOT NULL DEFAULT 23,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "org_seasons_pkey" PRIMARY KEY ("org_id","season")
);

-- CreateTable
CREATE TABLE "season_qyp" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "main_team_id" TEXT NOT NULL,
    "qyp_team_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "season_qyp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clash_allowances" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "allowed_by" TEXT NOT NULL,
    "allowed_by_name" TEXT NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clash_allowances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "season_qyp_org_id_season_status_idx" ON "season_qyp"("org_id", "season", "status");

-- CreateIndex
CREATE UNIQUE INDEX "season_qyp_org_id_season_player_id_key" ON "season_qyp"("org_id", "season", "player_id");

-- CreateIndex
CREATE UNIQUE INDEX "clash_allowances_match_id_player_id_key" ON "clash_allowances"("match_id", "player_id");
