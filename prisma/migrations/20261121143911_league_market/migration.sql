-- CreateTable
CREATE TABLE "market_listings" (
    "id" TEXT NOT NULL,
    "competition_id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "wants" TEXT NOT NULL DEFAULT 'either',
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_listings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "market_listings_competition_id_status_idx" ON "market_listings"("competition_id", "status");

-- CreateIndex
CREATE INDEX "market_listings_player_id_idx" ON "market_listings"("player_id");
