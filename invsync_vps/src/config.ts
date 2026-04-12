import path from "node:path";

function parsePort(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "3000", 10);
  return Number.isFinite(parsed) ? parsed : 3000;
}

export const serverConfig = {
  host: process.env.INVSYNC_BIND_HOST ?? "127.0.0.1",
  port: parsePort(process.env.PORT),
  dataDir: process.env.INVSYNC_DATA_DIR ?? path.resolve(process.cwd(), "data"),
  apiToken: process.env.INVSYNC_API_TOKEN ?? "",
  jsonBodyLimit: "1mb",
};

export function assertServerConfig(): void {
  if (!serverConfig.apiToken) {
    throw new Error("INVSYNC_API_TOKEN is required.");
  }
}
