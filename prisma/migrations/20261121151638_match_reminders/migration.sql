-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "reminders_sent" TEXT[] DEFAULT ARRAY[]::TEXT[];
