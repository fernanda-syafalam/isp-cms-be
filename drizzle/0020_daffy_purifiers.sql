CREATE TYPE "public"."acs_status" AS ENUM('online', 'offline');--> statement-breakpoint
CREATE TABLE "acs_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"serial" varchar(80) NOT NULL,
	"customer_name" varchar(120) NOT NULL,
	"model" varchar(80) NOT NULL,
	"firmware" varchar(40) NOT NULL,
	"rx_power_dbm" real,
	"status" "acs_status" DEFAULT 'online' NOT NULL,
	"last_inform" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acs_devices_serial_unique" UNIQUE("serial")
);
--> statement-breakpoint
CREATE INDEX "acs_devices_status_idx" ON "acs_devices" USING btree ("status");