import { useCallback, useRef, useState } from 'preact/hooks';
import { acceptList, canAttach, checkFiles, kindOf, type PolicyProblem } from '../state/policy.js';
import { TransportError } from '../transport/types.js';
import { useLazy, useWidget, useWidgetState } from './context.js';
import { EMAIL_PATTERN, Field } from './Field.js';
import { Icon } from './icons.js';
import { loadCaptcha } from './lazy.js';
import { Sentence } from './Sentence.js';

/**
 * `WidgetModesEN` column 3 (M4-05): the contact form mode. It creates a
 * ticket answered by email and shows its reference in mono afterwards.
 */
export function ContactForm() {
  const { controller, t } = useWidget();
  const { config, availability } = useWidgetState();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<PolicyProblem | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ ref: string; email: string } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const onToken = useCallback((value: string | null) => setToken(value), []);
  const picker = useRef<HTMLInputElement>(null);
  const another = useRef<HTMLButtonElement>(null);
  const Captcha = useLazy(loadCaptcha, Boolean(config?.captcha));

  if (!config) {
    return null;
  }

  if (sent) {
    return (
      <div class="hd-body hd-form">
        <div role="status" class="hd-stack">
          <h3 class="hd-h3 hd-success-title">
            <Icon name="circleCheck" />
            {t('form.sentTitle')}
          </h3>
          <p>
            <Sentence
              id="form.sentBody"
              vars={{ ref: sent.ref, email: sent.email }}
              isolate={['ref', 'email']}
            />
          </p>
        </div>
        <button
          ref={another}
          type="button"
          class="hd-button hd-button-secondary hd-button-block"
          onClick={() => {
            setSent(null);
            setMessage('');
            setFiles([]);
            setFields({});
          }}
        >
          {t('form.another')}
        </button>
      </div>
    );
  }

  const choose = (event: Event) => {
    const picked = [...((event.currentTarget as HTMLInputElement).files ?? [])];
    const found = checkFiles(picked, config.content_policy);
    setProblem(found);
    if (!found) {
      setFiles(picked);
    }
  };

  const submit = async (event: Event) => {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (!name.trim()) {
      found.name = t('prechat.required');
    }
    if (!EMAIL_PATTERN.test(email.trim())) {
      found.email = t('prechat.invalidEmail');
    }
    for (const field of config.contact_form.fields) {
      if (field.required && !fields[field.key]?.trim()) {
        found[field.key] = t('prechat.required');
      }
    }
    if (!message.trim()) {
      found.message = t('prechat.required');
    }
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0 || busy) {
      return;
    }
    setBusy(true);
    try {
      const uploaded = await Promise.all(
        files.map((file) =>
          controller.transport.uploadAttachment(file, file.name, kindOf(file.type)),
        ),
      );
      const result = await controller.transport.submitContactForm({
        name: name.trim(),
        email: email.trim(),
        message: message.trim(),
        fields,
        attachment_ids: uploaded.map((attachment) => attachment.id),
        ...(token ? { captcha_token: token } : {}),
        ...(controller.articleId ? { article_id: controller.articleId } : {}),
      });
      setSent({ ref: result.ticket_ref, email: email.trim() });
      requestAnimationFrame(() => another.current?.focus());
    } catch (error) {
      setFormError(
        error instanceof TransportError && error.code === 'rate_limited'
          ? t('prechat.rateLimited')
          : error instanceof TransportError && error.code === 'captcha_failed'
            ? t('captcha.rejected')
            : t('form.failed'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="hd-body hd-form" aria-labelledby="hd-form-notice" onSubmit={submit} noValidate>
      <div class="hd-note" role="status">
        <Icon name="info" size={16} />
        <span id="hd-form-notice">
          {availability?.state === 'online' ? t('header.caption.form') : t('form.offline')}
        </span>
      </div>
      <Field
        id="hd-cf-name"
        label={t('prechat.name')}
        value={name}
        onInput={setName}
        autocomplete="name"
        required
        error={errors.name ?? null}
      />
      <Field
        id="hd-cf-email"
        label={t('prechat.email')}
        type="email"
        value={email}
        onInput={setEmail}
        autocomplete="email"
        required
        error={errors.email ?? null}
      />
      {config.contact_form.fields.map((field) => (
        <Field
          key={field.key}
          id={`hd-cf-field-${field.key}`}
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
        id="hd-cf-message"
        label={t('form.message')}
        type="textarea"
        value={message}
        onInput={setMessage}
        required
        error={errors.message ?? null}
      />
      {files.length > 0 ? (
        <ul class="hd-file-list">
          {files.map((file) => (
            <li key={file.name}>
              <Icon name="paperclip" size={14} />
              <bdi>{file.name}</bdi>
            </li>
          ))}
        </ul>
      ) : null}
      {problem ? (
        <p class="hd-alert hd-alert-danger" role="alert">
          <Icon name="alert" size={16} />
          <span>{t(problem.key, problem.vars)}</span>
        </p>
      ) : null}
      {config.captcha && Captcha ? (
        <Captcha config={config.captcha} onToken={onToken} t={t} />
      ) : null}
      {formError ? (
        <p class="hd-alert hd-alert-danger" role="alert">
          {formError}
        </p>
      ) : null}
      <div class="hd-inline">
        {canAttach(config.content_policy) ? (
          <>
            <button
              type="button"
              class="hd-button hd-button-secondary"
              onClick={() => picker.current?.click()}
            >
              <Icon name="paperclip" size={16} />
              {t('form.attach')}
            </button>
            <input
              ref={picker}
              type="file"
              class="hd-hidden"
              tabIndex={-1}
              aria-hidden="true"
              multiple={config.content_policy.max_attachments_per_message > 1}
              accept={acceptList(config.content_policy)}
              onChange={choose}
            />
          </>
        ) : null}
        <button
          type="submit"
          class="hd-button hd-button-primary hd-grow"
          disabled={busy || (Boolean(config.captcha) && !token)}
        >
          {t('form.submit')}
        </button>
      </div>
    </form>
  );
}
