CREATE TYPE "public"."work_order_status" AS ENUM('scheduled', 'in_progress', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."work_order_type" AS ENUM('install', 'repair', 'dismantle');--> statement-breakpoint
CREATE SEQUENCE "public"."work_order_code_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 9001 CACHE 1;--> statement-breakpoint
CREATE TABLE "work_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(32) DEFAULT 'WO-' || nextval('work_order_code_seq') NOT NULL,
	"type" "work_order_type" NOT NULL,
	"customer_id" uuid,
	"customer_name" varchar(120) NOT NULL,
	"technician" varchar(120),
	"scheduled_at" timestamp (3) with time zone NOT NULL,
	"status" "work_order_status" DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_orders_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_orders_status_idx" ON "work_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "work_orders_customer_id_idx" ON "work_orders" USING btree ("customer_id");