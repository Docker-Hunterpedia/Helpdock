import { useCallback, useState } from 'preact/hooks';
import { TransportError } from '../transport/types.js';
import { useLazy, useWidget, useWidgetState } from './context.js';
import { EMAIL_PATTERN, Field } from './Field.js';
import { loadCaptcha } from './lazy.js';

/** `WidgetStatesEN` column 1: the pre-chat form (M4-08), with the CAPTCHA box when the brand turns it on. */
export function PreChat() {
  const { controller, t } = useWidget();
  const { config } = useWidgetState();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const onToken = useCallback((value: string | null) => setToken(value), []);
  const Captcha = useLazy(loadCaptcha, Boolean(config?.captcha));

  if (!config) {
    return null;
  }

  const validate = (): Record<string, string> => {
    const problems: Record<string, string> = {};
    if (!name.trim()) {
      problems.name = t('prechat.required');
    }
    if (!EMAIL_PATTERN.test(email.trim())) {
      problems.email = t('prechat.invalidEmail');
    }
    for (const field of config.pre_chat.fields) {
      if (field.required && !fields[field.key]?.trim()) {
        problems[field.key] = t('prechat.required');
      }
    }
    if (!message.trim()) {
      problems.message = t('prechat.required');
    }
    return problems;
  };

  const submit = async (event: Event) => {
    event.preventDefault();
    const problems = validate();
    setErrors(problems);
    setFormError(null);
    if (Object.keys(problems).length > 0 || busy) {
      return;
    }
    setBusy(true);
    try {
      await controller.startConversation({
        name: name.trim(),
        email: email.trim(),
        fields,
        ...(token ? { captcha_token: token } : {}),
      });
      controller.send(message);
    } catch (error) {
      setFormError(
        error instanceof TransportError && error.code === 'rate_limited'
          ? t('prechat.rateLimited')
          : error instanceof TransportError && error.code === 'captcha_failed'
            ? t('captcha.rejected')
            : t('prechat.failed'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="hd-body hd-form" aria-labelledby="hd-prechat-title" onSubmit={submit} noValidate>
      <h3 id="hd-prechat-title" class="hd-h3">
        {t('prechat.title')}
      </h3>
      <Field
        id="hd-pc-name"
        label={t('prechat.name')}
        value={name}
        onInput={setName}
        autocomplete="name"
        required
        error={errors.name ?? null}
      />
      <Field
        id="hd-pc-email"
        label={t('prechat.email')}
        type="email"
        value={email}
        onInput={setEmail}
        autocomplete="email"
        required
        hint={t('prechat.emailHint')}
        error={errors.email ?? null}
      />
      {config.pre_chat.fields.map((field) => (
        <Field
          key={field.key}
          id={`hd-pc-field-${field.key}`}
          label={field.label}
          type={field.type}
          value={fields[field.key] ?? ''}
          onInput={(value) => setFields({ ...fields, [field.key]: value })}
          required={field.required}
          {...(field.required ? {} : { optionalLabel: t('prechat.optional') })}
          error={errors[field.key] ?? null}
        />
      ))}
      <Field
        id="hd-pc-message"
        label={t('prechat.message')}
        type="textarea"
        value={message}
        onInput={setMessage}
        required
        error={errors.message ?? null}
      />
      {config.captcha && Captcha ? (
        <Captcha config={config.captcha} onToken={onToken} t={t} />
      ) : null}
      {formError ? (
        <p class="hd-alert hd-alert-danger" role="alert">
          {formError}
        </p>
      ) : null}
      <button
        type="submit"
        class="hd-button hd-button-primary hd-button-block"
        disabled={busy || (Boolean(config.captcha) && !token)}
      >
        {t('prechat.submit')}
      </button>
    </form>
  );
}
