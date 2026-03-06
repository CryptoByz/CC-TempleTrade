import * as winston from "winston";
import * as path from "path";
import * as fs from "fs";

const logDir = "logs";
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const fmt = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.printf(({ timestamp, level, message }) =>
    `${timestamp} | ${String(level).toUpperCase().padEnd(5)} | ${message}`
  )
);

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? "info",
  format: fmt,
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), fmt),
    }),
    new winston.transports.File({
      filename: path.join(logDir, "bot.log"),
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(logDir, "trades.log"),
      level: "info",
      maxsize: 5 * 1024 * 1024,
      maxFiles: 10,
    }),
  ],
});
