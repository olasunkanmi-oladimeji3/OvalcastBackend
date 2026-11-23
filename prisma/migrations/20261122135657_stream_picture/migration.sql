-- AlterTable
ALTER TABLE "streams" ADD COLUMN     "checked_at" TIMESTAMPTZ,
ADD COLUMN     "down_alerted_at" TIMESTAMPTZ,
ADD COLUMN     "picture" TEXT NOT NULL DEFAULT 'waiting',
ADD COLUMN     "picture_at" TIMESTAMPTZ,
ADD COLUMN     "replay_parts" JSONB;
