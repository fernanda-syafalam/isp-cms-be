CREATE TYPE "public"."lead_source" AS ENUM('walk_in', 'referral', 'online', 'reseller');--> statement-breakpoint
CREATE TYPE "public"."lead_stage" AS ENUM('new', 'survey', 'quote', 'won', 'lost');--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"phone" varchar(20) NOT NULL,
	"address" varchar(255) NOT NULL,
	"area_name" varchar(120) NOT NULL,
	"plan_name" varchar(80) NOT NULL,
	"stage" "lead_stage" DEFAULT 'new' NOT NULL,
	"est_value" integer NOT NULL,
	"source" "lead_source" NOT NULL,
	"note" varchar(500),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "leads_stage_idx" ON "leads" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "leads_created_at_idx" ON "leads" USING btree ("created_at");