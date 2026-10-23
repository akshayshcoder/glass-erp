import type pg from 'pg';
import type { Guards } from './auth/guards.js';
import type { TokenService } from './auth/tokens.js';
import type { Config } from './config.js';

/** Shared dependencies handed to every module's route registrar. */
export interface AppContext {
  config: Config;
  pool: pg.Pool;
  tokens: TokenService;
  guards: Guards;
}
