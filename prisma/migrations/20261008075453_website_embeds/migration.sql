-- AlterTable
ALTER TABLE "organisations" ADD COLUMN     "embed_domains" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "embeds_approved_at" TIMESTAMPTZ,
ADD COLUMN     "embeds_approved_by" TEXT,
ADD COLUMN     "embeds_requested_at" TIMESTAMPTZ;
