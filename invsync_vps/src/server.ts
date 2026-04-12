import express, { type NextFunction, type Request, type Response } from "express";
import { assertServerConfig, serverConfig } from "./config";
import {
  appendInventoryAuditEvent,
  consumeInventorySnapshot,
  consumeLatestBackupSnapshot,
  loadInventorySnapshot,
  saveBackupSnapshot,
  saveInventorySnapshot,
} from "./store";
import type {
  IdentityType,
  InventoryAuditAction,
  InventoryAuditEvent,
  InventoryAuditRecordRequest,
  InventorySnapshot,
} from "./types";
import { isInventoryAuditRecordRequest, isInventorySnapshot } from "./types";

function sendJsonError(response: Response, status: number, message: string): void {
  response.status(status).json({
    ok: false,
    error: message,
  });
}

function isIdentityType(value: unknown): value is IdentityType {
  return value === "name" || value === "xuid";
}

function getBearerToken(request: Request): string | undefined {
  const authorization = request.header("authorization");
  if (!authorization) {
    return undefined;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function requireLookupParams(
  request: Request,
): { namespace: string; identityType: IdentityType; playerKey: string } | undefined {
  const namespace = request.query.namespace;
  const identityType = request.query.identityType;
  const playerKey = request.query.playerKey;

  if (
    typeof namespace !== "string" ||
    !isIdentityType(identityType) ||
    typeof playerKey !== "string" ||
    namespace.length === 0 ||
    playerKey.length === 0
  ) {
    return undefined;
  }

  return {
    namespace,
    identityType,
    playerKey,
  };
}

function createSnapshotAuditEvent(action: InventoryAuditAction, snapshot: InventorySnapshot): InventoryAuditEvent {
  return {
    action,
    occurredAt: new Date().toISOString(),
    namespace: snapshot.namespace,
    identityType: snapshot.identityType,
    playerKey: snapshot.playerKey,
    snapshotId: snapshot.snapshotId,
    snapshotSavedAt: snapshot.savedAt,
    source: snapshot.source,
    executedSource: snapshot.source,
  };
}

function createAuditEventFromRequest(request: InventoryAuditRecordRequest): InventoryAuditEvent {
  return {
    action: request.action,
    occurredAt: request.occurredAt ?? new Date().toISOString(),
    namespace: request.namespace,
    identityType: request.identityType,
    playerKey: request.playerKey,
    snapshotId: request.snapshotId,
    snapshotSavedAt: request.snapshotSavedAt,
    source: request.source,
    executedSource: request.executedSource,
  };
}

function isBackupAuditRequest(request: Request): boolean {
  return request.query.mode === "backup";
}

function isBackupLoadRequest(request: Request): boolean {
  return request.query.source === "backup";
}

async function tryAppendAuditEvent(event: InventoryAuditEvent): Promise<void> {
  try {
    await appendInventoryAuditEvent(event);
  } catch (error) {
    console.error("[InvSync VPS] Failed to append audit log", error);
  }
}

async function main(): Promise<void> {
  assertServerConfig();

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: serverConfig.jsonBodyLimit }));

  app.use((request: Request, response: Response, next: NextFunction) => {
    const token = getBearerToken(request);
    if (token !== serverConfig.apiToken) {
      sendJsonError(response, 401, "Unauthorized");
      return;
    }

    next();
  });

  app.post("/api/inventory/save", async (request, response, next) => {
    try {
      if (!isInventorySnapshot(request.body)) {
        sendJsonError(response, 400, "Invalid snapshot payload");
        return;
      }

      await saveInventorySnapshot(request.body);
      await tryAppendAuditEvent(createSnapshotAuditEvent("save", request.body));

      response.json({
        ok: true,
        playerKey: request.body.playerKey,
        identityType: request.body.identityType,
        savedAt: request.body.savedAt,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/inventory/backup-before-load", async (request, response, next) => {
    try {
      if (!isInventorySnapshot(request.body)) {
        sendJsonError(response, 400, "Invalid snapshot payload");
        return;
      }

      await saveBackupSnapshot(request.body);
      await tryAppendAuditEvent(createSnapshotAuditEvent("backup_before_load", request.body));

      response.json({
        ok: true,
        playerKey: request.body.playerKey,
        identityType: request.body.identityType,
        savedAt: request.body.savedAt,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/inventory/audit/load", async (request, response, next) => {
    try {
      let event: InventoryAuditEvent;

      if (isInventoryAuditRecordRequest(request.body)) {
        event = createAuditEventFromRequest(request.body);
      } else if (isInventorySnapshot(request.body)) {
        event = createSnapshotAuditEvent(isBackupAuditRequest(request) ? "load_backup" : "load", request.body);
      } else {
        sendJsonError(response, 400, "Invalid snapshot payload");
        return;
      }

      await tryAppendAuditEvent(event);
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/inventory/audit/load-backup", async (request, response, next) => {
    try {
      let event: InventoryAuditEvent;

      if (isInventoryAuditRecordRequest(request.body)) {
        event = createAuditEventFromRequest(request.body);
      } else if (isInventorySnapshot(request.body)) {
        event = createSnapshotAuditEvent("load_backup", request.body);
      } else {
        sendJsonError(response, 400, "Invalid snapshot payload");
        return;
      }

      await tryAppendAuditEvent(event);
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/inventory/load", async (request, response, next) => {
    try {
      const params = requireLookupParams(request);
      if (!params) {
        sendJsonError(response, 400, "Invalid query");
        return;
      }

      const result = isBackupLoadRequest(request)
        ? await consumeLatestBackupSnapshot(params.namespace, params.identityType, params.playerKey)
        : await consumeInventorySnapshot(params.namespace, params.identityType, params.playerKey);
      if (!result.snapshot) {
        response.json({
          ok: true,
          found: false,
          consumed: false,
          playerKey: params.playerKey,
          identityType: params.identityType,
        });
        return;
      }

      if (result.consumed) {
        response.json({
          ok: true,
          found: true,
          consumed: true,
          consumedAt: result.consumedAt,
          playerKey: result.snapshot.playerKey,
          identityType: result.snapshot.identityType,
          savedAt: result.snapshot.savedAt,
        });
        return;
      }

      response.json({
        ok: true,
        found: true,
        consumed: false,
        consumedAt: result.consumedAt,
        playerKey: result.snapshot.playerKey,
        identityType: result.snapshot.identityType,
        savedAt: result.snapshot.savedAt,
        snapshot: result.snapshot,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/inventory/load-backup", async (request, response, next) => {
    try {
      const params = requireLookupParams(request);
      if (!params) {
        sendJsonError(response, 400, "Invalid query");
        return;
      }

      const result = await consumeLatestBackupSnapshot(params.namespace, params.identityType, params.playerKey);
      if (!result.snapshot) {
        response.json({
          ok: true,
          found: false,
          consumed: false,
          playerKey: params.playerKey,
          identityType: params.identityType,
        });
        return;
      }

      if (result.consumed) {
        response.json({
          ok: true,
          found: true,
          consumed: true,
          consumedAt: result.consumedAt,
          playerKey: result.snapshot.playerKey,
          identityType: result.snapshot.identityType,
          savedAt: result.snapshot.savedAt,
        });
        return;
      }

      response.json({
        ok: true,
        found: true,
        consumed: false,
        consumedAt: result.consumedAt,
        playerKey: result.snapshot.playerKey,
        identityType: result.snapshot.identityType,
        savedAt: result.snapshot.savedAt,
        snapshot: result.snapshot,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/inventory/status", async (request, response, next) => {
    try {
      const params = requireLookupParams(request);
      if (!params) {
        sendJsonError(response, 400, "Invalid query");
        return;
      }

      const snapshot = await loadInventorySnapshot(params.namespace, params.identityType, params.playerKey);
      if (!snapshot) {
        response.json({
          ok: true,
          found: false,
          playerKey: params.playerKey,
          identityType: params.identityType,
        });
        return;
      }

      response.json({
        ok: true,
        found: true,
        consumed: Boolean(snapshot.loadConsumedAt),
        consumedAt: snapshot.loadConsumedAt,
        playerKey: snapshot.playerKey,
        identityType: snapshot.identityType,
        savedAt: snapshot.savedAt,
        source: snapshot.source,
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((_request: Request, response: Response) => {
    sendJsonError(response, 404, "Not found");
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof SyntaxError) {
      sendJsonError(response, 400, "Invalid JSON");
      return;
    }

    console.error("[InvSync VPS] Unexpected error", error);
    sendJsonError(response, 500, "Internal server error");
  });

  app.listen(serverConfig.port, serverConfig.host, () => {
    console.info(`[InvSync VPS] Listening on ${serverConfig.host}:${serverConfig.port}`);
  });
}

void main().catch((error) => {
  console.error("[InvSync VPS] Failed to start", error);
  process.exitCode = 1;
});
