CREATE TYPE "public"."announcement_severity" AS ENUM('info', 'warning', 'outage');--> statement-breakpoint
CREATE TABLE "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(160) NOT NULL,
	"body" varchar(1000) NOT NULL,
	"severity" "announcement_severity" DEFAULT 'info' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp (3) with time zone,
	"ends_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "acs_devices" ADD COLUMN "ssid" varchar(32);--> statement-breakpoint
CREATE INDEX "announcements_active_idx" ON "announcements" USING btree ("active");