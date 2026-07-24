-- DB-4: money-adjacent rate columns were `real` (float4, single-precision,
-- ~7 significant digits) — an off-by-one-rupiah risk at boundary rounding
-- once multiplied into an invoice/commission amount. Switch both to
-- `numeric(6, 5)`, which is exact (base-10, no binary-float truncation) and
-- has ample range for a 0..1 fraction (up to 9.99999).
--
-- Lock/duration: both tables are tiny — `app_settings` is a singleton (at
-- most 1 row) and `resellers` holds a handful of rows — so this is an
-- instant, full-table ACCESS EXCLUSIVE rewrite with negligible duration.
-- Not a candidate for expand-contract; no CONCURRENTLY concern applies to
-- ALTER COLUMN TYPE.
--
-- Rollback (not reversible losslessly if a value like 0.05500 was written
-- post-migration and real can't represent it exactly, but recovers the
-- column type):
--   ALTER TABLE "resellers" ALTER COLUMN "commission_pct" SET DATA TYPE real USING "commission_pct"::real;
--   ALTER TABLE "app_settings" ALTER COLUMN "tax_ppn_rate" SET DATA TYPE real USING "tax_ppn_rate"::real;
ALTER TABLE "resellers" ALTER COLUMN "commission_pct" SET DATA TYPE numeric(6, 5) USING "commission_pct"::numeric(6, 5);--> statement-breakpoint
ALTER TABLE "app_settings" ALTER COLUMN "tax_ppn_rate" SET DATA TYPE numeric(6, 5) USING "tax_ppn_rate"::numeric(6, 5);