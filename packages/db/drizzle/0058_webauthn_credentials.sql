CREATE TABLE "webauthn_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" "bytea" NOT NULL,
	"public_key" "bytea" NOT NULL,
	"algorithm" integer NOT NULL,
	"sign_count" bigint DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT '{}' NOT NULL,
	"aaguid" uuid,
	"discoverable" boolean,
	"backup_eligible" boolean NOT NULL,
	"backed_up" boolean NOT NULL,
	"name" varchar(80) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "webauthn_credential_id_key" UNIQUE("credential_id"),
	CONSTRAINT "webauthn_credential_id_length_check" CHECK (octet_length("webauthn_credentials"."credential_id") BETWEEN 1 AND 1023),
	CONSTRAINT "webauthn_algorithm_check" CHECK ("webauthn_credentials"."algorithm" IN (-8, -7, -257))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "webauthn_user_handle" "bytea";--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webauthn_credentials_user_idx" ON "webauthn_credentials" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_webauthn_user_handle_key" UNIQUE("webauthn_user_handle");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_webauthn_user_handle_length_check" CHECK (octet_length("users"."webauthn_user_handle") = 32);