#!/usr/bin/env node

import 'dotenv/config';
import { startServer } from "./server/express.js";
import { logger } from "./utils/logger.js";

startServer().catch((error) => {
  logger.error("Fatal error running server:", error);
  process.exit(1);
});
