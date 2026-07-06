CREATE TYPE "public"."reseller_payout_status" AS ENUM('requested', 'approved', 'rejected', 'paid');--> statement-breakpoint
CREATE TABLE "reseller_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reseller_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"status" "reseller_payout_status" DEFAULT 'requested' NOT NULL,
	"note" varchar(200) DEFAULT '' NOT NULL,
	"requested_by" uuid,
	"decided_by" uuid,
	"ledger_entry_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp (3) with time zone
);
--> statement-breakpoint
ALTER TABLE "reseller_payouts" ADD CONSTRAINT "reseller_payouts_reseller_id_resellers_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_payouts" ADD CONSTRAINT "reseller_payouts_ledger_entry_id_reseller_ledger_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."reseller_ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reseller_payouts_reseller_id_idx" ON "reseller_payouts" USING btree ("reseller_id");--> statement-breakpoint
CREATE INDEX "reseller_payouts_status_idx" ON "reseller_payouts" USING btree ("status");