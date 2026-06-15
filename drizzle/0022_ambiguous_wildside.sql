CREATE TYPE "public"."device_status" AS ENUM('online', 'degraded', 'offline');--> statement-breakpoint
CREATE TYPE "public"."device_type" AS ENUM('olt', 'onu', 'mikrotik');--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"type" "device_type" NOT NULL,
	"ip_address" varchar(60) NOT NULL,
	"status" "device_status" DEFAULT 'online' NOT NULL,
	"uptime_hours" integer DEFAULT 0 NOT NULL,
	"rx_power" double precision,
	"area_name" varchar(120) NOT NULL,
	"last_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"topology_node_id" varchar(120),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE INDEX "devices_status_idx" ON "devices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "devices_type_idx" ON "devices" USING btree ("type");