const PREFIX = "[InvSync]";

function formatDetails(details?: unknown): string {
  if (details === undefined) {
    return "";
  }

  if (details instanceof Error) {
    return ` ${details.stack ?? details.message}`;
  }

  try {
    return ` ${JSON.stringify(details)}`;
  } catch {
    return ` ${String(details)}`;
  }
}

export const logger = {
  info(message: string, details?: unknown): void {
    console.info(`${PREFIX} ${message}${formatDetails(details)}`);
  },
  warn(message: string, details?: unknown): void {
    console.warn(`${PREFIX} ${message}${formatDetails(details)}`);
  },
  error(message: string, details?: unknown): void {
    console.error(`${PREFIX} ${message}${formatDetails(details)}`);
  },
};
