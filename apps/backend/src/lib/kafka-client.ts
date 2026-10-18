import { readFileSync } from "node:fs";

import type { KafkaConfig } from "kafkajs";

import type { Env } from "../config/env.js";

// ---------------------------------------------------------------------------
// Shared Kafka client configuration.
//
// Local compose is PLAINTEXT: with no SASL credentials and no CA the options
// stay bare. Managed brokers (Aiven, Confluent, …) speak SASL over TLS:
// setting the credential pair turns TLS on and attaches the mechanism
// (default scram-sha-256, Aiven's default). KAFKA_SSL_CA enables full chain
// verification and accepts an inline PEM bundle (Render env var) or a file
// path (mirrors DATABASE_SSL_CA in db.ts).
// ---------------------------------------------------------------------------

export function kafkaBrokersOf(env: Env): string[] {
  return (env.KAFKA_BROKERS ?? "")
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);
}

function resolveCa(env: Env): string | null {
  const value = env.KAFKA_SSL_CA;
  if (!value) return null;
  if (value.includes("-----BEGIN CERTIFICATE-----")) return value;
  try {
    return readFileSync(value, "utf8");
  } catch {
    throw new Error(`KAFKA_SSL_CA file not found: ${value}`);
  }
}

/** Kafka client options derived from the environment (brokers + TLS/SASL). */
export function kafkaConfigFor(env: Env, clientId: string): KafkaConfig {
  const config: KafkaConfig = {
    clientId,
    brokers: kafkaBrokersOf(env),
  };
  const ca = resolveCa(env);
  const username = env.KAFKA_SASL_USERNAME;
  const password = env.KAFKA_SASL_PASSWORD;
  if (ca || (username && password)) {
    config.ssl = ca ? { ca: [ca], rejectUnauthorized: true } : true;
  }
  if (username && password) {
    // Narrow each branch so the object matches kafkajs's discriminated
    // union (the mechanism field must be a literal, not the enum union).
    const mechanism = env.KAFKA_SASL_MECHANISM ?? "scram-sha-256";
    if (mechanism === "plain") {
      config.sasl = { mechanism: "plain", username, password };
    } else if (mechanism === "scram-sha-512") {
      config.sasl = { mechanism: "scram-sha-512", username, password };
    } else {
      config.sasl = { mechanism: "scram-sha-256", username, password };
    }
  }
  return config;
}
