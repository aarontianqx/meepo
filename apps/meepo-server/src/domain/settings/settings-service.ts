import { validation } from '../errors.js';

/** Key/value storage for server-wide settings. */
export interface SettingsRepository {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

const GLOBAL_INSTRUCTIONS_KEY = 'global_instructions';

/** Server-wide settings edited by global administrators. */
export class SettingsService {
  constructor(private readonly settings: SettingsRepository) {}

  /** Instructions applied to every space's sessions created from now on; empty when unset. */
  async getGlobalInstructions(): Promise<string> {
    return (await this.settings.get(GLOBAL_INSTRUCTIONS_KEY)) ?? '';
  }

  /** Replaces the global instructions; blank text clears them. */
  async setGlobalInstructions(instructions: unknown): Promise<string> {
    if (typeof instructions !== 'string') throw validation('instructions must be a string');
    const text = instructions.trim();
    await this.settings.set(GLOBAL_INSTRUCTIONS_KEY, text);
    return text;
  }
}
