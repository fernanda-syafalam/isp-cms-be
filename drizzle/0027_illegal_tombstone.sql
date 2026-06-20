ALTER TABLE "stock_movements" ADD COLUMN "work_order_id" uuid;--> statement-breakpoint
CREATE INDEX "stock_movements_work_order_id_idx" ON "stock_movements" USING btree ("work_order_id");