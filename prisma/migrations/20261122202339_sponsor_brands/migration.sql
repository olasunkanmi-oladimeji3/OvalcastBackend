-- AlterTable
ALTER TABLE "organisations" ADD COLUMN     "sponsor_brands" JSONB NOT NULL DEFAULT '[]';
