import { describe, expect, it } from 'vitest';

import { CRON_PRESETS, describeCron } from './cron';

describe('describeCron', () => {
  it.each([
    ['* * * * *', 'Every minute'],
    ['*/15 * * * *', 'Every 15 minutes'],
    ['0 * * * *', 'Every hour'],
    ['30 * * * *', 'Every hour at :30'],
    ['5 9 * * *', 'Every day at 09:05'],
    ['0 9 * * 1-5', 'Weekdays at 09:00'],
    ['0 10 * * 6,0', 'Weekends at 10:00'],
    ['0 9 * * 1', 'Every Monday at 09:00'],
    ['0 9 * * 7', 'Every Sunday at 09:00'],
    ['0 9 1 * *', 'Day 1 of every month at 09:00'],
  ])('describes %s', (expression, text) => {
    expect(describeCron(expression)).toBe(text);
  });

  it('returns unrecognised or malformed expressions unchanged', () => {
    expect(describeCron('0 9 * 3 *')).toBe('0 9 * 3 *');
    expect(describeCron('0 9-17 * * *')).toBe('0 9-17 * * *');
    expect(describeCron('0 9 * *')).toBe('0 9 * *');
  });

  it('describes every preset in words matching its label', () => {
    for (const preset of CRON_PRESETS) {
      expect(describeCron(preset.expression)).not.toBe(preset.expression);
    }
  });
});
