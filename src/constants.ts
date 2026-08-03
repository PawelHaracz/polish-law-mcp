import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Read the version from package.json rather than restating it here — a second
 * copy drifts (this one said 1.0.0 while the package was at 2.0.0).
 * dist/src/constants.js resolves ../../package.json; running from src/ resolves
 * ../package.json. Try both, and fall back rather than crash on startup.
 */
function readPackageVersion(): string {
  for (const path of ['../../package.json', '../package.json']) {
    try {
      const pkg = require(path) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // Try the next candidate.
    }
  }
  return '0.0.0';
}

export const SERVER_NAME = 'polish-law-mcp';
export const SERVER_VERSION = readPackageVersion();
export const SERVER_LABEL = 'Polish Law MCP';
export const PACKAGE_NAME = '@ansvar/polish-law-mcp';
export const REPOSITORY_URL = 'https://github.com/Ansvar-Systems/polish-law-mcp';
export const DB_ENV_VAR = 'POLISH_LAW_DB_PATH';
