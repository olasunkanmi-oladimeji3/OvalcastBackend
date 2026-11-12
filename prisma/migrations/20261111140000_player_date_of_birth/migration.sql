-- A player's date of birth, never shown publicly: for age-limited rules (a second club for young
-- players, QYP) and to mark under-18s. Empty for existing players.
ALTER TABLE "players" ADD COLUMN "date_of_birth" DATE;
