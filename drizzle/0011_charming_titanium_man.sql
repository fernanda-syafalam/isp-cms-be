CREATE TYPE "public"."contract_status" AS ENUM('draft', 'sent', 'signed');--> statement-breakpoint
CREATE SEQUENCE "public"."contract_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" varchar(32) DEFAULT 'PKS-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('contract_no_seq')::text, 4, '0') NOT NULL,
	"customer_id" uuid NOT NULL,
	"customer_name" varchar(120) NOT NULL,
	"plan_name" varchar(80) NOT NULL,
	"status" "contract_status" DEFAULT 'draft' NOT NULL,
	"meterai" boolean DEFAULT false NOT NULL,
	"signed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contracts_number_unique" UNIQUE("number"),
	CONSTRAINT "contracts_customer_id_unique" UNIQUE("customer_id")
);
--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contracts_status_idx" ON "contracts" USING btree ("status");