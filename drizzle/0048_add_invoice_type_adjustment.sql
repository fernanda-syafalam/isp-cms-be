CREATE TYPE "public"."invoice_type" AS ENUM('regular', 'adjustment');--> statement-breakpoint
DROP INDEX "invoices_customer_period_idx";--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "type" "invoice_type" DEFAULT 'regular' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "note" varchar(200);--> statement-breakpoint
CREATE INDEX "invoices_type_idx" ON "invoices" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_customer_period_idx" ON "invoices" USING btree ("customer_id","period_start") WHERE "invoices"."type" = 'regular';