-- AlterTable
ALTER TABLE "host_payouts" ADD COLUMN     "account_label" TEXT,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "paid_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "payout_accounts" ADD COLUMN     "account_number_enc" TEXT;

-- CreateTable
CREATE TABLE "user_payout_accounts" (
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "institution_code" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "account_number_enc" TEXT NOT NULL,
    "verified_at" TIMESTAMPTZ NOT NULL,
    "hold_until" TIMESTAMPTZ,

    CONSTRAINT "user_payout_accounts_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "money_logs" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_id" TEXT NOT NULL,
    "org_id" TEXT,
    "action" TEXT NOT NULL,
    "amount" INTEGER,
    "currency" TEXT,
    "reference" TEXT,
    "device_id" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "detail" TEXT,

    CONSTRAINT "money_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "money_logs_user_id_at_idx" ON "money_logs"("user_id", "at");

-- CreateIndex
CREATE INDEX "money_logs_org_id_at_idx" ON "money_logs"("org_id", "at");

-- AddForeignKey
ALTER TABLE "user_payout_accounts" ADD CONSTRAINT "user_payout_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
