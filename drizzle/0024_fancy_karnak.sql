CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"actor" varchar(200) NOT NULL,
	"action" varchar(120) NOT NULL,
	"entity" varchar(120) NOT NULL,
	"summary" varchar(500) NOT NULL,
	"entity_id" varchar(120)
);
--> statement-breakpoint
CREATE INDEX "audit_log_entity_id_idx" ON "audit_log" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");