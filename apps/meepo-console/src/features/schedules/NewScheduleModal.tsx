import type { ScheduleAction, ScheduleTiming } from '@meepo/core';
import { useState } from 'react';

import { errorMessage } from '../../api/client';
import { api } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { invalidate } from '../../api/query';
import type { SessionItem } from '../../api/types';
import { useSpace } from '../../app/context';
import { CRON_PRESETS, describeCron } from '../../lib/cron';
import { oneLine } from '../../lib/format';
import { sessionName, sessionWhere } from '../../lib/session';
import { timezoneOptions } from '../../lib/timezone';
import { Button } from '../../ui/Button';
import { Field, Input, Segmented, Select, TagInput, Textarea } from '../../ui/Form';
import { Callout } from '../../ui/Misc';
import { Modal } from '../../ui/Modal';
import { useAction } from '../../ui/useAction';

type ActionKind = ScheduleAction['kind'];
type WhenKind = 'at' | 'cron';

const CUSTOM = 'custom';

/** `datetime-local` value (browser-local) for a timestamp. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function NewScheduleModal({
  sessions,
  onClose,
}: {
  sessions: SessionItem[];
  onClose: () => void;
}): React.JSX.Element {
  const space = useSpace();
  const { run, pending, error } = useAction();
  const [actionKind, setActionKind] = useState<ActionKind>('create_ticket');
  const [objective, setObjective] = useState('');
  const [context, setContext] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [pickedSession, setPickedSession] = useState('');
  // Until the user picks one (or while the list is still loading) the first conversation applies,
  // matching what the native select displays.
  const sessionId = sessions.some((s) => s.id === pickedSession)
    ? pickedSession
    : (sessions[0]?.id ?? '');
  const [prompt, setPrompt] = useState('');

  const [whenKind, setWhenKind] = useState<WhenKind>('cron');
  const [at, setAt] = useState(toLocalInput(Date.now() + 60 * 60_000));
  const [preset, setPreset] = useState(CRON_PRESETS[1].id);
  const [custom, setCustom] = useState('0 9 * * 1-5');
  const [timezone, setTimezone] = useState(space.timezone);

  const expression =
    preset === CUSTOM
      ? custom.trim()
      : (CRON_PRESETS.find((p) => p.id === preset)?.expression ?? '');
  const atMs = new Date(at).getTime();
  const atInvalid = whenKind === 'at' && (Number.isNaN(atMs) || atMs <= Date.now());

  const ready =
    !atInvalid &&
    (whenKind === 'cron' ? expression.length > 0 : true) &&
    (actionKind === 'create_ticket'
      ? objective.trim().length > 0
      : sessionId !== '' && prompt.trim().length > 0);

  const submit = async (): Promise<void> => {
    const timing: ScheduleTiming =
      whenKind === 'at' ? { kind: 'at', at: atMs } : { kind: 'cron', expression, timezone };
    const action: ScheduleAction =
      actionKind === 'create_ticket'
        ? {
            kind: 'create_ticket',
            objective: objective.trim(),
            contextSummary: context.trim() || undefined,
            requiredTags: tags.length > 0 ? tags : undefined,
          }
        : { kind: 'resume_session', sessionId, prompt: prompt.trim() };
    const created = await run(() => api.createSchedule({ spaceId: space.id, timing, action }), {
      success: 'Schedule created',
      toastError: false,
    });
    if (!created) return;
    invalidate(keys.schedules(space.id));
    onClose();
  };

  return (
    <Modal
      title='New schedule'
      description='Choose what the agent should do, and when.'
      wide
      locked={pending}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type='submit' variant='primary' loading={pending} disabled={!ready}>
            Create schedule
          </Button>
        </>
      }
    >
      <div className='field'>
        <span className='field-label'>What should happen?</span>
        <Segmented
          label='Action'
          value={actionKind}
          onChange={setActionKind}
          options={[
            { value: 'create_ticket', label: 'Start a background ticket' },
            { value: 'resume_session', label: 'Continue a conversation' },
          ]}
        />
      </div>

      {actionKind === 'create_ticket' ? (
        <>
          <Field label='Task for the agent'>
            <Textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              rows={4}
              data-autofocus
            />
          </Field>
          <Field label='Background' optional>
            <Textarea value={context} onChange={(e) => setContext(e.target.value)} rows={2} />
          </Field>
          <Field label='Required worker tags' optional>
            <TagInput value={tags} onChange={setTags} mono />
          </Field>
        </>
      ) : sessions.length === 0 ? (
        <Callout tone='warn'>
          There are no open conversations to continue yet. Start one in a connected chat first.
        </Callout>
      ) : (
        <>
          <Field
            label='Conversation'
            hint='The agent wakes up in this conversation; its reply goes to that chat.'
          >
            <Select value={sessionId} onChange={(e) => setPickedSession(e.target.value)}>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {oneLine(sessionName(s), 60)} - {sessionWhere(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label='Message to the agent'
            hint='Sent as if it were a new message when the schedule fires.'
          >
            <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} />
          </Field>
        </>
      )}

      <div className='divider' />

      <div className='field'>
        <span className='field-label'>When?</span>
        <Segmented
          label='Timing'
          value={whenKind}
          onChange={setWhenKind}
          options={[
            { value: 'cron', label: 'Repeat' },
            { value: 'at', label: 'Once' },
          ]}
        />
      </div>

      {whenKind === 'at' ? (
        <Field
          label='Date and time'
          hint={`In your browser time (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`}
          error={atInvalid ? 'Pick a time in the future.' : undefined}
        >
          <Input type='datetime-local' value={at} onChange={(e) => setAt(e.target.value)} />
        </Field>
      ) : (
        <>
          <div className='grid-2'>
            <Field label='Repeats'>
              <Select value={preset} onChange={(e) => setPreset(e.target.value)}>
                {CRON_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
                <option value={CUSTOM}>Custom (cron)…</option>
              </Select>
            </Field>
            <Field label='Timezone'>
              <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {timezoneOptions(space.timezone).map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {preset === CUSTOM ? (
            <Field
              label='Cron expression'
              hint={
                expression
                  ? describeCron(expression)
                  : 'Five fields: minute hour day month weekday.'
              }
            >
              <Input
                mono
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder='0 9 * * 1-5'
              />
            </Field>
          ) : null}
        </>
      )}

      {error ? (
        <Callout tone='danger' title='Could not create the schedule'>
          {errorMessage(error)}
        </Callout>
      ) : null}
    </Modal>
  );
}
