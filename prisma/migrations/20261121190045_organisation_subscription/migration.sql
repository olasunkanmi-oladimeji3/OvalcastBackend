-- AlterTable
ALTER TABLE "organisations" ADD COLUMN     "plan_contract" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "org_id" TEXT,
ADD COLUMN     "reminded_for" TIMESTAMPTZ;

-- CreateIndex
CREATE INDEX "subscriptions_org_id_idx" ON "subscriptions"("org_id");
