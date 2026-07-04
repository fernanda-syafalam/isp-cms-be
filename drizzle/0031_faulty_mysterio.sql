ALTER TABLE "customers" ADD COLUMN "reseller_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_reseller_id_resellers_id_fk" FOREIGN KEY ("reseller_id") REFERENCES "public"."resellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_reseller_id_idx" ON "customers" USING btree ("reseller_id");--> statement-breakpoint
-- Backfill the FK from the transitional display string. Duplicate reseller
-- names would make this ambiguous; the unique join below only fills rows
-- whose name matches exactly one reseller and leaves the rest for manual
-- reconciliation (expand-migrate; the string column contracts later).
UPDATE "customers" c SET "reseller_id" = r.id
FROM "resellers" r
WHERE c."reseller_name" = r."name"
  AND c."reseller_id" IS NULL
  AND (SELECT count(*) FROM "resellers" r2 WHERE r2."name" = c."reseller_name") = 1;
