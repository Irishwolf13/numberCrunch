import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createAuth } from "@blackcat/auth";
import { createPostgresAuthStore } from "@blackcat/auth/postgres";
import { createApp } from "./app.mjs";
import { nodeListener } from "./node-http.mjs";
import { createStore } from "./store.mjs";

// Secrets are injected by Compose or loaded explicitly from a protected external file.
if (process.env.APP_ENV_FILE) process.loadEnvFile(process.env.APP_ENV_FILE);
const env = process.env;
const port = Number.parseInt(env.PORT || (env.NODE_ENV === "production" ? "3000" : "3110"), 10);
const origin = env.APP_ORIGIN || `http://localhost:${port}`;

function required(name) {
  if (!env[name]) throw new Error("Account configuration is incomplete");
  return env[name];
}

let pool;
function getPool() {
  if (pool) return pool;
  pool = new pg.Pool({ connectionString: required("DATABASE_URL"), max: 10, connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000 });
  pool.on("error", () => console.error("Number Crunch database unavailable"));
  return pool;
}

let auth;
function getAuth() {
  if (auth) return auth;
  const config = {
    origin: required("APP_ORIGIN"), issuer: required("OIDC_ISSUER"), clientId: required("OIDC_CLIENT_ID"),
    clientSecret: required("OIDC_CLIENT_SECRET"), encryptionKey: required("AUTH_ENCRYPTION_KEY"),
  };
  auth = createAuth({ ...config, allowHttpLocalhost: env.AUTH_ALLOW_HTTP_LOCALHOST === "true", store: createPostgresAuthStore(getPool()) });
  return auth;
}

function readBuildId() {
  try {
    return readFileSync(new URL("../.build-id", import.meta.url), "utf8").trim() || "dev";
  } catch {
    return "dev";
  }
}

// The pool is created on first query, so a missing DATABASE_URL fails requests instead of startup.
const store = createStore({ query: (text, params) => getPool().query(text, params) });
const app = createApp({
  origin, getAuth, store, buildId: readBuildId(),
  publicDir: fileURLToPath(new URL("../public/", import.meta.url)),
  vendorFiles: { "/vendor/bcm-auth-browser.js": fileURLToPath(import.meta.resolve("@blackcat/auth/browser")) },
});

const server = createServer(nodeListener(app, origin));
server.listen(port, "0.0.0.0", () => console.log(`Number Crunch listening on port ${port}`));

setInterval(() => {
  store.purgeExpired(Date.now()).catch(() => console.error("Number Crunch cleanup failed"));
}, 3_600_000).unref();

const shutdown = () => server.close(() => pool?.end().catch(() => {}));
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
