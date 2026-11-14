// Platform admin: providers (endpoint + key, stored once) and the models they host.

import { MIN_CONTEXT_WINDOW, REASONING_EFFORTS, type ReasoningEffort } from '@meepo/protocol';
import { useState } from 'react';

import { api } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { invalidate, useQuery } from '../../api/query';
import type { ModelEntry, Provider } from '../../api/types';
import { hostOf } from '../../lib/format';
import { formatTokens, providerIdFor } from '../../lib/models';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Checkbox, Field, Input, Segmented } from '../../ui/Form';
import { Icon } from '../../ui/Icon';
import { EmptyState, ErrorState, ListSkeleton, Page, PageHeader } from '../../ui/Misc';
import { Modal, useConfirm } from '../../ui/Modal';
import { useAction } from '../../ui/useAction';

type Capabilities = 'suggest' | 'manual';

/** What the open dialog edits; a model is always created under (or stays with) its provider. */
type Editing =
  | { kind: 'provider'; provider: Provider | undefined }
  | { kind: 'model'; provider: Provider; model: ModelEntry | undefined };

const DEFAULT_KIND = 'openai-completions';

function refresh(): void {
  invalidate(keys.providers);
  invalidate(keys.models);
  invalidate(keys.modelOptions);
}

export function ModelsPage(): React.JSX.Element {
  const providers = useQuery(keys.providers, api.listProviders);
  const models = useQuery(keys.models, api.listModels);
  const [editing, setEditing] = useState<Editing>();
  const error = providers.error ?? models.error;
  const loaded =
    providers.data && models.data ? { providers: providers.data, models: models.data } : undefined;
  const retry = (): void => {
    void providers.refresh();
    void models.refresh();
  };

  return (
    <div className='view'>
      <PageHeader
        title='Models'
        subtitle='Providers hold an endpoint and API key once; each hosts the models spaces can choose. Keys are stored encrypted and never shown again.'
        actions={
          <Button
            variant='primary'
            icon='plus'
            onClick={() => setEditing({ kind: 'provider', provider: undefined })}
          >
            Add provider
          </Button>
        }
      />
      <Page>
        {error && !loaded ? (
          <ErrorState message={error} onRetry={retry} />
        ) : !loaded ? (
          <ListSkeleton rows={3} />
        ) : loaded.providers.length === 0 ? (
          <EmptyState
            icon='server'
            title='No providers yet'
            action={
              <Button
                variant='primary'
                icon='plus'
                onClick={() => setEditing({ kind: 'provider', provider: undefined })}
              >
                Add the first provider
              </Button>
            }
          >
            Agents cannot run until a provider has at least one model. Any OpenAI-compatible
            endpoint works.
          </EmptyState>
        ) : (
          <div className='stack'>
            {loaded.providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                models={loaded.models.filter((m) => m.providerId === provider.id)}
                totalModels={loaded.models.length}
                onEditProvider={() => setEditing({ kind: 'provider', provider })}
                onEditModel={(model) => setEditing({ kind: 'model', provider, model })}
              />
            ))}
          </div>
        )}
      </Page>
      {editing?.kind === 'provider' ? (
        <ProviderModal
          provider={editing.provider}
          existingIds={loaded?.providers.map((p) => p.id) ?? []}
          onClose={() => setEditing(undefined)}
        />
      ) : editing ? (
        <ModelModal
          provider={editing.provider}
          model={editing.model}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </div>
  );
}

