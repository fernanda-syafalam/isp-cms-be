CREATE TYPE "public"."coverage_status" AS ENUM('operational', 'maintenance', 'down');--> statement-breakpoint
CREATE TYPE "public"."coverage_type" AS ENUM('pop', 'area');--> statement-breakpoint
CREATE TABLE "coverage_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"type" "coverage_type" NOT NULL,
	"region" varchar(120) NOT NULL,
	"capacity" integer NOT NULL,
	"active_connections" integer DEFAULT 0 NOT NULL,
	"status" "coverage_status" DEFAULT 'operational' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coverage_areas_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE INDEX "coverage_areas_status_idx" ON "coverage_areas" USING btree ("status");