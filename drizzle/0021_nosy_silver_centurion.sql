CREATE TABLE "ip_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"router_id" uuid NOT NULL,
	"name" varchar(60) NOT NULL,
	"ranges" varchar(120) NOT NULL,
	"total_addresses" integer DEFAULT 0 NOT NULL,
	"used_addresses" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "simple_queues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"router_id" uuid NOT NULL,
	"name" varchar(60) NOT NULL,
	"target" varchar(60) NOT NULL,
	"max_limit" varchar(40) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ip_pools" ADD CONSTRAINT "ip_pools_router_id_routers_id_fk" FOREIGN KEY ("router_id") REFERENCES "public"."routers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simple_queues" ADD CONSTRAINT "simple_queues_router_id_routers_id_fk" FOREIGN KEY ("router_id") REFERENCES "public"."routers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ip_pools_router_id_idx" ON "ip_pools" USING btree ("router_id");--> statement-breakpoint
CREATE INDEX "simple_queues_router_id_idx" ON "simple_queues" USING btree ("router_id");