-- Phase 3: one configurable platform share. Each pass records the rate it used; organisations and
-- streamers can have their own. Additive only: existing rows keep NULL (past sales never change).
ALTER TABLE "match_passes" ADD COLUMN "platform_share" DOUBLE PRECISION;
ALTER TABLE "organisations" ADD COLUMN "platform_share" DOUBLE PRECISION;
ALTER TABLE "organisations" ADD COLUMN "entry_share" DOUBLE PRECISION;
ALTER TABLE "users" ADD COLUMN "platform_share" DOUBLE PRECISION;
