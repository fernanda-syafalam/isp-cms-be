CREATE TYPE "public"."sla_credit_status" AS ENUM('pending', 'applied', 'void');--> statement-breakpoint
CREATE TABLE "sla_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid,
	"customer_name" varchar(120) NOT NULL,
	"amount" integer NOT NULL,
	"reason" varchar(200) NOT NULL,
	"ticket_id" uuid,
	"ticket_code" varchar(40),
	"status" "sla_credit_status" DEFAULT 'pending' NOT NULL,
	"applied_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sla_credits" ADD CONSTRAINT "sla_credits_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_credits" ADD CONSTRAINT "sla_credits_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sla_credits_status_idx" ON "sla_credits" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sla_credits_customer_id_idx" ON "sla_credits" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "sla_credits_created_at_idx" ON "sla_credits" USING btree ("created_at");