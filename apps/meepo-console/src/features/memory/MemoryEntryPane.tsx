// Memory entry detail: read, edit with unsaved-draft safety, and explicit conflict recovery.

import { useEffect, useState } from 'react';

import { ApiError, errorMessage } from '../../api/client';
import { api } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { invalidate, setQueryData, useQuery } from '../../api/query';
import type { MemoryEntry, MemoryMeta } from '../../api/types';
import { navigate, spaceHref } from '../../app/router';
import { absoluteTime } from '../../lib/format';
import {
  NEW_ENTRY,
  MEMORY_CONTENT_MAX_BYTES,
  MEMORY_DESCRIPTION_MAX,
  MEMORY_KEYWORDS_MAX,
  MEMORY_KEYWORD_MAX_CHARS,
  byteLength,
  validateMemoryPath,
  writerLabel,
} from '../../lib/memory';
import { Chip } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Field, Input, Segmented, Switch, TagInput, Textarea } from '../../ui/Form';
import { Icon } from '../../ui/Icon';
import { Markdown } from '../../ui/Markdown';
import { Callout, CopyButton, ErrorState, ListSkeleton, Time } from '../../ui/Misc';
import { useConfirm } from '../../ui/Modal';
import { useToast } from '../../ui/Toast';

/** Unsaved edits for one entry; `baseRevision` is the revision the edit started from. */
export interface MemoryDraft {
  path: string;
  description: string;
  keywords: string[];
  pinned: boolean;
  content: string;
  baseRevision: number;
}

interface Props {
  spaceId: string;
  /** Entry path, or `_new` for the creation form. */
  path: string;
  meta: { revision: number } | undefined;
  loadingList: boolean;
  draft: MemoryDraft | undefined;
  onDraft: (draft: MemoryDraft | undefined) => void;
  prefillPath: string;
  existingPaths: string[];
}

export function MemoryEntryPane(props: Props): React.JSX.Element {
  // The creation form is always an edit; existing entries switch into edit mode through a draft.
  if (props.path === NEW_ENTRY) {
    return (
      <EditForm
        {...props}
        draft={
          props.draft ?? {
            path: props.prefillPath,
            description: '',
            keywords: [],
            pinned: false,
            content: '',
            baseRevision: 0,
          }
        }
        isNew
        original={undefined}
      />
    );
  }
  return <ExistingEntry key={props.path} {...props} />;
}

function draftOf(entry: MemoryEntry): MemoryDraft {
  return {
    path: entry.path,
    description: entry.description,
    keywords: entry.keywords,
    pinned: entry.pinned,
    content: entry.content,
    baseRevision: entry.revision,
  };
}

function differs(draft: MemoryDraft, entry: MemoryEntry): boolean {
  return (
    draft.description !== entry.description ||
    draft.content !== entry.content ||
    draft.pinned !== entry.pinned ||
    draft.keywords.join('\n') !== entry.keywords.join('\n')
  );
}

