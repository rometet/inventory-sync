import path from "node:path";

export interface LocalWorldDbSourceConfig {
  serverId: string;
  kind: "local";
  dbPath: string;
  headerUuid: string;
}

export interface FtpWorldDbSourceConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  secure: boolean;
}

export interface FtpWorldDbSourceConfig {
  serverId: string;
  kind: "ftp";
  dbPath: string;
  headerUuid: string;
  ftp: FtpWorldDbSourceConnectionConfig;
}

export interface SshWorldDbSourceConnectionConfig {
  host: string;
  port: number;
  user: string;
  keyPath: string;
}

export interface SshWorldDbSourceConfig {
  serverId: string;
  kind: "ssh";
  dbPath: string;
  headerUuid: string;
  ssh: SshWorldDbSourceConnectionConfig;
}

export type WorldDbSourceConfig = LocalWorldDbSourceConfig | FtpWorldDbSourceConfig | SshWorldDbSourceConfig;

function parsePort(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "3000", 10);
  return Number.isFinite(parsed) ? parsed : 3000;
}

function parseBoolean(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function normalizeServerId(value: string): string {
  return value.trim().toLowerCase();
}

function parseWorldDbSources(env: NodeJS.ProcessEnv): Record<string, WorldDbSourceConfig> {
  const drafts = new Map<string, {
    serverId: string;
    kind: "local" | "ftp" | "ssh";
    dbPath: string;
    headerUuid: string;
    ftpHost: string;
    ftpPort: number;
    ftpUser: string;
    ftpPassword: string;
    ftpSecure: boolean;
    sshHost: string;
    sshPort: number;
    sshUser: string;
    sshKeyPath: string;
  }>();
  const pattern = /^INVSYNC_WORLD_SOURCE_([A-Z0-9_]+)_(TYPE|DB_PATH|HEADER_UUID|FTP_HOST|FTP_PORT|FTP_USER|FTP_PASSWORD|FTP_SECURE|SSH_HOST|SSH_PORT|SSH_USER|SSH_KEY_PATH)$/i;

  for (const [key, rawValue] of Object.entries(env)) {
    const match = pattern.exec(key);
    if (!match) {
      continue;
    }

    const serverId = normalizeServerId(match[1].replace(/__+/g, "_"));
    if (!serverId) {
      continue;
    }

    const source = drafts.get(serverId) ?? {
      serverId,
      kind: "local" as const,
      dbPath: "",
      headerUuid: env.INVSYNC_DEFAULT_HEADER_UUID ?? "b17755d2-3cc0-424b-89dd-558fc98513f5",
      ftpHost: "",
      ftpPort: 21,
      ftpUser: "",
      ftpPassword: "",
      ftpSecure: false,
      sshHost: "",
      sshPort: 22,
      sshUser: "",
      sshKeyPath: "",
    };

    switch (match[2].toUpperCase()) {
      case "TYPE":
        switch (String(rawValue ?? "").trim().toLowerCase()) {
          case "ftp":
            source.kind = "ftp";
            break;
          case "ssh":
            source.kind = "ssh";
            break;
          default:
            source.kind = "local";
            break;
        }
        break;
      case "DB_PATH":
        source.dbPath = String(rawValue ?? "").trim();
        break;
      case "HEADER_UUID":
        source.headerUuid = String(rawValue ?? "").trim().toLowerCase();
        break;
      case "FTP_HOST":
        source.ftpHost = String(rawValue ?? "").trim();
        break;
      case "FTP_PORT":
        source.ftpPort = parsePort(String(rawValue ?? "").trim());
        break;
      case "FTP_USER":
        source.ftpUser = String(rawValue ?? "").trim();
        break;
      case "FTP_PASSWORD":
        source.ftpPassword = String(rawValue ?? "").trim();
        break;
      case "FTP_SECURE":
        source.ftpSecure = parseBoolean(String(rawValue ?? "").trim());
        break;
      case "SSH_HOST":
        source.sshHost = String(rawValue ?? "").trim();
        break;
      case "SSH_PORT":
        source.sshPort = parsePort(String(rawValue ?? "").trim());
        break;
      case "SSH_USER":
        source.sshUser = String(rawValue ?? "").trim();
        break;
      case "SSH_KEY_PATH":
        source.sshKeyPath = String(rawValue ?? "").trim();
        break;
    }

    drafts.set(serverId, source);
  }

  const sources: Record<string, WorldDbSourceConfig> = {};
  for (const [serverId, draft] of drafts.entries()) {
    if (draft.kind === "ftp") {
      sources[serverId] = {
        serverId,
        kind: "ftp",
        dbPath: draft.dbPath,
        headerUuid: draft.headerUuid,
        ftp: {
          host: draft.ftpHost,
          port: draft.ftpPort,
          user: draft.ftpUser,
          password: draft.ftpPassword,
          secure: draft.ftpSecure,
        },
      };
      continue;
    }

    if (draft.kind === "ssh") {
      sources[serverId] = {
        serverId,
        kind: "ssh",
        dbPath: draft.dbPath,
        headerUuid: draft.headerUuid,
        ssh: {
          host: draft.sshHost,
          port: draft.sshPort,
          user: draft.sshUser,
          keyPath: draft.sshKeyPath,
        },
      };
      continue;
    }

    sources[serverId] = {
      serverId,
      kind: "local",
      dbPath: draft.dbPath,
      headerUuid: draft.headerUuid,
    };
  }

  return sources;
}

export const serverConfig = {
  host: process.env.INVSYNC_BIND_HOST ?? "127.0.0.1",
  port: parsePort(process.env.PORT),
  dataDir: process.env.INVSYNC_DATA_DIR ?? path.resolve(process.cwd(), "data"),
  apiToken: process.env.INVSYNC_API_TOKEN ?? "",
  jsonBodyLimit: "1mb",
  worldDbSources: parseWorldDbSources(process.env),
};

export function assertServerConfig(): void {
  if (!serverConfig.apiToken) {
    throw new Error("INVSYNC_API_TOKEN is required.");
  }

  for (const [serverId, source] of Object.entries(serverConfig.worldDbSources)) {
    if (!source.dbPath) {
      throw new Error(`INVSYNC_WORLD_SOURCE_${serverId.toUpperCase()}_DB_PATH is required when the source is configured.`);
    }

    if (source.kind === "ftp") {
      if (!source.ftp.host) {
        throw new Error(`INVSYNC_WORLD_SOURCE_${serverId.toUpperCase()}_FTP_HOST is required for FTP world db sources.`);
      }

      if (!source.ftp.user) {
        throw new Error(`INVSYNC_WORLD_SOURCE_${serverId.toUpperCase()}_FTP_USER is required for FTP world db sources.`);
      }

      if (!source.ftp.password) {
        throw new Error(`INVSYNC_WORLD_SOURCE_${serverId.toUpperCase()}_FTP_PASSWORD is required for FTP world db sources.`);
      }
    }

    if (source.kind === "ssh") {
      if (!source.ssh.host) {
        throw new Error(`INVSYNC_WORLD_SOURCE_${serverId.toUpperCase()}_SSH_HOST is required for SSH world db sources.`);
      }

      if (!source.ssh.user) {
        throw new Error(`INVSYNC_WORLD_SOURCE_${serverId.toUpperCase()}_SSH_USER is required for SSH world db sources.`);
      }

      if (!source.ssh.keyPath) {
        throw new Error(`INVSYNC_WORLD_SOURCE_${serverId.toUpperCase()}_SSH_KEY_PATH is required for SSH world db sources.`);
      }
    }
  }
}
