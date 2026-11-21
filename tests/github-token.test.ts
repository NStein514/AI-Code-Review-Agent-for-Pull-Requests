import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tokenClient } from "../src/github/app.js";

let server: Server;
let baseUrl: string;
let authorization: string | undefined;

beforeAll(async () => {
  server = createServer((request, response) => {
    authorization = request.headers.authorization;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ login: "review-bot" }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  authorization = undefined;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("tokenClient", () => {
  it("authenticates requests with the supplied token", async () => {
    const client = tokenClient("test-token", { baseUrl });
    const response = await client.request("GET /user");

    expect(response.data).toEqual({ login: "review-bot" });
    expect(authorization).toMatch(/^(token|Bearer) test-token$/);
  });

  it("rejects a blank token", () => {
    expect(() => tokenClient("   ")).toThrow(/token is required/);
  });
});
