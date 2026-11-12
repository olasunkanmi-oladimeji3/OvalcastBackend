-- AlterTable
ALTER TABLE "host_payouts" ADD COLUMN     "currency" TEXT;

-- AlterTable
ALTER TABLE "pass_sales" ADD COLUMN     "currency" TEXT;

-- AlterTable
ALTER TABLE "streams" ADD COLUMN     "down_seconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "live_seconds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refunded_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "country" DROP NOT NULL,
ALTER COLUMN "country" DROP DEFAULT;

-- AlterTable
ALTER TABLE "wallets" ADD COLUMN     "currency" TEXT;
