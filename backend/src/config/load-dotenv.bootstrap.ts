import { loadDotEnvFile } from './load-dotenv';

// Side effect on import: main.ts imports this module first, before anything that reads
// config, so backend/.env values are in process.env by the time validateEnv() and the rest
// of the module graph run.
loadDotEnvFile();
