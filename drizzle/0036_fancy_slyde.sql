ALTER TYPE "public"."invoice_status" ADD VALUE 'partial' BEFORE 'overdue';--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "billing_anchor_day" smallint;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "discount_amount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "paid_amount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "tendered_amount" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "change_amount" integer;--> statement-breakpoint
ALTER TABLE "sla_credits" ADD COLUMN "applied_invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "sla_credits" ADD CONSTRAINT "sla_credits_applied_invoice_id_invoices_id_fk" FOREIGN KEY ("applied_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;