function ExistingEntry(props: Props): React.JSX.Element {
  const { spaceId, path, meta, draft } = props;
  const confirm = useConfirm();
  const toast = useToast();
  const entryKey = `${keys.memory(spaceId)}:entry:${path}`;
  const entry = useQuery(entryKey, () => api.readMemory(spaceId, path));
  const [busy, setBusy] = useState<'pin' | 'delete'>();
  // Editing only reaches the page-level draft once something actually changes.
  const [editing, setEditing] = useState(false);

  // Another writer (usually the agent) saved a newer revision: reload the read-only view.
  useEffect(() => {
    if (entry.data && meta && meta.revision !== entry.data.revision && !entry.fetching)
      void entry.refresh();
  }, [entry, meta]);

  if (entry.error && !entry.data)
    return (
      <div style={{ padding: 20 }}>
        <ErrorState message={entry.error} onRetry={() => void entry.refresh()} />
      </div>
    );
  if (!entry.data) return <ListSkeleton rows={5} />;
  const data = entry.data;

  if (draft || editing)
    return (
      <EditForm
        {...props}
        draft={draft ?? draftOf(data)}
        isNew={false}
        original={data}
        onClose={() => setEditing(false)}
      />
    );

  const writer = writerLabel(data.updatedBy);
  const writerLink = writer.link
    ? writer.link.kind === 'ticket'
      ? spaceHref(spaceId, 'tickets', writer.link.id)
      : spaceHref(spaceId, 'conversations', writer.link.id)
    : undefined;

  const startEdit = (): void => setEditing(true);

  const togglePin = async (): Promise<void> => {
    setBusy('pin');
    try {
      await api.writeMemory(spaceId, data.path, {
        description: data.description,
        content: data.content,
        keywords: data.keywords,
        pinned: !data.pinned,
        expected_revision: data.revision,
      });
      invalidate(keys.memory(spaceId));
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(undefined);
    }
  };

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Delete this note?',
      message: (
        <>
          The agent will no longer see <code>{data.path}</code>. There is no undo.
        </>
      ),
      confirmLabel: 'Delete note',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy('delete');
    try {
      await api.deleteMemory(spaceId, data.path, data.revision);
      toast.success('Note deleted');
      invalidate(keys.memory(spaceId));
      navigate(spaceHref(spaceId, 'memory'));
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className='detail-scroll'>
      <div className='detail-head'>
        <a className='back-link only-mobile' href={spaceHref(spaceId, 'memory')}>
          <Icon name='arrowLeft' size={13} /> Notes
        </a>
        <div className='detail-head-row'>
          <div className='detail-head-text'>
            <h2 className='mono truncate'>{data.path}</h2>
            <div className='detail-head-sub'>{data.description}</div>
          </div>
          <div className='row'>
            <CopyButton text={data.path} label='' variant='ghost' size='sm' />
            <Button
              size='sm'
              variant='ghost'
              icon='star'
              aria-pressed={data.pinned}
              title={data.pinned ? 'Unpin' : 'Pin to the top of the map and search'}
              loading={busy === 'pin'}
              onClick={() => void togglePin()}
            >
              {data.pinned ? 'Pinned' : 'Pin'}
            </Button>
            <Button
              size='sm'
              variant='danger'
              icon='trash'
              loading={busy === 'delete'}
              onClick={() => void remove()}
            >
              Delete
            </Button>
            <Button size='sm' variant='primary' icon='pencil' onClick={startEdit}>
              Edit
            </Button>
          </div>
        </div>
      </div>
      <div className='detail-body'>
        <div className='mem-meta'>
          {data.keywords.map((k) => (
            <Chip key={k} mono>
              {k}
            </Chip>
          ))}
          <span className='faint' title={absoluteTime(data.updatedAt)}>
            Revision {data.revision} · updated <Time at={data.updatedAt} /> by{' '}
            {writerLink ? <a href={writerLink}>{writer.text}</a> : writer.text}
          </span>
        </div>
        <article className='card card-pad'>
          {data.content.trim() ? (
            <Markdown source={data.content} />
          ) : (
            <span className='muted'>This note is empty.</span>
          )}
        </article>
      </div>
    </div>
  );
}

type Conflict = { currentRevision: number | undefined; latest?: MemoryEntry; loading?: boolean };