function ProviderCard({
  provider,
  models,
  totalModels,
  onEditProvider,
  onEditModel,
}: {
  provider: Provider;
  models: ModelEntry[];
  /** Models across all providers: the last one may be deleted even while it is the default. */
  totalModels: number;
  onEditProvider: () => void;
  onEditModel: (model: ModelEntry | undefined) => void;
}): React.JSX.Element {
  const confirm = useConfirm();
  const { run, pendingKey } = useAction();

  const removeProvider = async (): Promise<void> => {
    const ok = await confirm({
      title: `Delete ${provider.name}?`,
      message: 'Its stored API key is removed. This cannot be undone.',
      confirmLabel: 'Delete provider',
      tone: 'danger',
    });
    if (!ok) return;
    const done = await run(() => api.deleteProvider(provider.id), {
      success: 'Provider deleted',
      key: `delp:${provider.id}`,
    });
    if (done) refresh();
  };

  const removeModel = async (model: ModelEntry): Promise<void> => {
    const ok = await confirm({
      title: `Delete ${model.id}?`,
      message:
        'A model that a space still uses cannot be deleted; those spaces must pick another one first.',
      confirmLabel: 'Delete model',
      tone: 'danger',
    });
    if (!ok) return;
    const done = await run(() => api.deleteModel(model.id), {
      success: 'Model deleted',
      key: `del:${model.id}`,
    });
    if (done) refresh();
  };

  const makeDefault = async (model: ModelEntry): Promise<void> => {
    const done = await run(
      () =>
        api.saveModel({
          id: model.id,
          providerId: model.providerId,
          model: model.model,
          isDefault: true,
        }),
      { success: `${model.id} is now the default`, key: `def:${model.id}` }
    );
    if (done) refresh();
  };

  const cannotDelete = (model: ModelEntry): boolean => model.isDefault && totalModels > 1;

  return (
    <section className='card'>
      <div className='card-head provider-head'>
        <span className='admin-icon'>
          <Icon name='server' size={18} />
        </span>
        <div className='admin-main'>
          <div className='admin-title'>
            <h3 className='truncate'>{provider.name}</h3>
            {provider.hasApiKey ? (
              <Badge size='sm' icon='key'>
                Key stored
              </Badge>
            ) : null}
          </div>
          <div className='admin-sub'>
            <span className='truncate' title={provider.baseUrl}>
              {hostOf(provider.baseUrl)}
            </span>
            <span className='faint'>·</span>
            <span className='mono'>{provider.kind}</span>
          </div>
        </div>
        <div className='row'>
          <Button size='sm' icon='plus' onClick={() => onEditModel(undefined)}>
            Add model
          </Button>
          <Button size='sm' icon='pencil' onClick={onEditProvider}>
            Edit provider
          </Button>
          <Button
            size='sm'
            variant='ghost'
            icon='trash'
            aria-label={`Delete ${provider.name}`}
            title={models.length > 0 ? 'Delete its models first' : undefined}
            disabled={models.length > 0}
            loading={pendingKey === `delp:${provider.id}`}
            onClick={() => void removeProvider()}
          />
        </div>
      </div>
      {models.length === 0 ? (
        <div className='card-body muted'>No models yet. Add one to make this provider usable.</div>
      ) : (
        <ul className='admin-list'>
          {models.map((m) => (
            <li key={m.id} className='admin-row'>
              <div className='admin-main'>
                <div className='admin-title'>
                  <strong className='truncate'>{m.id}</strong>
                  {m.isDefault ? (
                    <Badge tone='accent' size='sm'>
                      Default
                    </Badge>
                  ) : null}
                  {m.imageInput ? (
                    <Badge size='sm' icon='eye'>
                      Images
                    </Badge>
                  ) : null}
                </div>
                <div className='admin-sub'>
                  <span className='mono'>{m.model}</span>
                  <span className='faint'>·</span>
                  <span>
                    {formatTokens(m.contextWindow)} context · {formatTokens(m.maxTokens)} output
                  </span>
                  <span className='faint'>·</span>
                  <span>
                    {m.reasoningEfforts.length > 0
                      ? `Thinking ${m.reasoningEfforts.join(' / ')}`
                      : 'No thinking'}
                  </span>
                </div>
              </div>
              <div className='row'>
                {!m.isDefault ? (
                  <Button
                    size='sm'
                    variant='ghost'
                    loading={pendingKey === `def:${m.id}`}
                    onClick={() => void makeDefault(m)}
                  >
                    Make default
                  </Button>
                ) : null}
                <Button size='sm' icon='pencil' onClick={() => onEditModel(m)}>
                  Edit
                </Button>
                <Button
                  size='sm'
                  variant='ghost'
                  icon='trash'
                  aria-label={`Delete ${m.id}`}
                  title={cannotDelete(m) ? 'Choose another default first' : undefined}
                  disabled={cannotDelete(m)}
                  loading={pendingKey === `del:${m.id}`}
                  onClick={() => void removeModel(m)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProviderModal({
  provider,
  existingIds,
  onClose,
}: {
  provider: Provider | undefined;
  existingIds: string[];
  onClose: () => void;
}): React.JSX.Element {
  const { run, pending } = useAction();
  const [name, setName] = useState(provider?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [kind, setKind] = useState(provider?.kind ?? DEFAULT_KIND);
  const [error, setError] = useState<string>();

  const submit = async (): Promise<void> => {
    if (!name.trim() || !baseUrl.trim() || !kind.trim())
      return setError('Name, base URL and compatibility are required.');
    if (!provider && !apiKey.trim()) return setError('An API key is required for a new provider.');
    setError(undefined);
    const saved = await run(
      () =>
        api.saveProvider({
          id: provider?.id ?? providerIdFor(name, existingIds),
          name: name.trim(),
          kind: kind.trim(),
          baseUrl: baseUrl.trim(),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      { success: provider ? 'Provider updated' : 'Provider added' }
    );
    if (saved) {
      refresh();
      onClose();
    }
  };

  return (
    <Modal
      title={provider ? `Edit ${provider.name}` : 'Add a provider'}
      description='Any endpoint that speaks the OpenAI chat-completions protocol. Its models share this key.'
      onClose={onClose}
      locked={pending}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type='submit' variant='primary' loading={pending}>
            {provider ? 'Save' : 'Add provider'}
          </Button>
        </>
      }
    >
      <Field label='Name' hint='Shown to admins and in the space model picker.'>
        <Input value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
      </Field>
      <Field label='Base URL'>
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder='https://api.example.com/v1'
          type='url'
        />
      </Field>
      <Field
        label='API key'
        hint={
          provider
            ? 'Leave blank to keep the stored key. A new key applies to every model of this provider.'
            : 'Stored encrypted and never shown again.'
        }
      >
        <Input
          type='password'
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete='new-password'
          placeholder={provider ? '••••••••' : 'sk-…'}
        />
      </Field>
      <Field
        label='Compatibility'
        hint='Keep openai-completions unless the gateway needs vendor-specific handling (for example moonshotai or openrouter). It changes how requests are built.'
      >
        <Input value={kind} onChange={(e) => setKind(e.target.value)} mono />
      </Field>
      {error ? (
        <div className='field-error' role='alert'>
          {error}
        </div>
      ) : null}
    </Modal>
  );
}

function ModelModal({
  provider,
  model,
  onClose,
}: {
  provider: Provider;
  model: ModelEntry | undefined;
  onClose: () => void;
}): React.JSX.Element {
  const { run, pending } = useAction();
  const [id, setId] = useState(model?.id ?? '');
  const [name, setName] = useState(model?.model ?? '');
  // A new model can take its capabilities from the name; an existing one shows what is stored.
  const [capabilities, setCapabilities] = useState<Capabilities>(model ? 'manual' : 'suggest');
  const [contextWindow, setContextWindow] = useState(String(model?.contextWindow ?? 128_000));
  const [maxTokens, setMaxTokens] = useState(String(model?.maxTokens ?? 16_384));
  const [imageInput, setImageInput] = useState(model?.imageInput ?? false);
  const [efforts, setEfforts] = useState<ReasoningEffort[]>(model?.reasoningEfforts ?? []);
  const [defaultEffort, setDefaultEffort] = useState<ReasoningEffort | undefined>(
    model?.defaultEffort
  );
  const [error, setError] = useState<string>();

  const toggleEffort = (effort: ReasoningEffort, on: boolean): void => {
    const next = REASONING_EFFORTS.filter((e) => (e === effort ? on : efforts.includes(e)));
    setEfforts(next);
    // Keep the default among the supported strengths, preferring the strongest.
    if (!defaultEffort || !next.includes(defaultEffort)) setDefaultEffort(next[next.length - 1]);
  };

  const submit = async (): Promise<void> => {
    if (!id.trim() || !name.trim()) return setError('Id and model name are required.');
    const limits = { contextWindow: Number(contextWindow), maxTokens: Number(maxTokens) };
    if (capabilities === 'manual') {
      if (!Number.isInteger(limits.contextWindow) || limits.contextWindow < MIN_CONTEXT_WINDOW)
        return setError(
          `Context window must be a whole number of at least ${MIN_CONTEXT_WINDOW} tokens.`
        );
      if (!Number.isInteger(limits.maxTokens) || limits.maxTokens <= 0)
        return setError('Max output must be a positive whole number of tokens.');
      if (limits.maxTokens >= limits.contextWindow)
        return setError('Max output must be smaller than the context window.');
    }
    setError(undefined);
    const saved = await run(
      () =>
        api.saveModel({
          id: id.trim(),
          providerId: provider.id,
          model: name.trim(),
          ...(capabilities === 'manual'
            ? { ...limits, reasoningEfforts: efforts, defaultEffort, imageInput }
            : {}),
        }),
      { success: model ? 'Model updated' : 'Model added' }
    );
    if (saved) {
      refresh();
      onClose();
    }
  };

  return (
    <Modal
      title={model ? `Edit ${model.id}` : `Add a model to ${provider.name}`}
      description='Uses the endpoint and API key of its provider.'
      onClose={onClose}
      locked={pending}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type='submit' variant='primary' loading={pending}>
            {model ? 'Save' : 'Add model'}
          </Button>
        </>
      }
    >
      <div className='grid-2'>
        <Field
          label='Registry id'
          hint={model ? 'The id cannot change.' : 'The name spaces use to pick this model.'}
        >
          <Input
            value={id}
            onChange={(e) => setId(e.target.value)}
            disabled={Boolean(model)}
            data-autofocus={!model}
            mono
          />
        </Field>
        <Field label='Model name' hint='Sent to the API as the model parameter.'>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-autofocus={Boolean(model)}
            mono
          />
        </Field>
      </div>
      {model ? null : (
        <div className='field'>
          <span className='field-label'>Capabilities</span>
          <Segmented<Capabilities>
            label='Capabilities'
            value={capabilities}
            onChange={setCapabilities}
            options={[
              { value: 'suggest', label: 'Suggest from name' },
              { value: 'manual', label: 'Set manually' },
            ]}
          />
          {capabilities === 'suggest' ? (
            <span className='field-hint'>
              Known families (Kimi K, GPT-5.6) get their published limits, thinking efforts and
              image support; any other name starts as a 128k model without thinking or images. Edit
              the model afterwards to adjust.
            </span>
          ) : (
            <span className='field-hint'>
              The fields below start from a generic profile, not from the model name.
            </span>
          )}
        </div>
      )}
      {capabilities === 'manual' ? (
        <>
          <div className='grid-2'>
            <Field
              label='Context window'
              hint={`Tokens, at least ${MIN_CONTEXT_WINDOW}. Compaction starts at 80% of this.`}
            >
              <Input
                value={contextWindow}
                onChange={(e) => setContextWindow(e.target.value)}
                inputMode='numeric'
                mono
              />
            </Field>
            <Field label='Max output' hint='Tokens per response; below the context window.'>
              <Input
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
                inputMode='numeric'
                mono
              />
            </Field>
          </div>
          <div className='field'>
            <span className='field-label'>Thinking effort</span>
            <div className='row'>
              {REASONING_EFFORTS.map((effort) => (
                <Checkbox
                  key={effort}
                  checked={efforts.includes(effort)}
                  onChange={(on) => toggleEffort(effort, on)}
                  label={effort}
                />
              ))}
            </div>
            <span className='field-hint'>
              The strengths this model accepts. Select none for a model without extended reasoning.
            </span>
          </div>
          <div className='field'>
            <span className='field-label'>Image input</span>
            <Segmented<'yes' | 'no'>
              label='Image input'
              value={imageInput ? 'yes' : 'no'}
              onChange={(next) => setImageInput(next === 'yes')}
              options={[
                { value: 'yes', label: 'Supported' },
                { value: 'no', label: 'Not supported' },
              ]}
            />
            <span className='field-hint'>
              Images are sent to the model only when supported; otherwise a note replaces them.
            </span>
          </div>
          {efforts.length > 0 ? (
            <div className='field'>
              <span className='field-label'>Default effort</span>
              <Segmented<ReasoningEffort>
                label='Default effort'
                value={defaultEffort ?? efforts[efforts.length - 1]}
                onChange={setDefaultEffort}
                options={efforts.map((e) => ({ value: e, label: e }))}
              />
              <span className='field-hint'>Used when a space does not pick a strength.</span>
            </div>
          ) : null}
        </>
      ) : null}
      {error ? (
        <div className='field-error' role='alert'>
          {error}
        </div>
      ) : null}
    </Modal>
  );
}
