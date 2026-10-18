import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadEnv, resetEnvCache, type Env } from "../src/config/env.js";
import { kafkaBrokersOf, kafkaConfigFor } from "../src/lib/kafka-client.js";

/**
 * Managed-broker configuration (Aiven): plaintext locally, SASL over TLS
 * when the credential pair is present, CA accepted inline or as a path.
 * These tests never touch a broker — they pin the options we hand kafkajs.
 */

const CA_PEM = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----";

const KAFKA_VARS = [
  "KAFKA_BROKERS",
  "KAFKA_TOPIC_ANALYTICS",
  "KAFKA_SASL_USERNAME",
  "KAFKA_SASL_PASSWORD",
  "KAFKA_SASL_MECHANISM",
  "KAFKA_SSL_CA",
] as const;

// .env.local may define Kafka vars for real Aiven use; tests must not inherit
// them, so every case starts from a cleared Kafka environment.
function resetEnv(): void {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  process.env.CLERK_SECRET_KEY = "sk_test_placeholder";
  process.env.APPWRITE_ENDPOINT = "https://cloud.appwrite.io/v1";
  process.env.APPWRITE_PROJECT_ID = "test-project";
  process.env.APPWRITE_API_KEY = "test-key";
  process.env.APPWRITE_BUCKET_ID = "test-bucket";
  for (const name of KAFKA_VARS) delete process.env[name];
  resetEnvCache();
}

function env(): Env {
  return loadEnv();
}

describe("kafkaConfigFor", () => {
  let caDir: string;

  beforeEach(() => {
    resetEnv();
    caDir = mkdtempSync(join(tmpdir(), "kafka-ca-"));
  });

  afterEach(() => {
    rmSync(caDir, { recursive: true, force: true });
  });

  it("stays plaintext without SASL credentials (local compose)", () => {
    process.env.KAFKA_BROKERS = "localhost:9092";
    const config = kafkaConfigFor(env(), "frameflow-api");
    expect(config).toEqual({ clientId: "frameflow-api", brokers: ["localhost:9092"] });
    expect(config.ssl).toBeUndefined();
    expect(config.sasl).toBeUndefined();
  });

  it("splits and trims comma-separated brokers", () => {
    process.env.KAFKA_BROKERS = "a:9092, b:9092 ,";
    expect(kafkaBrokersOf(env())).toEqual(["a:9092", "b:9092"]);
  });

  it("enables TLS and defaults to scram-sha-256 when credentials are set", () => {
    process.env.KAFKA_BROKERS = "broker.example:20915";
    process.env.KAFKA_SASL_USERNAME = "avnadmin";
    process.env.KAFKA_SASL_PASSWORD = "s3cret";
    const config = kafkaConfigFor(env(), "frameflow-api");
    expect(config.ssl).toBe(true);
    expect(config.sasl).toEqual({
      mechanism: "scram-sha-256",
      username: "avnadmin",
      password: "s3cret",
    });
  });

  it("honors an explicit mechanism", () => {
    process.env.KAFKA_BROKERS = "broker.example:20915";
    process.env.KAFKA_SASL_USERNAME = "avnadmin";
    process.env.KAFKA_SASL_PASSWORD = "s3cret";
    process.env.KAFKA_SASL_MECHANISM = "scram-sha-512";
    const config = kafkaConfigFor(env(), "frameflow-analytics-consumer");
    expect(config.sasl).toMatchObject({ mechanism: "scram-sha-512" });
  });

  it("verifies the full TLS chain with an inline CA PEM", () => {
    process.env.KAFKA_BROKERS = "broker.example:20915";
    process.env.KAFKA_SASL_USERNAME = "avnadmin";
    process.env.KAFKA_SASL_PASSWORD = "s3cret";
    process.env.KAFKA_SSL_CA = CA_PEM;
    const config = kafkaConfigFor(env(), "frameflow-api");
    expect(config.ssl).toEqual({ ca: [CA_PEM], rejectUnauthorized: true });
  });

  it("reads the CA from a file path", () => {
    const caPath = join(caDir, "ca.pem");
    writeFileSync(caPath, CA_PEM);
    process.env.KAFKA_BROKERS = "broker.example:20915";
    process.env.KAFKA_SASL_USERNAME = "avnadmin";
    process.env.KAFKA_SASL_PASSWORD = "s3cret";
    process.env.KAFKA_SSL_CA = caPath;
    const config = kafkaConfigFor(env(), "frameflow-api");
    expect(config.ssl).toEqual({ ca: [CA_PEM], rejectUnauthorized: true });
  });

  it("fails loudly when the CA path does not exist", () => {
    process.env.KAFKA_BROKERS = "broker.example:20915";
    process.env.KAFKA_SSL_CA = join(caDir, "missing.pem");
    expect(() => kafkaConfigFor(env(), "frameflow-api")).toThrow(/KAFKA_SSL_CA/);
  });
});

describe("Kafka SASL env validation", () => {
  beforeEach(() => {
    resetEnv();
  });

  it("rejects a credential pair that is only half set", () => {
    process.env.KAFKA_SASL_USERNAME = "avnadmin";
    expect(() => loadEnv()).toThrow("Environment validation failed");
    resetEnv();
    process.env.KAFKA_SASL_PASSWORD = "s3cret";
    expect(() => loadEnv()).toThrow("Environment validation failed");
  });

  it("rejects a mechanism without credentials", () => {
    process.env.KAFKA_SASL_MECHANISM = "scram-sha-512";
    expect(() => loadEnv()).toThrow("Environment validation failed");
  });
});
