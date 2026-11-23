-- CreateTable
CREATE TABLE "referee_reports" (
    "match_id" TEXT NOT NULL,
    "referee_id" TEXT NOT NULL,
    "referee_name" TEXT NOT NULL,
    "conduct" JSONB NOT NULL,
    "pitch" INTEGER NOT NULL,
    "incidents" TEXT NOT NULL DEFAULT '',
    "reported" JSONB NOT NULL DEFAULT '[]',
    "submitted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "referee_reports_pkey" PRIMARY KEY ("match_id")
);

-- CreateTable
CREATE TABLE "match_reviews_due" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "team_id" TEXT,
    "user_id" TEXT NOT NULL,
    "asked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reminded_at" TIMESTAMPTZ,
    "flagged_at" TIMESTAMPTZ,
    "done_at" TIMESTAMPTZ,

    CONSTRAINT "match_reviews_due_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "match_reviews_due_done_at_asked_at_idx" ON "match_reviews_due"("done_at", "asked_at");

-- CreateIndex
CREATE UNIQUE INDEX "match_reviews_due_match_id_kind_user_id_key" ON "match_reviews_due"("match_id", "kind", "user_id");
