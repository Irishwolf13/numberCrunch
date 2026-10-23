import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { isPlayableTarget, verifySolution } from "../public/game-rules.js";
import { ROUND_TTL_MS } from "./store.mjs";

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self' https://accounts.blackcatmatrix.com; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
};
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_CLOCK_SLACK_MS = 1500;

class AuthUnavailable extends Error {}

const json = (status, body, headers) => new Response(JSON.stringify(body), {
  status, headers: { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", ...headers },
});
const fail = (status, error, headers) => json(status, { error }, headers);

async function readObject(request) {
  try {
    const body = JSON.parse(await request.text());
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

export function createApp({ origin, getAuth, store, publicDir, vendorFiles = {}, buildId, now = Date.now, randomId = () => crypto.randomUUID() }) {
  const root = resolve(publicDir);
  const vendor = new Map(Object.entries(vendorFiles));

  async function account(request) {
    try {
      const auth = getAuth();
      return { accountUrl: auth.accountUrl, session: await auth.session(request) };
    } catch {
      throw new AuthUnavailable();
    }
  }

  async function me(request) {
    const { accountUrl, session } = await account(request);
    if (!session) return json(200, { user: null, accountUrl, records: {} });
    const { id, displayName, email } = session.user;
    const t = now();
    await store.ensurePlayer(id, displayName, t);
    if (email) await store.claimLegacy(email, id, t);
    return json(200, { user: { id, displayName }, accountUrl, records: await store.records(id) });
  }

  async function leaderboard(request, param) {
    const target = /^\d{1,3}$/.test(param) ? Number(param) : NaN;
    if (!isPlayableTarget(target)) return fail(400, "invalid_target");
    const session = await account(request).then((a) => a.session, () => null);
    const entries = (await store.leaderboard(target)).map(({ playerId, name, ms }) => ({ name, ms, you: !!session && playerId === session.user.id }));
    return json(200, { target, entries });
  }

  async function bests() {
    const all = await store.globalBests();
    return json(200, { bests: Object.fromEntries(Object.entries(all).map(([target, { name, ms }]) => [target, { name, ms }])) });
  }

  async function startRound(request) {
    const { session } = await account(request);
    if (!session) return fail(401, "authentication_required");
    const body = await readObject(request);
    if (!body) return fail(400, "invalid_request");
    if (!isPlayableTarget(body.target)) return fail(400, "invalid_target");
    const roundId = randomId();
    await store.startRound(roundId, session.user.id, body.target, now());
    return json(201, { roundId });
  }

  async function finishRound(request, id) {
    const t = now();
    const { session } = await account(request);
    if (!session) return fail(401, "authentication_required");
    if (!UUID.test(id)) return fail(404, "round_not_found");
    const body = await readObject(request);
    if (!body || !Number.isFinite(body.clientMs) || body.clientMs < 0) return fail(400, "invalid_request");
    const { user } = session;
    const round = await store.takeRound(id, user.id);
    const serverMs = round && t - round.startedAt;
    if (!round || serverMs > ROUND_TTL_MS) return fail(404, "round_not_found");
    if (!verifySolution(round.target, body.steps)) return fail(422, "invalid_solution");
    // The client's own timer wins inside a small window; the server clock bounds it on both sides.
    const recordedMs = Math.max(1, Math.max(serverMs - CLIENT_CLOCK_SLACK_MS, Math.min(Math.round(body.clientMs), serverMs)));
    await store.ensurePlayer(user.id, user.displayName, t);
    return json(200, { recordedMs, ...(await store.recordSolve(user.id, round.target, recordedMs, t)) });
  }

  const routes = [
    ["GET", /^\/api\/health$/, () => json(200, { ok: true, build: buildId })],
    ["GET", /^\/api\/me$/, me],
    ["GET", /^\/api\/leaderboard\/([^/]*)$/, leaderboard],
    ["GET", /^\/api\/bests$/, bests],
    ["POST", /^\/api\/rounds$/, startRound],
    ["POST", /^\/api\/rounds\/([^/]*)\/finish$/, finishRound],
  ];

  async function api(request, pathname) {
    for (const [method, pattern, handler] of routes) {
      const match = pattern.exec(pathname);
      if (!match) continue;
      if (request.method !== method) return fail(405, "method_not_allowed", { allow: method });
      return await handler(request, match[1]);
    }
    return fail(404, "not_found");
  }

  // Decoded path segments only; no dotfiles, and the result must stay inside publicDir.
  function publicFile(pathname) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return null; }
    const parts = decoded.split(/[\\/]/);
    if (decoded.includes("\0") || parts.some((part) => part.startsWith("."))) return null;
    const file = join(root, ...parts);
    return file.startsWith(root + sep) ? file : null;
  }

  const fileResponse = (request, status, body, type) => new Response(request.method === "HEAD" ? null : body, {
    status, headers: { ...SECURITY_HEADERS, "content-type": type, "cache-control": "no-cache" },
  });

  async function serveStatic(request, pathname) {
    const file = pathname === "/" || pathname === "/login" ? join(root, "index.html") : vendor.get(pathname) ?? publicFile(pathname);
    const type = file && TYPES[extname(file).toLowerCase()];
    const body = type && await readFile(file).catch(() => null);
    if (body) return fileResponse(request, 200, body, type);
    return fileResponse(request, 404, await readFile(join(root, "404.html")).catch(() => "Not found"), TYPES[".html"]);
  }

  return async function app(request) {
    const { pathname } = new URL(request.url);
    const read = request.method === "GET" || request.method === "HEAD";
    const backchannel = request.method === "POST" && pathname === "/api/auth/backchannel-logout";
    if (!read && !backchannel && request.headers.get("origin") !== origin) return fail(403, "forbidden");
    try {
      if (pathname.startsWith("/api/auth/")) {
        try {
          return (await getAuth().handle(request)) ?? fail(404, "not_found");
        } catch {
          return fail(503, "authentication_unavailable");
        }
      }
      if (pathname.startsWith("/api/")) return await api(request, pathname);
      if (!read) return fail(405, "method_not_allowed", { allow: "GET, HEAD" });
      return await serveStatic(request, pathname);
    } catch (error) {
      if (error instanceof AuthUnavailable) return fail(503, "authentication_unavailable");
      console.error("Number Crunch request failed");
      return fail(500, "internal_error");
    }
  };
}
