// Dev-only UI preview: an in-memory database and a fake account service. Never deploy this.
// Usage: node scripts/preview.mjs [--as "Display Name"] [--port 3119]
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createApp } from "../server/app.mjs";
import { nodeListener } from "../server/node-http.mjs";
import { createStore } from "../server/store.mjs";
import { freshDb } from "../test/helpers/db.mjs";

const { values } = parseArgs({ options: { as: { type: "string" }, port: { type: "string", default: "3119" } } });
const port = Number(values.port);
const origin = `http://localhost:${port}`;
const accountUrl = "https://accounts.blackcatmatrix.com/realms/blackcatmatrix/account/";

const store = createStore(await freshDb());
const seed = [
  ["preview:ada", "Ada", { 7: 5100, 12: 8400, 24: 15200, 50: 31000 }],
  ["preview:hostile", "<img src=x onerror=alert(1)>", { 12: 9100, 24: 14100 }],
  ["preview:kit", "Kit", { 12: 12800, 100: 42000 }],
];
for (const [id, name, times] of seed) {
  await store.ensurePlayer(id, name, Date.now());
  for (const [target, ms] of Object.entries(times)) await store.recordSolve(id, Number(target), ms, Date.now());
}

const user = values.as ? { id: "preview:you", displayName: values.as, email: null, roles: [] } : null;
const session = user && { user, sid: "preview", expiresAt: Date.now() + 86_400_000, reference: "preview" };
const auth = {
  accountUrl,
  async session() { return session; },
  async handle(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/auth/login" || pathname === "/api/auth/logout") return new Response(null, { status: 303, headers: { location: "/" } });
    if (pathname === "/api/auth/session") return Response.json({ user: user && { id: user.id, displayName: user.displayName, roles: user.roles }, accountUrl });
    return null;
  },
};

const app = createApp({
  origin, getAuth: () => auth, store, buildId: "preview",
  publicDir: fileURLToPath(new URL("../public/", import.meta.url)),
  vendorFiles: { "/vendor/bcm-auth-browser.js": fileURLToPath(import.meta.resolve("@blackcat/auth/browser")) },
});
createServer(nodeListener(app, origin)).listen(port, "localhost", () => {
  console.log(`Number Crunch preview (${user ? `signed in as ${user.displayName}` : "guest"}): ${origin}/`);
});
