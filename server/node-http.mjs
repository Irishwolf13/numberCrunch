const MAX_BODY_BYTES = 16_384;

const tooLarge = (res) => res.writeHead(413, { connection: "close" }).end();

// Adapts a Web API app to node:http. URLs use the configured public origin, never the Host header.
export function nodeListener(app, origin) {
  return async (req, res) => {
    try {
      const path = req.url ?? "/";
      const url = new URL(path, origin);
      if (!path.startsWith("/") || url.origin !== origin) return res.writeHead(400).end();
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      let body;
      if (req.method === "POST") {
        if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) return tooLarge(res);
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > MAX_BODY_BYTES) return tooLarge(res);
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
      }
      const response = await app(new Request(url, { method: req.method, headers, body }));
      res.statusCode = response.status;
      response.headers.forEach((value, name) => { if (name !== "set-cookie") res.setHeader(name, value); });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader("set-cookie", cookies);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      console.error("Number Crunch request failed");
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  };
}
