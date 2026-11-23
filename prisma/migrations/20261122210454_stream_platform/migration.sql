-- AlterTable
ALTER TABLE "streams" ADD COLUMN     "platform" TEXT NOT NULL DEFAULT 'ovalcast',
ADD COLUMN     "small_settled_at" TIMESTAMPTZ;
