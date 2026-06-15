CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'pending', 'overdue', 'paid');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('qris', 'va', 'ewallet', 'transfer', 'cash');--> statement-breakpoint
CREATE SEQUENCE "public"."invoice_no_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 100 CACHE 1;--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_no" varchar(32) DEFAULT 'INV-' || to_char(now(), 'YYYY') || '-' || nextval('invoice_no_seq') NOT NULL,
	"customer_id" uuid NOT NULL,
	"customer_name" varchar(120) NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"amount" integer NOT NULL,
	"late_fee" integer DEFAULT 0 NOT NULL,
	"tax_amount" integer DEFAULT 0 NOT NULL,
	"tax_invoice_no" varchar(40),
	"status" "invoice_status" DEFAULT 'pending' NOT NULL,
	"due_date" date NOT NULL,
	"paid_at" timestamp (3) with time zone,
	"last_reminded_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_invoice_no_unique" UNIQUE("invoice_no")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"invoice_no" varchar(32) NOT NULL,
	"customer_id" uuid NOT NULL,
	"customer_name" varchar(120) NOT NULL,
	"amount" integer NOT NULL,
	"method" "payment_method" NOT NULL,
	"paid_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_customer_id_idx" ON "invoices" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "invoices_status_idx" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_customer_period_idx" ON "invoices" USING btree ("customer_id","period_start");--> statement-breakpoint
CREATE INDEX "payments_invoice_id_idx" ON "payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payments_customer_id_idx" ON "payments" USING btree ("customer_id");