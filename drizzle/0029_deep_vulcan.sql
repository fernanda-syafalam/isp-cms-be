ALTER TYPE "public"."user_role" ADD VALUE 'teknisi';--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'mitra';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reseller_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_reseller_id_resellers_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;