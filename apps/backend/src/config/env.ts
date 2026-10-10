import { config as loadDotenv } from "dotenv";
import { z } from "zod";

// Load .env.local (preferred) then .env. Variables already set in the real
// environment always win.
loadDotenv({ path: ".env.local", quiet: true });
loadDotenv({ quiet: true });

/**
 * Environment validation — the server refuses to boot with a broken config.
 * Values are parsed, never logged.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Optional path to the Supabase CA certificate for full TLS verification.
  // Required in production for non-local databases.
  DATABASE_SSL_CA: z.string().optional(),
  CLERK_SECRET_KEY: z
    .string()
    .min(1, "CLERK_SECRET_KEY is required")
    .refine((v) => v.startsWith("sk_"), "CLERK_SECRET_KEY must start with sk_"),
  APPWRITE_ENDPOINT: z.string().url("APPWRITE_ENDPOINT must be a valid URL"),
  APPWRITE_PROJECT_ID: z.string().min(1, "APPWRITE_PROJECT_ID is required"),
  APPWRITE_API_KEY: z.string().min(1, "APPWRITE_API_KEY is required"),
  APPWRITE_BUCKET_ID: z.string().min(1, "APPWRITE_BUCKET_ID is required"),
  // Optional dedicated secret for signing public gallery access tokens.
  // When unset, one is derived from CLERK_SECRET_KEY (see gallery-tokens.ts).
  GALLERY_TOKEN_SECRET: z.string().min(16).optional(),
  // Optional Redis for BullMQ thumbnail jobs. Unset → the API processes
  // derivatives with the in-process sweep; the worker refuses to boot.
  REDIS_URL: z.string().url("REDIS_URL must be a valid URL").optional(),
  // Optional Kafka for analytics events (docker compose up kafka).
  // Unset → emission is a no-op and galleries serve normally.
  // KAFKA_BROKERS=localhost:9092
  KAFKA_BROKERS: z.string().min(1).max(500).optional(),
  // Override the analytics topic (default frameflow.analytics.v1).
  KAFKA_TOPIC_ANALYTICS: z.string().min(1).max(200).optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    // Only field names/messages go to stderr — never raw values.
    console.error(`Invalid environment configuration → ${missing}`);
    throw new Error("Environment validation failed");
  }
  cached = parsed.data;
  return cached;
}

/** Test helper: clears the cached env so a new one is parsed. */
export function resetEnvCache(): void {
  cached = null;
}
