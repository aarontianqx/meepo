import type { Space, SpaceModelRef } from '@meepo/core';
import { REASONING_EFFORTS } from '@meepo/protocol';
import { useState } from 'react';

import { api } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { setQueryData, useQuery } from '../../api/query';
import { useMe, useSpace } from '../../app/context';
import { navigate } from '../../app/router';
import { formatTokens, groupByProvider, levelFor, type Level } from '../../lib/models';
import { Button } from '../../ui/Button';
import { Field, Segmented, Select, Textarea } from '../../ui/Form';
import { Callout, ErrorState, ListSkeleton } from '../../ui/Misc';
import { useAction } from '../../ui/useAction';

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
      <InstructionsCard />
    </>
  );
}

function ModelCard(): React.JSX.Element {
  const space = useSpace();
  const me = useMe();
  const { run, pending } = useAction();
  const options = useQuery(keys.modelOptions, api.modelOptions);
  const [modelId, setModelId] = useState(space.model?.modelId ?? '');
  const [wanted, setLevel] = useState<Level>(space.model?.thinkingLevel ?? 'default');

  if (options.error && !options.data)
    return <ErrorState message={options.error} onRetry={() => void options.refresh()} />;
  if (!options.data) return <ListSkeleton rows={3} />;

  const fallback = options.data.find((o) => o.isDefault);
  // The model whose capabilities apply: the picked one, else the platform default.
  const selected = modelId ? options.data.find((o) => o.id === modelId) : fallback;
  const unknown = modelId !== '' && !selected;
  // A level the model does not support is never kept: the server would ignore it.
  const level = selected ? levelFor(wanted, selected) : wanted;
  const dirty =
    modelId !== (space.model?.modelId ?? '') || level !== (space.model?.thinkingLevel ?? 'default');

  const save = async (): Promise<void> => {
    // Nothing to store when the space follows the platform default model at its default effort.
    const model: SpaceModelRef | undefined =
      modelId || level !== 'default'
        ? {
            ...(modelId ? { modelId } : {}),
            ...(level === 'default' ? {} : { thinkingLevel: level }),
          }
        : undefined;
    const updated = await run(() => api.updateSpaceModel(space.id, model), {
      success: 'Model saved',
    });
    if (updated) {
      replaceSpace(updated);
      // Keep the control in step with what was stored (an unsupported level was cleared).
      setLevel(level);
    }
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
          Which model answers in this space. A conversation that is still active keeps the model it
          started with; new ones, and ones that have been idle for a while, use the new choice.
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
          {groupByProvider(options.data).map((group) => (
            <optgroup key={group.providerId} label={group.providerName}>
              {group.models.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.id === o.model ? o.id : `${o.id} · ${o.model}`}
                  {` · ${formatTokens(o.contextWindow)}`}
                  {o.isDefault ? ' · default' : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </Field>
      <div className='field'>
        <span className='field-label'>Thinking effort</span>
        {selected && selected.reasoningEfforts.length === 0 ? (
          <span className='field-hint'>
            {selected.model} does not support thinking effort; it answers without extended
            reasoning.
          </span>
        ) : (
          <>
            <Segmented<Level>
              label='Thinking effort'
              value={level}
              onChange={setLevel}
              options={[
                {
                  value: 'default',
                  label: selected?.defaultEffort
                    ? `Model default (${selected.defaultEffort})`
                    : 'Model default',
                },
                ...REASONING_EFFORTS.filter(
                  (e) => !selected || selected.reasoningEfforts.includes(e)
                ).map((e) => ({ value: e, label: e[0].toUpperCase() + e.slice(1) })),
              ]}
            />
            <span className='field-hint'>
              Higher effort answers better on hard problems but is slower and costs more.
            </span>
          </>
        )}
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

function InstructionsCard(): React.JSX.Element {
  const space = useSpace();
  const { run, pending } = useAction();
  const saved = space.instructions ?? '';
  const [text, setText] = useState(saved);
  const dirty = text.trim() !== saved;

  const save = async (): Promise<void> => {
    const updated = await run(() => api.updateSpace(space.id, { instructions: text }), {
      success: 'Instructions saved',
    });
    if (updated) {
      replaceSpace(updated);
      setText(updated.instructions ?? '');
    }
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
        <h3 className='card-title'>Instructions</h3>
        <p className='muted'>
          How the agent should work in this space: background, conventions, what to avoid. Read
          after the platform-wide instructions.
        </p>
      </div>
      <Field label='Space instructions' optional>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} />
      </Field>
      <Callout>
        A conversation keeps the instructions it started with. Edits apply to new conversations,
        including the first message after <code>/new</code>.
      </Callout>
      <div className='row'>
        <Button type='submit' variant='primary' loading={pending} disabled={!dirty}>
          Save instructions
        </Button>
        {dirty ? <Button onClick={() => setText(saved)}>Reset</Button> : null}
      </div>
    </form>
  );
}
