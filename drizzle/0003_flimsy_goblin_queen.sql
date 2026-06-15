CREATE TYPE "public"."customer_status" AS ENUM('prospek', 'instalasi', 'aktif', 'isolir', 'berhenti');--> statement-breakpoint
CREATE SEQUENCE "public"."customer_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 9001 CACHE 1;--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_no" varchar(32) DEFAULT 'CUST-' || nextval('customer_no_seq') NOT NULL,
	"full_name" varchar(120) NOT NULL,
	"phone" varchar(20) NOT NULL,
	"email" varchar(255),
	"address" varchar(255) NOT NULL,
	"area_id" uuid,
	"area_name" varchar(120),
	"plan_id" uuid NOT NULL,
	"status" "customer_status" DEFAULT 'prospek' NOT NULL,
	"outstanding" integer DEFAULT 0 NOT NULL,
	"npwp" varchar(40),
	"ktp" varchar(32),
	"consent_at" timestamp (3) with time zone,
	"data_deletion_requested_at" timestamp (3) with time zone,
	"reseller_name" varchar(120),
	"connection" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_customer_no_unique" UNIQUE("customer_no")
);
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_status_idx" ON "customers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "customers_full_name_idx" ON "customers" USING btree ("full_name");--> statement-breakpoint
CREATE INDEX "customers_plan_id_idx" ON "customers" USING btree ("plan_id");