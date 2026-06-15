CREATE TYPE "public"."inventory_kind" AS ENUM('onu', 'router', 'mikrotik');--> statement-breakpoint
CREATE TYPE "public"."inventory_status" AS ENUM('warehouse', 'installed', 'broken');--> statement-breakpoint
CREATE TYPE "public"."stock_movement_type" AS ENUM('in', 'assign', 'return', 'broken');--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "inventory_kind" NOT NULL,
	"serial" varchar(80) NOT NULL,
	"status" "inventory_status" DEFAULT 'warehouse' NOT NULL,
	"assigned_to" varchar(120),
	"assigned_customer_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_items_serial_unique" UNIQUE("serial")
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"serial" varchar(80) NOT NULL,
	"kind" "inventory_kind" NOT NULL,
	"type" "stock_movement_type" NOT NULL,
	"note" varchar(255) NOT NULL,
	"at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_assigned_customer_id_customers_id_fk" FOREIGN KEY ("assigned_customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_items_status_idx" ON "inventory_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "inventory_items_kind_idx" ON "inventory_items" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "stock_movements_item_id_idx" ON "stock_movements" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "stock_movements_at_idx" ON "stock_movements" USING btree ("at");