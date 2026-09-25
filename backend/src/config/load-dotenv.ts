import { join } from 'path';

/**
 * Loads backend/.env into process.env, if present, before validateEnv() parses
 * process.env. Real environment variables set before this runs win — Node's
 * process.loadEnvFile() never overrides a variable that already exists — so this is
 * safe to call unconditionally in production containers and CI, which set real env
 * vars and ship no .env file. A missing .env is a no-op rather than a startup error.
 */
export function loadDotEnvFile(path: string = join(process.cwd(), '.env')): void {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
}
