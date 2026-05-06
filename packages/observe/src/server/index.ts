// W6 — @sivru/observe HTTP server factory.
// See DESIGN.md §5 (observe architecture) and §5.5 (privacy boundary).
//
// PRIVACY NOTE (DESIGN.md §5.5): this is the inbound listener. We bind to
// 127.0.0.1 by default — never 0.0.0.0 — so the daemon is unreachable from
// other hosts on the LAN. The egress test allows `node:http` only under
// `src/server/` because @hono/node-server uses it internally to listen.

import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";

import { createObserveApp } from "./app.js";
import type { ObserveAppOptions } from "./app.js";

export { createObserveApp } from "./app.js";
export type { ObserveAppOptions } from "./app.js";

export type ObserveServerOptions = ObserveAppOptions & {
  /** Listen port. Default 0 (let the OS pick). */
  port?: number;
  /** Listen host. Default "127.0.0.1" — localhost-only is the privacy default. */
  host?: string;
};

export type ObserveServer = {
  /** Resolved port the server is listening on. */
  readonly port: number;
  /** Resolved host. */
  readonly host: string;
  /** "http://<host>:<port>" — convenient for the CLI to print. */
  readonly url: string;
  /** Stop accepting connections; resolves once the listener has closed. */
  close(): Promise<void>;
};

/** Boot the Hono app on the configured host:port. Returns once the server is listening. */
export async function createObserveServer(
  options?: ObserveServerOptions,
): Promise<ObserveServer> {
  const host = options?.host ?? "127.0.0.1";
  const requestedPort = options?.port ?? 0;

  const appOptions: ObserveAppOptions = {};
  if (options?.source !== undefined) appOptions.source = options.source;
  if (options?.jsonlOptions !== undefined)
    appOptions.jsonlOptions = options.jsonlOptions;
  if (options?.uiDistDir !== undefined) appOptions.uiDistDir = options.uiDistDir;

  const app = createObserveApp(appOptions);

  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    let s: ReturnType<typeof serve> | undefined;
    try {
      s = serve(
        {
          fetch: app.fetch,
          hostname: host,
          port: requestedPort,
        },
        () => {
          if (s !== undefined) resolve(s);
        },
      );
      s.on("error", (err) => reject(err));
    } catch (err) {
      reject(err);
    }
  });

  const address = server.address();
  const boundPort = resolvePort(address, requestedPort);

  return {
    port: boundPort,
    host,
    url: `http://${host}:${boundPort}`,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

function resolvePort(address: string | AddressInfo | null, fallback: number): number {
  if (address !== null && typeof address === "object") {
    return address.port;
  }
  return fallback;
}
