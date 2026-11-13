-- AlterTable
ALTER TABLE "registrations" ADD COLUMN     "held_reason" TEXT,
ADD COLUMN     "override_by" TEXT,
ADD COLUMN     "override_note" TEXT;

-- AlterTable
ALTER TABLE "player_invites" ADD COLUMN     "date_of_birth" DATE;
