import { Icon } from './icons.js';

export interface FieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onInput: (value: string) => void;
  readonly type?: 'text' | 'email' | 'textarea';
  readonly hint?: string;
  readonly error?: string | null;
  readonly optionalLabel?: string;
  readonly autocomplete?: string;
  readonly required?: boolean;
}

/** DESIGN §6.1 Input and Textarea at the widget's lg size, with a hint or an error below. */
export function Field({
  id,
  label,
  value,
  onInput,
  type = 'text',
  hint,
  error,
  optionalLabel,
  autocomplete,
  required = false,
}: FieldProps) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  const shared = {
    id,
    value,
    required,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy,
    onInput: (event: Event) => onInput((event.currentTarget as HTMLInputElement).value),
  };

  return (
    <div class="hd-field">
      <label for={id}>
        {label}
        {optionalLabel ? <span class="hd-optional"> {optionalLabel}</span> : null}
      </label>
      {type === 'textarea' ? (
        <textarea {...shared} class="hd-input hd-textarea" rows={2} />
      ) : (
        <input
          {...shared}
          class="hd-input"
          type={type}
          autocomplete={autocomplete}
          dir={type === 'email' ? 'ltr' : undefined}
        />
      )}
      {error ? (
        <p id={`${id}-error`} class="hd-field-error" role="alert">
          <Icon name="alert" size={14} />
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} class="hd-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
