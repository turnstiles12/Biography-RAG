// Loads .env (if present) before any module reads process.env. Import this first in every script.
import fs from "node:fs";

for (const f of [".env.local", ".env"]) {
  if (fs.existsSync(f)) {
    try {
      process.loadEnvFile(f);
    } catch {
      /* ignore malformed env files */
    }
  }
}
