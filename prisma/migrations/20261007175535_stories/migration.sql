-- CreateTable
CREATE TABLE "stories" (
    "id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "author_name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "photo_urls" JSONB NOT NULL DEFAULT '[]',
    "team_id" TEXT,
    "match_id" TEXT,
    "competition_id" TEXT,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "story_likes" (
    "story_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "story_likes_pkey" PRIMARY KEY ("story_id","user_id")
);

-- CreateTable
CREATE TABLE "story_comments" (
    "id" TEXT NOT NULL,
    "story_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "author_name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "story_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stories_created_at_idx" ON "stories"("created_at");

-- CreateIndex
CREATE INDEX "stories_team_id_created_at_idx" ON "stories"("team_id", "created_at");

-- CreateIndex
CREATE INDEX "stories_competition_id_created_at_idx" ON "stories"("competition_id", "created_at");

-- CreateIndex
CREATE INDEX "stories_author_id_created_at_idx" ON "stories"("author_id", "created_at");

-- CreateIndex
CREATE INDEX "story_comments_story_id_created_at_idx" ON "story_comments"("story_id", "created_at");
