-- CreateIndex
CREATE INDEX "teams_staff_idx" ON "teams" USING GIN ("staff" jsonb_path_ops);
