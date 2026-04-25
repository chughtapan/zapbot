import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LOG_DIR = path.join(os.homedir(), ".zapbot", "logs");
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (err: any) {
  process.stderr.write(`[log dir init failed: ${err.message}]\n`);
}

function getLogFilePath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `bridge-${date}.log`);
}

function formatKv(kv: Record<string, unknown>): string {
  const parts = Object.entries(kv)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function getMinLevel(): LogLevel {
  const env = process.env.ZAPBOT_LOG_LEVEL?.toLowerCase();
  if (env && env in LEVEL_ORDER) return env as LogLevel;
  return "info";
}

class Logger {
  readonly component: string;

  constructor(component: string) {
    this.component = component;
  }

  private log(level: LogLevel, message: string, kv: Record<string, unknown> = {}): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[getMinLevel()]) return;

    const timestamp = new Date().toISOString();
    const line = `${timestamp} ${level.toUpperCase().padEnd(5)} [${this.component}] ${message}${formatKv(kv)}`;

    const stream = level === "error" ? process.stderr : process.stdout;
    stream.write(line + "\n");

    try {
      fs.appendFile(getLogFilePath(), line + "\n", (err) => {
        if (err) process.stderr.write(`[log write failed: ${err.message}]\n`);
      });
    } catch (err: any) {
      process.stderr.write(`[log init failed: ${err.message}]\n`);
    }
  }

  debug(message: string, kv?: Record<string, unknown>): void {
    this.log("debug", message, kv);
  }

  info(message: string, kv?: Record<string, unknown>): void {
    this.log("info", message, kv);
  }

  warn(message: string, kv?: Record<string, unknown>): void {
    this.log("warn", message, kv);
  }

  error(message: string, kv?: Record<string, unknown>): void {
    this.log("error", message, kv);
  }
}

export function createLogger(component: string): Logger {
  return new Logger(component);
}
