export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export class Logger {
  private context: string;
  private logLevel: LogLevel;

  constructor(context: string, logLevel: LogLevel = LogLevel.INFO) {
    this.context = context;
    this.logLevel = process.env.LOG_LEVEL
      ? parseInt(process.env.LOG_LEVEL, 10)
      : logLevel;
  }

  private log(level: LogLevel, message: string, ...args: unknown[]) {
    if (level < this.logLevel) return;

    const timestamp = new Date().toISOString();
    const levelStr = LogLevel[level];
    const prefix = `[${timestamp}] [${levelStr}] [${this.context}]`;

    // IMPORTANT: MCP uses stdout for protocol communication
    // All logs must go to stderr to avoid corrupting the JSON-RPC protocol
    const formattedArgs = args.map((arg) => this.formatArg(arg)).join(' ');
    
    const logMessage = `${prefix} ${message} ${formattedArgs}`.trim();
    
    // Always write to stderr, never stdout
    process.stderr.write(logMessage + '\n');
  }

  private formatArg(arg: unknown): string {
    if (arg instanceof Error) {
      return JSON.stringify({
        name: arg.name,
        message: arg.message,
        stack: arg.stack,
      });
    }

    if (typeof arg === 'object') {
      return JSON.stringify(arg);
    }

    return String(arg);
  }

  debug(message: string, ...args: unknown[]) {
    this.log(LogLevel.DEBUG, message, ...args);
  }

  info(message: string, ...args: unknown[]) {
    this.log(LogLevel.INFO, message, ...args);
  }

  warn(message: string, ...args: unknown[]) {
    this.log(LogLevel.WARN, message, ...args);
  }

  error(message: string, ...args: unknown[]) {
    this.log(LogLevel.ERROR, message, ...args);
  }
}