function EditForm({
  spaceId,
  path,
  draft,
  onDraft,
  isNew,
  original,
  existingPaths,
  onClose,
}: Props & {
  draft: MemoryDraft;
  isNew: boolean;
  original: MemoryEntry | undefined;
  /** Leaves edit mode after a save or discard (existing notes only). */
  onClose?: () => void;
}): React.JSX.Element {
  const toast = useToast();
  const [value, setValue] = useState<MemoryDraft>(draft);
  const [tab, setTab] = useState<'write' | 'preview'>('write');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState<Conflict>();

  // Mirror edits into the page-level draft so they survive navigating to another note.
  const update = (patch: Partial<MemoryDraft>): void => {
    const next = { ...value, ...patch };
    setValue(next);
    // Reverting every change back to the stored note leaves nothing unsaved.
    onDraft(original && !differs(next, original) ? undefined : next);
  };

  const pathProblem = isNew
    ? (validateMemoryPath(value.path) ??
      (existingPaths.includes(value.path) ? 'A note with this path already exists.' : undefined))
    : undefined;
  const bytes = byteLength(value.content);
  const descriptionProblem = !value.description.trim()
    ? 'Add a one-line description so the agent knows when to use this note.'
    : value.description.length > MEMORY_DESCRIPTION_MAX
      ? `Keep it under ${MEMORY_DESCRIPTION_MAX} characters.`
      : /[\r\n]/.test(value.description)
        ? 'Use a single line.'
        : undefined;
  const tooLarge = bytes > MEMORY_CONTENT_MAX_BYTES;
  const dirty = isNew || !original || differs(value, original);
  const canSave =
    !pathProblem && !descriptionProblem && !tooLarge && dirty && (!isNew || value.path.length > 0);

  /** Saves `source` (the current draft unless a conflict choice supplies a rebased one). */
  const save = async (source: MemoryDraft = value): Promise<void> => {
    setSaving(true);
    setError(undefined);
    const target = isNew ? source.path : path;
    try {
      const saved = await api.writeMemory(spaceId, target, {
        description: source.description.trim(),
        content: source.content,
        keywords: source.keywords,
        pinned: source.pinned,
        expected_revision: source.baseRevision,
      });
      // Show the new revision immediately instead of waiting for the next list poll.
      setQueryData<MemoryMeta[]>(keys.memory(spaceId), (list) => [
        ...(list ?? []).filter((e) => e.path !== saved.path),
        saved,
      ]);
      onDraft(undefined);
      onClose?.();
      toast.success(isNew ? 'Note created' : 'Note saved');
      invalidate(keys.memory(spaceId));
      if (isNew) navigate(spaceHref(spaceId, 'memory', target));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'revision_conflict')
        setConflict({ currentRevision: err.currentRevision });
      else setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const reviewLatest = async (): Promise<void> => {
    setConflict((c) => ({ ...c, currentRevision: c?.currentRevision, loading: true }));
    try {
      const latest = await api.readMemory(spaceId, isNew ? value.path : path);
      setConflict({ currentRevision: latest.revision, latest });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // Deleted since we started editing: revision 0 is what the server reports for a missing note.
        setConflict({ currentRevision: 0 });
      } else {
        setConflict(undefined);
        setError(errorMessage(err));
      }
    }
  };

  /** Writes the draft over whatever is stored now: rebase it onto `revision`, then save. */
  const overwrite = (revision: number): void => {
    const rebased = { ...value, baseRevision: revision };
    setValue(rebased);
    onDraft(rebased);
    setConflict(undefined);
    void save(rebased);
  };

  /** Drops the draft in favour of the version someone else saved. */
  const takeLatest = (latest: MemoryEntry): void => {
    setValue(draftOf(latest));
    onDraft(undefined);
    setConflict(undefined);
    invalidate(keys.memory(spaceId));
    onClose?.();
  };

  const discard = (): void => {
    onDraft(undefined);
    onClose?.();
    if (isNew) navigate(spaceHref(spaceId, 'memory'));
    else invalidate(keys.memory(spaceId));
  };

  return (
    <form
      className='detail-scroll'
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave && !saving) void save();
      }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 's') {
          event.preventDefault();
          if (canSave && !saving) void save();
        }
      }}
    >
      <div className='detail-head'>
        <div className='detail-head-row'>
          <div className='detail-head-text'>
            <h2>{isNew ? 'New note' : `Editing ${path}`}</h2>
            <div className='detail-head-sub'>
              {isNew
                ? 'Write something the agent should remember.'
                : 'Changes are saved only when you press Save.'}
            </div>
          </div>
          <div className='row'>
            <Button onClick={discard} disabled={saving}>
              {isNew ? 'Cancel' : 'Discard changes'}
            </Button>
            <Button
              type='submit'
              variant='primary'
              icon='save'
              loading={saving}
              disabled={!canSave}
            >
              Save
            </Button>
          </div>
        </div>
      </div>

      <div className='detail-body'>
        {conflict && conflict.currentRevision === 0 ? (
          <Callout
            tone='warn'
            title='This note was deleted while you were editing'
            action={
              <Button size='sm' variant='primary' loading={saving} onClick={() => overwrite(0)}>
                Save my draft as a new note
              </Button>
            }
          >
            Someone else (or the agent) removed it. Your draft is untouched below; you can recreate
            the note from it or discard the draft.
          </Callout>
        ) : conflict ? (
          <Callout
            tone='warn'
            title='This note changed while you were editing'
            action={
              conflict.latest ? (
                <div className='row'>
                  <Button size='sm' onClick={() => takeLatest(conflict.latest as MemoryEntry)}>
                    Use latest
                  </Button>
                  <Button
                    size='sm'
                    variant='primary'
                    loading={saving}
                    onClick={() => overwrite((conflict.latest as MemoryEntry).revision)}
                  >
                    Overwrite with my draft
                  </Button>
                </div>
              ) : (
                <Button size='sm' loading={conflict.loading} onClick={() => void reviewLatest()}>
                  Review latest
                </Button>
              )
            }
          >
            Someone else (or the agent) saved revision {conflict.currentRevision ?? 'a newer one'}.
            Your draft is untouched below; nothing was overwritten.
            {conflict.latest ? (
              <details>
                <summary>Latest version</summary>
                <p>{conflict.latest.description}</p>
                <pre>{conflict.latest.content}</pre>
              </details>
            ) : null}
          </Callout>
        ) : null}
        {error ? (
          <Callout tone='danger' title='Could not save'>
            {error}
          </Callout>
        ) : null}

        {isNew ? (
          <Field
            label='Path'
            hint='Folders and a note name separated by “/”; lowercase letters, digits, “-” and “_”.'
            error={value.path ? pathProblem : undefined}
          >
            <Input
              mono
              value={value.path}
              onChange={(e) => update({ path: e.target.value.trim() })}
              data-autofocus
            />
          </Field>
        ) : null}
        <Field
          label='Description'
          hint={`${value.description.length}/${MEMORY_DESCRIPTION_MAX}. Shown in the agent's map of notes.`}
          error={value.description ? descriptionProblem : undefined}
        >
          <Input
            value={value.description}
            onChange={(e) => update({ description: e.target.value })}
            maxLength={MEMORY_DESCRIPTION_MAX + 20}
          />
        </Field>
        <div className='grid-2'>
          <Field
            label='Keywords'
            optional
            hint={`Up to ${MEMORY_KEYWORDS_MAX}. They help search and the map.`}
          >
            <TagInput
              value={value.keywords}
              onChange={(keywords) => update({ keywords: keywords.slice(0, MEMORY_KEYWORDS_MAX) })}
              validate={(tag) =>
                tag.length > MEMORY_KEYWORD_MAX_CHARS
                  ? `Keep keywords under ${MEMORY_KEYWORD_MAX_CHARS} characters.`
                  : undefined
              }
              placeholder='Add a keyword'
              mono
            />
          </Field>
          <div className='field'>
            <span className='field-label'>Pinned</span>
            <div className='row' style={{ minHeight: 34 }}>
              <Switch
                checked={value.pinned}
                onChange={(pinned) => update({ pinned })}
                label='Pinned'
              />
              <span className='field-hint'>Pinned notes lead the map and search results.</span>
            </div>
          </div>
        </div>

        <div className='field'>
          <div className='row'>
            <span className='field-label' style={{ margin: 0 }}>
              Content (Markdown)
            </span>
            <span className='spacer' />
            <span className={tooLarge ? 'field-error' : 'faint'} style={{ fontSize: 12 }}>
              {(bytes / 1024).toFixed(1)} / {MEMORY_CONTENT_MAX_BYTES / 1024} KiB
            </span>
            <Segmented
              label='Editor mode'
              value={tab}
              onChange={setTab}
              options={[
                { value: 'write', label: 'Write' },
                { value: 'preview', label: 'Preview' },
              ]}
            />
          </div>
          {tab === 'write' ? (
            <Textarea
              mono
              className='mem-editor'
              value={value.content}
              onChange={(e) => update({ content: e.target.value })}
              spellCheck={false}
            />
          ) : (
            <div className='card card-pad mem-preview'>
              {value.content.trim() ? (
                <Markdown source={value.content} />
              ) : (
                <span className='muted'>Nothing to preview yet.</span>
              )}
            </div>
          )}
        </div>
      </div>
    </form>
  );
}
