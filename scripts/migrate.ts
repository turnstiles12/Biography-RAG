import "./_env";
import { runMigrations } from "../src/lib/migrate";
import { pool } from "../src/lib/db";

runMigrations((m) => console.log(m))
  .then((applied) => {
    console.log(applied.length ? `Applied ${applied.length} migration(s).` : "Schema already up to date.");
  })
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => pool().end());
