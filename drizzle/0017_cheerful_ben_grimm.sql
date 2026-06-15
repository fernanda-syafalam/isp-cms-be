CREATE TYPE "public"."branch_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"city" varchar(80) NOT NULL,
	"manager" varchar(120) NOT NULL,
	"phone" varchar(20) NOT NULL,
	"status" "branch_status" DEFAULT 'active' NOT NULL,
	"is_head_office" boolean DEFAULT false NOT NULL,
	"customer_count" integer DEFAULT 0 NOT NULL,
	"mrr" integer DEFAULT 0 NOT NULL,
	"device_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "branches_status_idx" ON "branches" USING btree ("status");