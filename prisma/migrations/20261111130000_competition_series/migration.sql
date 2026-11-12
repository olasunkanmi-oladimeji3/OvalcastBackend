-- Yearly editions: every edition of the same tournament shares a series id (the first edition's id).
-- Existing competitions each start their own series.
ALTER TABLE "competitions" ADD COLUMN "series_id" TEXT;
UPDATE "competitions" SET "series_id" = "id" WHERE "series_id" IS NULL;
ALTER TABLE "competitions" ALTER COLUMN "series_id" SET NOT NULL;
CREATE INDEX "competitions_org_id_series_id_idx" ON "competitions"("org_id", "series_id");
