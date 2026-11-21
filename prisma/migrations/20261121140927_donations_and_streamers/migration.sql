-- AlterTable
ALTER TABLE "match_passes" ADD COLUMN     "streamer_amount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "streamer_user_id" TEXT;

-- AlterTable
ALTER TABLE "official_invites" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'invite',
ADD COLUMN     "streamer_share" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "pass_offers" ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'payPerView',
ADD COLUMN     "suggested" JSONB;

-- AlterTable
ALTER TABLE "pass_sales" ADD COLUMN     "donations" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "donations" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "user_id" TEXT,
    "email" TEXT,
    "donor_name" TEXT NOT NULL,
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "message" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "paid_with" TEXT NOT NULL,
    "fee" INTEGER NOT NULL,
    "platform_share" DOUBLE PRECISION NOT NULL,
    "host_share" INTEGER NOT NULL,
    "host_user_id" TEXT NOT NULL,
    "streamer_user_id" TEXT,
    "streamer_amount" INTEGER NOT NULL DEFAULT 0,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "donations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "donations_match_id_at_idx" ON "donations"("match_id", "at");

-- CreateIndex
CREATE INDEX "donations_host_user_id_idx" ON "donations"("host_user_id");

-- CreateIndex
CREATE INDEX "donations_streamer_user_id_idx" ON "donations"("streamer_user_id");
