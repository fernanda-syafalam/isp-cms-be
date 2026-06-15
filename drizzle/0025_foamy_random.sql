CREATE TYPE "public"."payment_channel" AS ENUM('qris', 'va_bca', 'va_mandiri', 'va_bri', 'va_bni', 'gopay', 'ovo', 'dana', 'shopeepay');--> statement-breakpoint
CREATE TYPE "public"."payment_intent_status" AS ENUM('pending', 'paid', 'expired');--> statement-breakpoint
CREATE TABLE "payment_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"invoice_no" varchar(32) NOT NULL,
	"customer_name" varchar(120) NOT NULL,
	"amount" integer NOT NULL,
	"channel" "payment_channel" NOT NULL,
	"status" "payment_intent_status" DEFAULT 'pending' NOT NULL,
	"va_number" varchar(40),
	"qr_payload" varchar(512),
	"expires_at" timestamp (3) with time zone NOT NULL,
	"paid_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_intents_invoice_id_idx" ON "payment_intents" USING btree ("invoice_id");