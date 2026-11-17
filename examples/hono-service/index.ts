import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { Surreal } from "surrealdb";

export interface SurrealLike {
  connect(url: string): Promise<unknown>;
  signin(vars: { username: string; password: string }): Promise<unknown>;
  use(opts: { namespace: string; database: string }): Promise<unknown>;
  create(thing: string, data?: Record<string, unknown>): Promise<unknown>;
  select(thing: string): Promise<unknown>;
}

export function createApp(customDb?: SurrealLike) {
  const app = new Hono();
  const db: SurrealLike = customDb ?? (new Surreal() as unknown as SurrealLike);
  let connectedPromise: Promise<void> | null = null;

  async function ensureConnected() {
    if (!connectedPromise) {
      connectedPromise = (async () => {
        const url = process.env.SURREALDB_URL ?? "http://127.0.0.1:8000/rpc";
        const username = process.env.SURREALDB_USER ?? "root";
        const password = process.env.SURREALDB_PASS ?? "surrealdb-root-pass";
        const namespace = process.env.SURREALDB_NS ?? "app";
        const database = process.env.SURREALDB_DB ?? "main";
        await db.connect(url);
        await db.signin({ username, password });
        await db.use({ namespace, database });
      })().catch((err) => {
        connectedPromise = null;
        throw err;
      });
    }
    return connectedPromise;
  }

  app.get("/health", async (c) => {
    try {
      await ensureConnected();
      return c.json({ status: "ok", backend: "surrealdb-tikv" });
    } catch (error) {
      return c.json({ status: "degraded", error: String(error) }, 503);
    }
  });

  app.post("/users", async (c) => {
    try {
      await ensureConnected();
      const body = await c.req.json();
      const created = await db.create("user", body);
      return c.json(created, 201);
    } catch (error) {
      return c.json({ error: "Failed to create user", detail: String(error) }, 500);
    }
  });

  app.get("/users", async (c) => {
    try {
      await ensureConnected();
      const users = await db.select("user");
      return c.json(users);
    } catch (error) {
      return c.json({ error: "Failed to fetch users", detail: String(error) }, 500);
    }
  });

  return app;
}

export const app = createApp();
export const handler = handle(app);
export default app;
