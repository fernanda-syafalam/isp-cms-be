ALTER TABLE "work_orders" ADD COLUMN "scanned_onu_serial" varchar(64);--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "measured_rx_power" real;--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "photos" jsonb;--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "signature_url" varchar(512);--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "gps_lat" real;--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "gps_lng" real;--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "completed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "completed_by" varchar(120);