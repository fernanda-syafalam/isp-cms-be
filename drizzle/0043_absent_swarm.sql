CREATE TYPE "public"."payment_source" AS ENUM('invoice', 'voucher');--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "invoice_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "invoice_no" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "customer_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "source" "payment_source" DEFAULT 'invoice' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "voucher_id" uuid;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN "reseller_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_voucher_id_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."vouchers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_reseller_id_resellers_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_voucher_id_idx" ON "payments" USING btree ("voucher_id");--> statement-breakpoint
CREATE INDEX "vouchers_reseller_id_idx" ON "vouchers" USING btree ("reseller_id");