CREATE TYPE "public"."voucher_status" AS ENUM('unused', 'used', 'expired');--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(32) NOT NULL,
	"batch_id" varchar(32) NOT NULL,
	"profile" varchar(80) NOT NULL,
	"price_idr" integer NOT NULL,
	"duration_days" integer NOT NULL,
	"status" "voucher_status" DEFAULT 'unused' NOT NULL,
	"used_at" timestamp (3) with time zone,
	"used_by" varchar(120),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vouchers_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE INDEX "vouchers_status_idx" ON "vouchers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "vouchers_batch_id_idx" ON "vouchers" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "vouchers_created_at_idx" ON "vouchers" USING btree ("created_at");