import {
  cloneElement,
  isValidElement,
  useId,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

import { Chip } from './Badge';

interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  /** A single form control; receives the generated id. */
  children: ReactElement<{ id?: string; 'aria-describedby'?: string }>;
}

/** Label + control + hint wrapper that wires `htmlFor`/`aria-describedby` automatically. */
export function Field({ label, hint, error, optional, children }: FieldProps): React.JSX.Element {
  const id = useId();
  const noteId = `${id}-note`;
  const control = isValidElement(children)
    ? cloneElement(children, {
        id: children.props.id ?? id,
        'aria-describedby': hint || error ? noteId : undefined,
      })
    : children;
  return (
    <div className='field'>
      <label className='field-label' htmlFor={children.props.id ?? id}>
        {label}
        {optional ? <span className='optional'>optional</span> : null}
      </label>
      {control}
      {error ? (
        <span className='field-error' id={noteId} role='alert'>
          {error}
        </span>
      ) : hint ? (
        <span className='field-hint' id={noteId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function Input({
  mono,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }): React.JSX.Element {
  return <input className={`input ${mono ? 'input-mono' : ''} ${className ?? ''}`} {...rest} />;
}

export function Textarea({
  mono,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }): React.JSX.Element {
  return (
    <textarea className={`textarea ${mono ? 'textarea-mono' : ''} ${className ?? ''}`} {...rest} />
  );
}

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <select className={`select ${className ?? ''}`} {...rest}>
      {children}
    </select>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type='button'
      role='switch'
      className='switch'
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
}): React.JSX.Element {
  return (
    <label className='check'>
      <input type='checkbox' checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className='check-label'>{label}</span>
        {hint ? (
          <span className='field-hint' style={{ display: 'block' }}>
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export function Radio({
  name,
  checked,
  onSelect,
  label,
  hint,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  label: ReactNode;
  hint?: ReactNode;
}): React.JSX.Element {
  return (
    <label className='check'>
      <input type='radio' name={name} checked={checked} onChange={onSelect} />
      <span>
        <span className='check-label'>{label}</span>
        {hint ? (
          <span className='field-hint' style={{ display: 'block' }}>
            {hint}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (next: T) => void;
  label: string;
}): React.JSX.Element {
  return (
    <div className='segmented' role='group' aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type='button'
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count !== undefined ? <span className='count'>{option.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Free-text list editor: Enter / comma / blur commits, Backspace on empty removes the last. */
export function TagInput({
  value,
  onChange,
  placeholder,
  mono,
  id,
  validate,
  'aria-describedby': describedBy,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  mono?: boolean;
  id?: string;
  /** Return an error message to reject a tag. */
  validate?: (tag: string) => string | undefined;
  'aria-describedby'?: string;
}): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string>();

  const commit = (raw: string): void => {
    const parts = raw
      .split(/[,\n]/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length === 0) return;
    const next = [...value];
    for (const part of parts) {
      const error = validate?.(part);
      if (error) {
        setProblem(error);
        return;
      }
      if (!next.includes(part)) next.push(part);
    }
    setProblem(undefined);
    setDraft('');
    onChange(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      commit(draft);
    } else if (event.key === 'Backspace' && draft === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div>
      <div className='tag-input'>
        {value.map((tag) => (
          <Chip key={tag} mono={mono} onRemove={() => onChange(value.filter((t) => t !== tag))}>
            {tag}
          </Chip>
        ))}
        <input
          id={id}
          aria-describedby={describedBy}
          value={draft}
          placeholder={value.length === 0 ? placeholder : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            setProblem(undefined);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => commit(draft)}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            if (/[,\n]/.test(text)) {
              e.preventDefault();
              commit(text);
            }
          }}
        />
      </div>
      {problem ? <span className='field-error'>{problem}</span> : null}
    </div>
  );
}
