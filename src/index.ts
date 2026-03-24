#!/usr/bin/env node
import 'dotenv/config';
import { startServer } from './shared/http/express-app.js';
import { logger } from './shared/logger.js';

startServer().catch((error) => {
  logger.error('Fatal error running server:', error);
  process.exit(1);
});
