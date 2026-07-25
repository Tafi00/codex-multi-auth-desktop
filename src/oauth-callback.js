import http from "node:http";

export function startOAuthCallbackServer(state, { port = 1455 } = {}) {
  let code = null;
  let closeTask = null;
  let finishWait;
  const waitTask = new Promise((resolve) => { finishWait = resolve; });
  const timeout = setTimeout(() => finishWait(null), 5 * 60_000);
  const server = http.createServer((request, response) => {
    const address = server.address();
    const activePort = typeof address === "object" && address ? address.port : port;
    const url = new URL(request.url || "/", `http://localhost:${activePort}`);
    if (url.pathname !== "/auth/callback" || url.searchParams.get("state") !== state || !url.searchParams.get("code")) {
      response.writeHead(400, { "Content-Type": "text/plain", Connection: "close" });
      response.end("Invalid OAuth callback.");
      return;
    }
    if (code) {
      response.writeHead(409, { "Content-Type": "text/plain", Connection: "close" });
      response.end("OAuth callback was already completed.");
      return;
    }
    code = url.searchParams.get("code");
    clearTimeout(timeout);
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
    response.end("<h2>Login complete</h2><p>You may close this browser tab.</p>");
    finishWait(code);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : port,
        close: () => {
          if (closeTask) return closeTask;
          clearTimeout(timeout);
          finishWait(null);
          closeTask = new Promise((finish) => {
            if (!server.listening) {
              finish();
              return;
            }
            server.close(() => finish());
            server.closeIdleConnections?.();
          });
          return closeTask;
        },
        wait: () => waitTask,
      });
    });
  });
}
