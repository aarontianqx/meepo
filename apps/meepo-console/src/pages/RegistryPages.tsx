import { useState } from 'react';
import { request } from '../api/client';
import { usePolling } from '../hooks/usePolling';
import { ErrorBanner, Section } from '../components/common';
import { enc } from './ObservationPages';
interface Channel {
  id?: string;
  name: string;
  appId: string;
  appSecret?: string;
  spaceId: string;
  allowedOpenIds: string[];
  boundChatIds: string[];
}
interface Model {
  imageInput?: boolean;
  id: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  isDefault?: boolean;
}
export function ChannelsPage() {
  const channels = usePolling(() => request<Channel[]>('GET', '/api/channels'), 5000);
  const [draft, setDraft] = useState<Channel | null>(null),
    [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      channels.refresh();
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <>
      <h2>Channels</h2>
      <p className='muted'>
        Feishu application connections. Credentials are encrypted on the server.
      </p>
      <ErrorBanner error={error ?? channels.error} />
      <button
        onClick={() =>
          setDraft({
            name: '',
            appId: '',
            appSecret: '',
            spaceId: '',
            allowedOpenIds: [],
            boundChatIds: [],
          })
        }
      >
        Add channel
      </button>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Application</th>
            <th>Space</th>
            <th>Chats</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {channels.data?.map((c) => (
            <tr key={c.id}>
              <td>
                <button onClick={() => setDraft({ ...c, appSecret: '' })}>{c.name}</button>
              </td>
              <td>{c.appId}</td>
              <td>{c.spaceId}</td>
              <td>{c.boundChatIds.join(', ')}</td>
              <td>
                <button
                  className='danger'
                  onClick={() => {
                    if (confirm(`Disconnect ${c.name}?`))
                      void act(() => request('DELETE', `/api/channels/${enc(c.id!)}`));
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {draft && (
        <Section title={draft.id ? 'Edit channel' : 'New channel'}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await request(
                  draft.id ? 'PATCH' : 'POST',
                  draft.id ? `/api/channels/${enc(draft.id)}` : '/api/channels',
                  { ...draft, type: 'feishu' }
                );
                setDraft(null);
              });
            }}
          >
            <label>
              Name
              <input
                required
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label>
              Application ID
              <input
                required
                value={draft.appId}
                onChange={(e) => setDraft({ ...draft, appId: e.target.value })}
              />
            </label>
            <label>
              Application secret {draft.id ? '(leave blank to keep)' : ''}
              <input
                type='password'
                autoComplete='new-password'
                required={!draft.id}
                value={draft.appSecret}
                onChange={(e) => setDraft({ ...draft, appSecret: e.target.value })}
              />
            </label>
            <label>
              Space ID
              <input
                required
                value={draft.spaceId}
                onChange={(e) => setDraft({ ...draft, spaceId: e.target.value })}
              />
            </label>
            <label>
              Bound chat IDs (comma separated)
              <textarea
                value={draft.boundChatIds.join(',')}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    boundChatIds: e.target.value
                      .split(',')
                      .map((x) => x.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <label>
              Private chat allowlist (open IDs, comma separated)
              <textarea
                value={draft.allowedOpenIds.join(',')}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    allowedOpenIds: e.target.value
                      .split(',')
                      .map((x) => x.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <button>Save channel</button>
          </form>
        </Section>
      )}
    </>
  );
}
export function ModelsPage() {
  const models = usePolling(() => request<Model[]>('GET', '/api/models'), 5000);
  const [draft, setDraft] = useState<Model | null>(null),
    [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      models.refresh();
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <>
      <h2>Models</h2>
      <ErrorBanner error={error ?? models.error} />
      <button
        onClick={() =>
          setDraft({ id: '', provider: 'openai-completions', model: '', baseUrl: '', apiKey: '' })
        }
      >
        Add model
      </button>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Provider</th>
            <th>Model</th>
            <th>Default</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {models.data?.map((m) => (
            <tr key={m.id}>
              <td>
                <button onClick={() => setDraft({ ...m, apiKey: '' })}>{m.id}</button>
              </td>
              <td>{m.provider}</td>
              <td>{m.model}</td>
              <td>{m.isDefault ? 'Yes' : ''}</td>
              <td>
                <button
                  disabled={m.isDefault}
                  onClick={() => {
                    if (confirm(`Delete ${m.id}?`))
                      void act(() => request('DELETE', `/api/models/${enc(m.id)}`));
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {draft && (
        <Section title='Model configuration'>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await request('PUT', '/api/models', {
                  ...draft,
                  imageInput: draft.imageInput ?? null,
                });
                setDraft(null);
              });
            }}
          >
            <label>
              Registry ID
              <input
                required
                value={draft.id}
                onChange={(e) => setDraft({ ...draft, id: e.target.value })}
              />
            </label>
            <label>
              Provider
              <input
                required
                value={draft.provider}
                onChange={(e) => setDraft({ ...draft, provider: e.target.value })}
              />
            </label>
            <label>
              Model name
              <input
                required
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              />
            </label>
            <label>
              Base URL
              <input
                type='url'
                required
                value={draft.baseUrl}
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              />
            </label>
            <label>
              API key (leave blank to keep)
              <input
                type='password'
                autoComplete='new-password'
                value={draft.apiKey}
                onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              />
            </label>
            <label>
              <input
                type='checkbox'
                checked={!!draft.isDefault}
                onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })}
              />{' '}
              Server default
            </label>
            <label>
              Image input
              <select
                value={draft.imageInput === undefined ? 'auto' : String(draft.imageInput)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    imageInput: e.target.value === 'auto' ? undefined : e.target.value === 'true',
                  })
                }
              >
                <option value='auto'>Model default</option>
                <option value='true'>Supported</option>
                <option value='false'>Unsupported</option>
              </select>
            </label>
            <button>Save model</button>
          </form>
        </Section>
      )}
    </>
  );
}
