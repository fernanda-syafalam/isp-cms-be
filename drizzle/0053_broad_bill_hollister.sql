CREATE INDEX "customers_email_idx" ON "customers" USING btree ("email") WHERE "customers"."email" is not null;--> statement-breakpoint
CREATE INDEX "invoices_due_date_idx" ON "invoices" USING btree ("due_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_paid_at_idx" ON "payments" USING btree ("paid_at");