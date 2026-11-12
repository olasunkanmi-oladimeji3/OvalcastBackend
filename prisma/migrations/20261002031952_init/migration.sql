-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "phone_verified" BOOLEAN NOT NULL DEFAULT false,
    "password_hash" TEXT NOT NULL,
    "city" TEXT,
    "player_id" TEXT,
    "settings" JSONB NOT NULL,
    "officiating" JSONB,
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "org_id" TEXT,
    "club_id" TEXT,
    "role" TEXT NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("token_hash")
);

-- CreateTable
CREATE TABLE "verification_codes" (
    "identifier" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMPTZ NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "user_id" TEXT,

    CONSTRAINT "verification_codes_pkey" PRIMARY KEY ("identifier","purpose")
);

-- CreateTable
CREATE TABLE "regions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "cities" JSONB NOT NULL,

    CONSTRAINT "regions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "short_name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "about" TEXT NOT NULL DEFAULT '',
    "founded" INTEGER NOT NULL,
    "executives" JSONB NOT NULL DEFAULT '[]',
    "sponsors" JSONB NOT NULL DEFAULT '[]',
    "honours" JSONB NOT NULL DEFAULT '[]',
    "season_moves" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "organisations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "org_id" TEXT,
    "name" TEXT NOT NULL,
    "short_name" TEXT NOT NULL,
    "colors" JSONB NOT NULL,
    "home_ground" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "founded" INTEGER NOT NULL,
    "logo_url" TEXT,
    "staff" JSONB NOT NULL DEFAULT '[]',
    "ad_hoc" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "players" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "short_name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "batting_hand" TEXT NOT NULL,
    "bowling_style" TEXT,
    "guest" BOOLEAN NOT NULL DEFAULT false,
    "guest_match_id" TEXT,

    CONSTRAINT "players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_invites" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "contact" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competitions" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "division" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "ball_type" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "points" JSONB NOT NULL,
    "tie_breakers" JSONB NOT NULL,
    "stages" JSONB NOT NULL,
    "team_ids" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL,
    "entry_policy" TEXT NOT NULL,
    "entry_fee" INTEGER NOT NULL DEFAULT 0,
    "max_teams" INTEGER NOT NULL,
    "starts_on" TIMESTAMPTZ NOT NULL,
    "player_rules" JSONB NOT NULL,
    "rules_document" JSONB,
    "season_rules" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "competitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entries" (
    "id" TEXT NOT NULL,
    "competition_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "payment" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMPTZ,

    CONSTRAINT "entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registrations" (
    "id" TEXT NOT NULL,
    "competition_id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "primary" BOOLEAN NOT NULL,
    "since" TIMESTAMPTZ NOT NULL,
    "status" TEXT NOT NULL,

    CONSTRAINT "registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfers" (
    "id" TEXT NOT NULL,
    "competition_id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "from_team_id" TEXT NOT NULL,
    "to_team_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "history" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deductions" (
    "id" TEXT NOT NULL,
    "competition_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "match_id" TEXT,
    "status" TEXT NOT NULL,
    "by" TEXT NOT NULL,
    "by_name" TEXT NOT NULL,
    "at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "deductions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" TEXT NOT NULL,
    "competition_id" TEXT,
    "stage_id" TEXT,
    "group_id" TEXT,
    "title" TEXT,
    "home_team_id" TEXT NOT NULL,
    "away_team_id" TEXT NOT NULL,
    "venue" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ NOT NULL,
    "status" TEXT NOT NULL,
    "toss" JSONB,
    "batting_first_team_id" TEXT,
    "playing_xi" JSONB,
    "officials" JSONB NOT NULL,
    "scores" JSONB NOT NULL DEFAULT '[]',
    "result" JSONB,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "stream_id" TEXT,
    "friendly" BOOLEAN NOT NULL DEFAULT false,
    "conditions" JSONB,
    "round" TEXT,
    "placeholders" JSONB,
    "winner_to" JSONB,
    "created_by" TEXT,
    "scorer_user_id" TEXT,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ball_events" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "innings" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "event" JSONB NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ball_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "toss_sessions" (
    "match_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "caller_team_id" TEXT NOT NULL,
    "call" TEXT,
    "outcome" TEXT,
    "won_by_team_id" TEXT,
    "decision" TEXT,
    "at" TIMESTAMPTZ,

    CONSTRAINT "toss_sessions_pkey" PRIMARY KEY ("match_id")
);

-- CreateTable
CREATE TABLE "official_invites" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "user_name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "invited_by" TEXT NOT NULL,
    "invited_by_name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "official_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "streams" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "playback_url" TEXT NOT NULL,
    "viewers" INTEGER NOT NULL DEFAULT 0,
    "latency_seconds" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "streamer" TEXT NOT NULL,

    CONSTRAINT "streams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clips" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "ball_event_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "over" TEXT NOT NULL,
    "duration_seconds" INTEGER NOT NULL,

    CONSTRAINT "clips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificates" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "uploaded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" JSONB,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posts" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "region_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "author_id" TEXT,
    "author_name" TEXT NOT NULL,
    "team_id" TEXT,
    "whatsapp" TEXT NOT NULL,
    "when" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE INDEX "memberships_club_id_idx" ON "memberships"("club_id");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "teams_org_id_idx" ON "teams"("org_id");

-- CreateIndex
CREATE INDEX "teams_city_idx" ON "teams"("city");

-- CreateIndex
CREATE INDEX "players_team_id_idx" ON "players"("team_id");

-- CreateIndex
CREATE INDEX "players_guest_match_id_idx" ON "players"("guest_match_id");

-- CreateIndex
CREATE INDEX "player_invites_team_id_idx" ON "player_invites"("team_id");

-- CreateIndex
CREATE INDEX "competitions_org_id_idx" ON "competitions"("org_id");

-- CreateIndex
CREATE INDEX "competitions_status_idx" ON "competitions"("status");

-- CreateIndex
CREATE INDEX "entries_competition_id_idx" ON "entries"("competition_id");

-- CreateIndex
CREATE INDEX "entries_team_id_idx" ON "entries"("team_id");

-- CreateIndex
CREATE INDEX "registrations_competition_id_idx" ON "registrations"("competition_id");

-- CreateIndex
CREATE INDEX "registrations_player_id_idx" ON "registrations"("player_id");

-- CreateIndex
CREATE INDEX "registrations_team_id_idx" ON "registrations"("team_id");

-- CreateIndex
CREATE INDEX "transfers_competition_id_idx" ON "transfers"("competition_id");

-- CreateIndex
CREATE INDEX "transfers_player_id_idx" ON "transfers"("player_id");

-- CreateIndex
CREATE INDEX "deductions_competition_id_idx" ON "deductions"("competition_id");

-- CreateIndex
CREATE INDEX "matches_competition_id_idx" ON "matches"("competition_id");

-- CreateIndex
CREATE INDEX "matches_group_id_idx" ON "matches"("group_id");

-- CreateIndex
CREATE INDEX "matches_stage_id_idx" ON "matches"("stage_id");

-- CreateIndex
CREATE INDEX "matches_status_idx" ON "matches"("status");

-- CreateIndex
CREATE INDEX "matches_home_team_id_idx" ON "matches"("home_team_id");

-- CreateIndex
CREATE INDEX "matches_away_team_id_idx" ON "matches"("away_team_id");

-- CreateIndex
CREATE INDEX "matches_scorer_user_id_idx" ON "matches"("scorer_user_id");

-- CreateIndex
CREATE INDEX "matches_starts_at_idx" ON "matches"("starts_at");

-- CreateIndex
CREATE INDEX "ball_events_match_id_created_at_idx" ON "ball_events"("match_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ball_events_match_id_client_id_key" ON "ball_events"("match_id", "client_id");

-- CreateIndex
CREATE INDEX "official_invites_match_id_idx" ON "official_invites"("match_id");

-- CreateIndex
CREATE INDEX "official_invites_user_id_status_idx" ON "official_invites"("user_id", "status");

-- CreateIndex
CREATE INDEX "clips_match_id_idx" ON "clips"("match_id");

-- CreateIndex
CREATE INDEX "certificates_user_id_idx" ON "certificates"("user_id");

-- CreateIndex
CREATE INDEX "notifications_user_id_at_idx" ON "notifications"("user_id", "at");

-- CreateIndex
CREATE INDEX "posts_region_id_created_at_idx" ON "posts"("region_id", "created_at");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_invites" ADD CONSTRAINT "player_invites_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entries" ADD CONSTRAINT "entries_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "competitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entries" ADD CONSTRAINT "entries_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "competitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "competitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deductions" ADD CONSTRAINT "deductions_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "competitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deductions" ADD CONSTRAINT "deductions_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "competitions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ball_events" ADD CONSTRAINT "ball_events_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "toss_sessions" ADD CONSTRAINT "toss_sessions_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "official_invites" ADD CONSTRAINT "official_invites_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "official_invites" ADD CONSTRAINT "official_invites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "streams" ADD CONSTRAINT "streams_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clips" ADD CONSTRAINT "clips_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificates" ADD CONSTRAINT "certificates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
