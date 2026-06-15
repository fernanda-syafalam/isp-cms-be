CREATE TYPE "public"."router_status" AS ENUM('online', 'offline');--> statement-breakpoint
CREATE TABLE "routers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(80) NOT NULL,
	"address" varchar(120) NOT NULL,
	"api_port" integer NOT NULL,
	"username" varchar(60) NOT NULL,
	"model" varchar(60) NOT NULL,
	"version" varchar(40) NOT NULL,
	"status" "router_status" DEFAULT 'online' NOT NULL,
	"secret_count" integer DEFAULT 0 NOT NULL,
	"last_sync_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "routers_status_idx" ON "routers" USING btree ("status");