import type { Space, SpaceModelRef } from '@meepo/core';
import { useState } from 'react';

import { api } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { setQueryData, useQuery } from '../../api/query';
import { useMe, useSpace } from '../../app/context';
import { navigate } from '../../app/router';
import { Button } from '../../ui/Button';
import { Field, Segmented, Select } from '../../ui/Form';
import { Callout, ErrorState, ListSkeleton } from '../../ui/Misc';
import { useAction } from '../../ui/useAction';

type Level = NonNullable<SpaceModelRef['thinkingLevel']> | 'default';

const PRESETS = [
  { value: 'general', label: 'General assistant' },
  { value: 'coding', label: 'Software development' },
] as const;

const PRESET_HINT = {
  general:
    'A flexible assistant for chat, research and everyday tasks. Works in a scratch directory for every conversation.',
  coding:
    'For software work: the agent uses an isolated git worktree before changing repository code. It finds and clones repositories itself, using the worker machine’s own git access.',
} as const;

function replaceSpace(updated: Space): void {
  setQueryData<Space[]>(keys.spaces, (cur) =>
    (cur ?? []).map((s) => (s.id === updated.id ? updated : s))
  );
}

export function AgentSettings(): React.JSX.Element {
  return (
    <>
      <ModelCard />
      <PresetCard />
    </>
  );
}

function ModelCard(): React.JSX.Element {
  const space = useSpace();
  const me = useMe();
  const { run, pending } = useAction();
  const options = useQuery(keys.modelOptions, api.modelOptions);
  const [modelId, setModelId] = useState(space.model?.modelId ?? '');
  const [level, setLevel] = useState<Level>(space.model?.thinkingLevel ?? 'default');

  if (options.error && !options.data)
    return <ErrorState message={options.error} onRetry={() => void options.refresh()} />;
  if (!options.data) return <ListSkeleton rows={3} />;

  const fallback = options.data.find((o) => o.isDefault);
  const dirty =
    modelId !== (space.model?.modelId ?? '') || level !== (space.model?.thinkingLevel ?? 'default');
  const unknown = modelId !== '' && !options.data.some((o) => o.id === modelId);

  const save = async (): Promise<void> => {
    const model: SpaceModelRef | undefined = modelId
      ? { modelId, ...(level === 'default' ? {} : { thinkingLevel: level }) }
      : undefined;
    const updated = await run(() => api.updateSpaceModel(space.id, model), {
      success: 'Model saved',
    });
    if (updated) replaceSpace(updated);
  };

  return (
    <form
      className='card card-pad stack'
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div>
        <h3 className='card-title'>Model</h3>
        <p className='muted'>
          Which model answers in this space. Changes apply from the next turn.
        </p>
      </div>
      {options.data.length === 0 ? (
        <Callout
          tone='warn'
          title='No models are registered yet'
          action={
            me.isAdmin ? (
              <Button size='sm' onClick={() => navigate('#/models')}>
                Open models
              </Button>
            ) : undefined
          }
        >
          {me.isAdmin ? 'Register one to let agents run.' : 'Ask a platform admin to register one.'}
        </Callout>
      ) : null}
      <Field label='Model'>
        <Select value={modelId} onChange={(e) => setModelId(e.target.value)}>
          <option value=''>Platform default{fallback ? ` (${fallback.model})` : ''}</option>
          {unknown ? <option value={modelId}>{modelId} (no longer registered)</option> : null}
          {options.data.map((o) => (
            <option key={o.id} value={o.id}>
              {o.model} · {o.provider}
              {o.isDefault ? ' · default' : ''}
            </option>
          ))}
        </Select>
      </Field>
      <div className='field'>
        <span className='field-label'>Thinking effort</span>
        <Segmented<Level>
          label='Thinking effort'
          value={level}
          onChange={setLevel}
          options={[
            { value: 'default', label: 'Model default' },
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' },
            { value: 'max', label: 'Max' },
          ]}
        />
        <span className='field-hint'>
          Higher effort answers better on hard problems but is slower and costs more.
        </span>
      </div>
      {unknown ? (
        <Callout tone='warn' title='This model was removed from the registry'>
          Runs in this space fail until you pick another model.
        </Callout>
      ) : null}
      <div className='row'>
        <Button type='submit' variant='primary' loading={pending} disabled={!dirty}>
          Save model
        </Button>
      </div>
    </form>
  );
}

function PresetCard(): React.JSX.Element {
  const space = useSpace();
  const { run, pending } = useAction();
  const current = space.promptPreset ?? 'general';
  const [preset, setPreset] = useState<'general' | 'coding'>(current);

  const save = async (): Promise<void> => {
    const updated = await run(() => api.updateSpace(space.id, { promptPreset: preset }), {
      success: 'Preset saved',
    });
    if (updated) replaceSpace(updated);
  };

  return (
    <section className='card card-pad stack'>
      <div>
        <h3 className='card-title'>Behavior</h3>
        <p className='muted'>The kind of work the agent is set up for.</p>
      </div>
      <Segmented
        label='Prompt preset'
        value={preset}
        onChange={setPreset}
        options={PRESETS.map((p) => ({ value: p.value, label: p.label }))}
      />
      <p className='muted'>{PRESET_HINT[preset]}</p>
      <Callout>
        Conversations that already exist keep the preset they started with. New ones use the setting
        above.
      </Callout>
      <div className='row'>
        <Button
          variant='primary'
          loading={pending}
          disabled={preset === current}
          onClick={() => void save()}
        >
          Save behavior
        </Button>
      </div>
    </section>
  );
}
