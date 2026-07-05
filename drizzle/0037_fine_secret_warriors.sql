ALTER TABLE "work_orders" ADD COLUMN "ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_orders_ticket_id_idx" ON "work_orders" USING btree ("ticket_id");