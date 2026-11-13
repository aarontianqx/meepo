/** Human-readable descriptions for the common 5-field cron shapes; raw cron otherwise. */

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface CronPreset {
  id: string;
  label: string;
  expression: string;
}

export const CRON_PRESETS: CronPreset[] = [
  { id: 'hourly', label: 'Every hour', expression: '0 * * * *' },
  { id: 'daily', label: 'Every day at 09:00', expression: '0 9 * * *' },
  { id: 'weekdays', label: 'Weekdays at 09:00', expression: '0 9 * * 1-5' },
  { id: 'monday', label: 'Every Monday at 09:00', expression: '0 9 * * 1' },
  { id: 'monthly', label: 'First of the month at 09:00', expression: '0 9 1 * *' },
];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Describes a cron expression in plain English when it matches a known shape. */
export function describeCron(expression: string): string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return expression;
  const [minute, hour, dom, month, dow] = parts;
  const everyMinutes = /^\*\/(\d+)$/.exec(minute);
  if (everyMinutes && hour === '*' && dom === '*' && month === '*' && dow === '*')
    return `Every ${everyMinutes[1]} minutes`;
  if (minute === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*')
    return 'Every minute';
  const fixedMinute = /^\d+$/.test(minute);
  if (fixedMinute && hour === '*' && dom === '*' && month === '*' && dow === '*')
    return minute === '0' ? 'Every hour' : `Every hour at :${pad(Number(minute))}`;
  const fixedHour = /^\d+$/.test(hour);
  if (!fixedMinute || !fixedHour) return expression;
  const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
  if (dom === '*' && month === '*') {
    if (dow === '*') return `Every day at ${time}`;
    if (dow === '1-5') return `Weekdays at ${time}`;
    if (dow === '0,6' || dow === '6,0') return `Weekends at ${time}`;
    if (/^[0-7]$/.test(dow)) return `Every ${WEEKDAYS[Number(dow) % 7]} at ${time}`;
  }
  if (/^\d+$/.test(dom) && month === '*' && dow === '*')
    return `Day ${dom} of every month at ${time}`;
  return expression;
}
