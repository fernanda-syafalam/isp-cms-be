CREATE TYPE "public"."notification_event" AS ENUM('invoice_created', 'due_soon', 'overdue', 'isolir', 'paid', 'ticket_update');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('sent', 'failed');--> statement-breakpoint
CREATE TABLE "notification_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient" varchar(20) NOT NULL,
	"template_name" varchar(120) NOT NULL,
	"channel" varchar(20) DEFAULT 'whatsapp' NOT NULL,
	"status" "notification_status" DEFAULT 'sent' NOT NULL,
	"body" varchar(1000) NOT NULL,
	"at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event" "notification_event" NOT NULL,
	"name" varchar(120) NOT NULL,
	"channel" varchar(20) DEFAULT 'whatsapp' NOT NULL,
	"body" varchar(1000) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_templates_event_unique" UNIQUE("event")
);
--> statement-breakpoint
CREATE INDEX "notification_log_at_idx" ON "notification_log" USING btree ("at");