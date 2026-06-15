CREATE TYPE "public"."reseller_ledger_type" AS ENUM('topup', 'commission', 'deduction', 'withdrawal');--> statement-breakpoint
CREATE TYPE "public"."reseller_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TABLE "reseller_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reseller_id" uuid NOT NULL,
	"type" "reseller_ledger_type" NOT NULL,
	"amount" integer NOT NULL,
	"note" varchar(200) DEFAULT '' NOT NULL,
	"balance_after" integer NOT NULL,
	"at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resellers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"area" varchar(120) NOT NULL,
	"balance" integer DEFAULT 0 NOT NULL,
	"commission_pct" real DEFAULT 0 NOT NULL,
	"status" "reseller_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reseller_ledger" ADD CONSTRAINT "reseller_ledger_reseller_id_resellers_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reseller_ledger_reseller_id_idx" ON "reseller_ledger" USING btree ("reseller_id");--> statement-breakpoint
CREATE INDEX "reseller_ledger_at_idx" ON "reseller_ledger" USING btree ("at");--> statement-breakpoint
CREATE INDEX "resellers_status_idx" ON "resellers" USING btree ("status");