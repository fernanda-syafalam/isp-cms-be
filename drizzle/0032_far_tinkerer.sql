CREATE TYPE "public"."customer_hold_reason" AS ENUM('overdue', 'voluntary');--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "hold_reason" "customer_hold_reason";