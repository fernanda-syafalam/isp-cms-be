CREATE TYPE "public"."odp_status" AS ENUM('healthy', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."cable_kind" AS ENUM('feeder', 'distribution', 'drop');--> statement-breakpoint
CREATE TYPE "public"."cable_status" AS ENUM('planned', 'installed', 'retired');--> statement-breakpoint
CREATE TYPE "public"."circuit_status" AS ENUM('active', 'planned', 'down');--> statement-breakpoint
CREATE TYPE "public"."closure_type" AS ENUM('odc', 'odp', 'joint', 'inline');--> statement-breakpoint
CREATE TYPE "public"."node_status" AS ENUM('up', 'down', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."node_type" AS ENUM('olt', 'odc', 'odp', 'pole', 'customer');--> statement-breakpoint
CREATE TYPE "public"."splice_type" AS ENUM('fusion', 'mechanical', 'passthrough');--> statement-breakpoint
CREATE TYPE "public"."splitter_ratio" AS ENUM('1:2', '1:4', '1:8', '1:16', '1:32', '1:64');--> statement-breakpoint
CREATE TYPE "public"."strand_status" AS ENUM('allocated', 'reserved', 'dead');--> statement-breakpoint
CREATE TABLE "odp_records" (
	"id" varchar(60) PRIMARY KEY NOT NULL,
	"name" varchar(80) NOT NULL,
	"area" varchar(120) NOT NULL,
	"splitter" varchar(16) NOT NULL,
	"total_ports" integer NOT NULL,
	"used_ports" integer NOT NULL,
	"avg_rx_power_dbm" double precision NOT NULL,
	"status" "odp_status" NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "odp_records_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "cables" (
	"id" varchar(120) PRIMARY KEY NOT NULL,
	"kind" "cable_kind" NOT NULL,
	"spec" varchar(120) NOT NULL,
	"fiber_count" integer NOT NULL,
	"tube_count" integer NOT NULL,
	"from_node_id" varchar(120) NOT NULL,
	"to_node_id" varchar(120) NOT NULL,
	"route" jsonb NOT NULL,
	"length_m" double precision NOT NULL,
	"status" "cable_status" NOT NULL,
	"installed_at" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "circuits" (
	"id" varchar(120) PRIMARY KEY NOT NULL,
	"customer_id" varchar(120) NOT NULL,
	"customer_node_id" varchar(120) NOT NULL,
	"olt_node_id" varchar(120) NOT NULL,
	"olt_pon_port" varchar(40) NOT NULL,
	"onu_serial" varchar(120),
	"status" "circuit_status" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "closures" (
	"id" varchar(120) PRIMARY KEY NOT NULL,
	"type" "closure_type" NOT NULL,
	"node_id" varchar(120) NOT NULL,
	"tray_capacity" integer NOT NULL,
	"fiber_capacity" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "network_nodes" (
	"id" varchar(120) PRIMARY KEY NOT NULL,
	"name" varchar(160) NOT NULL,
	"type" "node_type" NOT NULL,
	"status" "node_status" NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"parent_id" varchar(120),
	"meta" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "splices" (
	"id" varchar(120) PRIMARY KEY NOT NULL,
	"closure_id" varchar(120) NOT NULL,
	"in_cable_id" varchar(120) NOT NULL,
	"in_tube_no" integer NOT NULL,
	"in_core_no" integer NOT NULL,
	"out_cable_id" varchar(120) NOT NULL,
	"out_tube_no" integer NOT NULL,
	"out_core_no" integer NOT NULL,
	"type" "splice_type" NOT NULL,
	"loss_db" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "splitters" (
	"id" varchar(120) PRIMARY KEY NOT NULL,
	"node_id" varchar(120) NOT NULL,
	"ratio" "splitter_ratio" NOT NULL,
	"in_cable_id" varchar(120),
	"in_strand_id" varchar(120),
	"ports" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "strands" (
	"id" varchar(120) PRIMARY KEY NOT NULL,
	"cable_id" varchar(120) NOT NULL,
	"tube_no" integer NOT NULL,
	"core_no" integer NOT NULL,
	"status" "strand_status" NOT NULL,
	"circuit_id" varchar(120),
	"customer_id" varchar(120)
);
