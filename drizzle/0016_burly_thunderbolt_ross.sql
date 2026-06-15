CREATE TABLE "ppp_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"router_id" uuid NOT NULL,
	"name" varchar(60) NOT NULL,
	"rate_limit" varchar(40) NOT NULL,
	"is_isolir" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ppp_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"router_id" uuid NOT NULL,
	"username" varchar(60) NOT NULL,
	"profile_id" uuid NOT NULL,
	"profile_name" varchar(60) NOT NULL,
	"customer_id" uuid,
	"customer_name" varchar(120),
	"disabled" boolean DEFAULT false NOT NULL,
	"comment" varchar(160),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ppp_profiles" ADD CONSTRAINT "ppp_profiles_router_id_routers_id_fk" FOREIGN KEY ("router_id") REFERENCES "public"."routers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ppp_secrets" ADD CONSTRAINT "ppp_secrets_router_id_routers_id_fk" FOREIGN KEY ("router_id") REFERENCES "public"."routers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ppp_secrets" ADD CONSTRAINT "ppp_secrets_profile_id_ppp_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."ppp_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ppp_secrets" ADD CONSTRAINT "ppp_secrets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ppp_profiles_router_id_idx" ON "ppp_profiles" USING btree ("router_id");--> statement-breakpoint
CREATE INDEX "ppp_secrets_router_id_idx" ON "ppp_secrets" USING btree ("router_id");--> statement-breakpoint
CREATE INDEX "ppp_secrets_customer_id_idx" ON "ppp_secrets" USING btree ("customer_id");