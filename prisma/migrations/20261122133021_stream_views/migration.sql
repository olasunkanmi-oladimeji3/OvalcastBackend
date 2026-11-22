-- CreateTable
CREATE TABLE "stream_views" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stream_id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "competition_id" TEXT,
    "viewer" TEXT NOT NULL,
    "country" TEXT,
    "region_id" TEXT,

    CONSTRAINT "stream_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stream_views_at_idx" ON "stream_views"("at");

-- CreateIndex
CREATE INDEX "stream_views_stream_id_viewer_at_idx" ON "stream_views"("stream_id", "viewer", "at");
