CREATE TYPE "public"."alert_severity" AS ENUM('warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."metric_status" AS ENUM('up', 'degraded', 'down');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"device_name" varchar(120) NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"message" varchar(255) NOT NULL,
	"at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"acknowledged" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_metrics" (
	"device_id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(120) NOT NULL,
	"type" varchar(40) NOT NULL,
	"area_name" varchar(120) NOT NULL,
	"status" "metric_status" NOT NULL,
	"uptime_pct" real NOT NULL,
	"latency_ms" integer NOT NULL,
	"utilization_pct" integer NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "alerts_at_idx" ON "alerts" USING btree ("at");--> statement-breakpoint
CREATE INDEX "alerts_acknowledged_idx" ON "alerts" USING btree ("acknowledged");