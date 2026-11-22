-- CreateTable
CREATE TABLE "ovalcast_settlements" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "note" TEXT,
    "staff_id" TEXT NOT NULL,
    "staff_name" TEXT NOT NULL,

    CONSTRAINT "ovalcast_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ovalcast_settlements_currency_at_idx" ON "ovalcast_settlements"("currency", "at");
