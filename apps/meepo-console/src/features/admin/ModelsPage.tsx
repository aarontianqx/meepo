// Platform admin: the model registry that spaces choose from.

import { useState } from 'react';

import { api } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { invalidate, useQuery } from '../../api/query';
import type { ModelEntry } from '../../api/types';
import { hostOf } from '../../lib/format';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Field, Input, Segmented } from '../../ui/Form';
import { EmptyState, ErrorState, ListSkeleton, Page, PageHeader } from '../../ui/Misc';
import { Modal, useConfirm } from '../../ui/Modal';
import { Icon } from '../../ui/Icon';
import { useAction } from '../../ui/useAction';

type Images = 'auto' | 'yes' | 'no';

function refresh(): void {
  invalidate(keys.models);
  invalidate(keys.modelOptions);
}

export function ModelsPage(): React.JSX.Element {
  const models = useQuery(keys.models, api.listModels);
  const confirm = useConfirm();
  const { run, pendingKey } = useAction();
  const [editing, setEditing] = useState<ModelEntry | 'new'>();

  const remove = async (model: ModelEntry): Promise<void> => {
    const ok = await confirm({
      title: `Delete ${model.id}?`,
      message: 'Spaces that selected this model will fail to run until they pick another one.',
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
          provider: model.provider,
          model: model.model,
          baseUrl: model.baseUrl,
          isDefault: true,
        }),
      { success: `${model.id} is now the default`, key: `def:${model.id}` }
    );
    if (done) refresh();
  };

  return (
    <div className='view'>
      <PageHeader
        title='Models'
        subtitle='Language models available to every space. API keys are stored encrypted and never shown again.'
        actions={
          <Button variant='primary' icon='plus' onClick={() => setEditing('new')}>
            Add model
          </Button>
        }
      />
      <Page>
        {models.error && !models.data ? (
          <ErrorState message={models.error} onRetry={() => void models.refresh()} />
        ) : !models.data ? (
          <ListSkeleton rows={3} />
        ) : models.data.length === 0 ? (
          <EmptyState
            icon='cpu'
            title='No models registered'
            action={
              <Button variant='primary' icon='plus' onClick={() => setEditing('new')}>
                Add the first model
              </Button>
            }
          >
            Agents cannot run until at least one model is available. Any OpenAI-compatible endpoint
            works.
          </EmptyState>
        ) : (
          <ul className='card admin-list'>
            {models.data.map((m) => (
              <li key={m.id} className='admin-row'>
                <span className='admin-icon'>
                  <Icon name='cpu' size={18} />
                </span>
                <div className='admin-main'>
                  <div className='admin-title'>
                    <strong className='truncate'>{m.id}</strong>
                    {m.isDefault ? (
                      <Badge tone='accent' size='sm'>
                        Default
                      </Badge>
                    ) : null}
                    {m.imageInput === true ? (
                      <Badge size='sm' icon='eye'>
                        Images
                      </Badge>
                    ) : null}
                  </div>
                  <div className='admin-sub'>
                    <span className='mono'>{m.model}</span>
                    <span className='faint'>·</span>
                    <span>{m.provider}</span>
                    <span className='faint'>·</span>
                    <span className='truncate' title={m.baseUrl}>
                      {hostOf(m.baseUrl)}
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
                  <Button size='sm' icon='pencil' onClick={() => setEditing(m)}>
                    Edit
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    icon='trash'
                    aria-label={`Delete ${m.id}`}
                    title={m.isDefault ? 'Choose another default first' : undefined}
                    disabled={m.isDefault}
                    loading={pendingKey === `del:${m.id}`}
                    onClick={() => void remove(m)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Page>
      {editing ? (
        <ModelModal
          model={editing === 'new' ? undefined : editing}
          first={models.data?.length === 0}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </div>
  );
}

function ModelModal({
  model,
  first,
  onClose,
}: {
  model: ModelEntry | undefined;
  first: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { run, pending } = useAction();
  const [id, setId] = useState(model?.id ?? '');
  const [name, setName] = useState(model?.model ?? '');
  const [provider, setProvider] = useState(model?.provider ?? 'openai-completions');
  const [baseUrl, setBaseUrl] = useState(model?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [images, setImages] = useState<Images>(
    model?.imageInput === true ? 'yes' : model?.imageInput === false ? 'no' : 'auto'
  );
  const [error, setError] = useState<string>();

  const submit = async (): Promise<void> => {
    if (!id.trim() || !name.trim() || !baseUrl.trim())
      return setError('Id, model name and base URL are required.');
    if (!model && !apiKey.trim()) return setError('An API key is required for a new model.');
    setError(undefined);
    const saved = await run(
      () =>
        api.saveModel({
          id: id.trim(),
          provider: provider.trim(),
          model: name.trim(),
          baseUrl: baseUrl.trim(),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          imageInput: images === 'auto' ? null : images === 'yes',
          ...(first ? { isDefault: true } : {}),
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
      title={model ? `Edit ${model.id}` : 'Add a model'}
      description='Any endpoint that speaks the OpenAI chat-completions protocol.'
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
          model ? 'Leave blank to keep the stored key.' : 'Stored encrypted and never shown again.'
        }
      >
        <Input
          type='password'
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete='new-password'
          placeholder={model ? '••••••••' : 'sk-…'}
        />
      </Field>
      <Field label='Provider label' hint='Shown in the console and usage reports.'>
        <Input value={provider} onChange={(e) => setProvider(e.target.value)} />
      </Field>
      <div className='field'>
        <span className='field-label'>Image input</span>
        <Segmented<Images>
          label='Image input'
          value={images}
          onChange={setImages}
          options={[
            { value: 'auto', label: 'Detect from name' },
            { value: 'yes', label: 'Supported' },
            { value: 'no', label: 'Not supported' },
          ]}
        />
      </div>
      {error ? (
        <div className='field-error' role='alert'>
          {error}
        </div>
      ) : null}
    </Modal>
  );
}
