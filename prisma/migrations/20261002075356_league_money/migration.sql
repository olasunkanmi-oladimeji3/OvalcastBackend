-- CreateTable
CREATE TABLE "payout_accounts" (
    "org_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "institution_code" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "account_name" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subaccount_code" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "verified_at" TIMESTAMPTZ NOT NULL,
    "changed_by" TEXT NOT NULL,
    "changed_by_name" TEXT NOT NULL,
    "hold_until" TIMESTAMPTZ,

    CONSTRAINT "payout_accounts_pkey" PRIMARY KEY ("org_id")
);

-- CreateTable
CREATE TABLE "settlements" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "payment_count" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "account_label" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMPTZ,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "settlements_org_id_created_at_idx" ON "settlements"("org_id", "created_at");

-- AddForeignKey
ALTER TABLE "payout_accounts" ADD CONSTRAINT "payout_accounts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
