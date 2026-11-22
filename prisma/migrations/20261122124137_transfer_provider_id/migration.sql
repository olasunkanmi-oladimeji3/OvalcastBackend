-- AlterTable
ALTER TABLE "host_payouts" ADD COLUMN     "provider_id" TEXT;

-- AlterTable
ALTER TABLE "settlements" ADD COLUMN     "provider_id" TEXT;
