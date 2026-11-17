/// <reference path="./.sst/platform/config.d.ts" />

import { setupSurrealdb } from "./surrealdb";

export default $config({
  app(input) {
    return {
      name: "sst-eks-surrealdb",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
      providers: {
        aws: { region: process.env.AWS_REGION ?? "us-east-1" },
        eks: "3.8.0",
        kubernetes: "4.22.0",
      },
    };
  },
  async run() {
    const vpc = new sst.aws.Vpc("SurrealVpc", { nat: "managed" });
    const surreal = await setupSurrealdb(vpc);

    const api = new sst.aws.Function("HonoService", {
      handler: "examples/hono-service/index.handler",
      url: true,
      vpc,
      environment: {
        SURREALDB_URL: process.env.SURREALDB_URL ?? surreal.surrealUrl,
        SURREALDB_USER: process.env.SURREALDB_USER ?? surreal.rootUser,
        SURREALDB_PASS: process.env.SURREALDB_PASS ?? "surrealdb-root-pass",
        SURREALDB_NS: process.env.SURREALDB_NS ?? "app",
        SURREALDB_DB: process.env.SURREALDB_DB ?? "main",
      },
    });

    return {
      surrealUrl: surreal.surrealUrl,
      honoServiceUrl: api.url,
    };
  },
});
