CREATE TYPE "public"."ticket_category" AS ENUM('koneksi_putus', 'lambat', 'tagihan', 'perangkat', 'lainnya');--> statement-breakpoint
ALTER TYPE "public"."ticket_event_kind" ADD VALUE 'csat';--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "category" "ticket_category";--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "photo_url" varchar(500);--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "csat_rating" integer;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "csat_comment" varchar(500);--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "csat_at" timestamp (3) with time zone;