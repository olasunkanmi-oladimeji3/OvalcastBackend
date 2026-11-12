-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "started_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "organisations" ADD COLUMN     "plan" TEXT NOT NULL DEFAULT 'free',
ADD COLUMN     "viewer_hours_left" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "viewer_hours_used" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "country" TEXT NOT NULL DEFAULT 'Nigeria';

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL,
    "renews_at" TIMESTAMPTZ NOT NULL,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkouts" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "ref_id" TEXT,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "method" TEXT NOT NULL,
    "provider_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMPTZ,

    CONSTRAINT "checkouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "user_id" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "wallet_entries" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pass_offers" (
    "match_id" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "host_user_id" TEXT NOT NULL,
    "host_name" TEXT NOT NULL,
    "season" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "pass_offers_pkey" PRIMARY KEY ("match_id")
);

-- CreateTable
CREATE TABLE "match_passes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "match_id" TEXT,
    "competition_id" TEXT,
    "price" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "paid_with" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "device_id" TEXT,
    "host_user_id" TEXT NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_passes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pass_sales" (
    "match_id" TEXT NOT NULL,
    "host_user_id" TEXT NOT NULL,
    "passes" INTEGER NOT NULL,
    "gross" INTEGER NOT NULL,
    "fees" INTEGER NOT NULL,
    "host" INTEGER NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pass_sales_pkey" PRIMARY KEY ("match_id","host_user_id")
);

-- CreateTable
CREATE TABLE "host_payouts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "host_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "viewer_credit_purchases" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "hours" INTEGER NOT NULL,
    "price" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "viewer_credit_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subscriptions_user_id_status_idx" ON "subscriptions"("user_id", "status");

-- CreateIndex
CREATE INDEX "checkouts_user_id_created_at_idx" ON "checkouts"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "wallet_entries_user_id_at_idx" ON "wallet_entries"("user_id", "at");

-- CreateIndex
CREATE INDEX "match_passes_user_id_status_idx" ON "match_passes"("user_id", "status");

-- CreateIndex
CREATE INDEX "pass_sales_host_user_id_idx" ON "pass_sales"("host_user_id");

-- CreateIndex
CREATE INDEX "host_payouts_user_id_idx" ON "host_payouts"("user_id");

-- CreateIndex
CREATE INDEX "viewer_credit_purchases_org_id_idx" ON "viewer_credit_purchases"("org_id");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "wallets"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pass_offers" ADD CONSTRAINT "pass_offers_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_passes" ADD CONSTRAINT "match_passes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
