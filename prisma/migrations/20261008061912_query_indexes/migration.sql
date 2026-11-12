-- Search by any part of a name, email or phone number needs trigrams.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- DropIndex
DROP INDEX "host_payouts_user_id_idx";

-- DropIndex
DROP INDEX "memberships_club_id_idx";

-- DropIndex
DROP INDEX "pass_sales_host_user_id_idx";

-- DropIndex
DROP INDEX "sessions_user_id_idx";

-- AlterTable
ALTER TABLE "ball_events" ADD COLUMN     "bowler_id" TEXT,
ADD COLUMN     "striker_id" TEXT;

-- CreateIndex
CREATE INDEX "ball_events_created_at_idx" ON "ball_events"("created_at");

-- CreateIndex
CREATE INDEX "ball_events_striker_id_idx" ON "ball_events"("striker_id");

-- CreateIndex
CREATE INDEX "ball_events_bowler_id_idx" ON "ball_events"("bowler_id");

-- CreateIndex
CREATE INDEX "certificates_status_uploaded_at_idx" ON "certificates"("status", "uploaded_at");

-- CreateIndex
CREATE INDEX "checkouts_status_created_at_idx" ON "checkouts"("status", "created_at");

-- CreateIndex
CREATE INDEX "checkouts_status_paid_at_idx" ON "checkouts"("status", "paid_at");

-- CreateIndex
CREATE INDEX "entries_created_at_idx" ON "entries"("created_at");

-- CreateIndex
CREATE INDEX "host_payouts_user_id_at_idx" ON "host_payouts"("user_id", "at");

-- CreateIndex
CREATE INDEX "host_payouts_at_idx" ON "host_payouts"("at");

-- CreateIndex
CREATE INDEX "match_passes_at_idx" ON "match_passes"("at");

-- CreateIndex
CREATE INDEX "match_passes_host_user_id_at_idx" ON "match_passes"("host_user_id", "at");

-- CreateIndex
CREATE INDEX "match_passes_match_id_status_idx" ON "match_passes"("match_id", "status");

-- CreateIndex
CREATE INDEX "matches_started_at_idx" ON "matches"("started_at");

-- CreateIndex
CREATE INDEX "matches_created_by_idx" ON "matches"("created_by");

-- CreateIndex
CREATE INDEX "matches_officials_idx" ON "matches" USING GIN ("officials" jsonb_path_ops);

-- CreateIndex
CREATE INDEX "memberships_org_id_role_idx" ON "memberships"("org_id", "role");

-- CreateIndex
CREATE INDEX "memberships_club_id_role_idx" ON "memberships"("club_id", "role");

-- CreateIndex
CREATE INDEX "pass_sales_host_user_id_at_idx" ON "pass_sales"("host_user_id", "at");

-- CreateIndex
CREATE INDEX "ratings_rater_id_idx" ON "ratings"("rater_id");

-- CreateIndex
CREATE INDEX "sessions_user_id_created_at_idx" ON "sessions"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "sessions_created_at_idx" ON "sessions"("created_at");

-- CreateIndex
CREATE INDEX "staff_actions_staff_id_at_idx" ON "staff_actions"("staff_id", "at");

-- CreateIndex
CREATE INDEX "stories_match_id_created_at_idx" ON "stories"("match_id", "created_at");

-- CreateIndex
CREATE INDEX "streams_match_id_idx" ON "streams"("match_id");

-- CreateIndex
CREATE INDEX "streams_status_idx" ON "streams"("status");

-- CreateIndex
CREATE INDEX "subscriptions_status_renews_at_idx" ON "subscriptions"("status", "renews_at");

-- CreateIndex
CREATE INDEX "users_created_at_idx" ON "users"("created_at");

-- CreateIndex
CREATE INDEX "users_last_seen_at_idx" ON "users"("last_seen_at");

-- CreateIndex
CREATE INDEX "users_player_id_idx" ON "users"("player_id");

-- CreateIndex
CREATE INDEX "users_suspended_at_idx" ON "users"("suspended_at");

-- CreateIndex
CREATE INDEX "users_locked_until_idx" ON "users"("locked_until");

-- CreateIndex
CREATE INDEX "users_delete_on_idx" ON "users"("delete_on");

-- CreateIndex
CREATE INDEX "users_name_trgm_idx" ON "users" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "users_email_trgm_idx" ON "users" USING GIN ("email" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "users_phone_trgm_idx" ON "users" USING GIN ("phone" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "users_follows_idx" ON "users" USING GIN ("follows" jsonb_path_ops);

-- CreateIndex
CREATE INDEX "viewer_credit_purchases_at_idx" ON "viewer_credit_purchases"("at");

-- CreateIndex
CREATE INDEX "wallet_entries_kind_at_idx" ON "wallet_entries"("kind", "at");

-- Existing balls: who faced and who bowled, from the event itself.
UPDATE "ball_events" SET "striker_id" = "event"->>'strikerId', "bowler_id" = "event"->>'bowlerId' WHERE "striker_id" IS NULL;

-- Passes sold before the split was stored: their match's overall split, in proportion.
UPDATE "match_passes" p SET
  "fee" = ROUND(s."fees"::numeric * p."price" / NULLIF(s."gross", 0))::int,
  "host_share" = ROUND(s."host"::numeric * p."price" / NULLIF(s."gross", 0))::int
FROM "pass_sales" s
WHERE p."fee" IS NULL AND s."match_id" = p."match_id" AND s."host_user_id" = p."host_user_id";
UPDATE "match_passes" SET "fee" = 0, "host_share" = 0 WHERE "fee" IS NULL;
