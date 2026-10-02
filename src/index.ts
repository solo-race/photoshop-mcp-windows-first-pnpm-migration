#!/usr/bin/env node

import { PhotoshopMCPServer } from './core/server.js';
import { Logger } from './utils/logger.js';

const logger = new Logger('Main');
const startupErrorCodes = new Set([
  'WRITER_LOCK_ACTIVE',
  'WRITER_LOCK_UNCERTAIN',
  'WRITER_LOCK_ACQUIRE_FAILED',
  'WRITER_LOCK_RECOVERY_FAILED',
  'WRITER_LOCK_PID_WRITE_FAILED',
]);

async function main() {
  try {
    logger.info('Starting Photoshop MCP Server...');
    
    const server = new PhotoshopMCPServer();
    await server.start();
    
    logger.info('Photoshop MCP Server is running');
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = startupErrorCodes.has(message) ? message : 'STARTUP_FAILED';
    logger.error(`Failed to start server: ${code}`);
    process.exit(1);
  }
}

main();
