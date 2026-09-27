import { useEffect, useRef, useState } from 'preact/hooks';
import type { Translate } from '../i18n/translator.js';
import type { CaptchaConfig } from '../transport/types.js';
import { Icon } from '../ui/icons.js';

/**
 * The CAPTCHA box above Start chat and Send message (ADR 0003). The provider
 * script is fetched at runtime and never bundled, and a script that does not
 * load fails visibly instead of leaving the button waiting.
 */
interface ProviderApi {
  render(element: HTMLElement, options: Record<string, unknown>): string | number;
}

const SCRIPTS: Record<CaptchaConfig['provider'], { url: string; global: string }> = {
  turnstile: {
    url: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
    global: 'turnstile',
  },
  hcaptcha: { url: 'https://js.hcaptcha.com/1/api.js?render=explicit', global: 'hcaptcha' },
};

const LOAD_TIMEOUT_MS = 15_000;
const loading = new Map<string, Promise<ProviderApi>>();

function loadProvider(provider: CaptchaConfig['provider']): Promise<ProviderApi> {
  const { url, global } = SCRIPTS[provider];
  const lookup = () => (window as unknown as Record<string, ProviderApi | undefined>)[global];

  const existing = loading.get(provider);
  if (existing) {
    return existing;
  }
  const promise = new Promise<ProviderApi>((resolve, reject) => {
    const ready = lookup();
    if (ready) {
      resolve(ready);
      return;
    }
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    const timer = setTimeout(() => reject(new Error('captcha timeout')), LOAD_TIMEOUT_MS);
    script.onload = () => {
      clearTimeout(timer);
      const api = lookup();
      api ? resolve(api) : reject(new Error('captcha api missing'));
    };
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error('captcha script failed'));
    };
    document.head.append(script);
  });
  loading.set(provider, promise);
  promise.catch(() => loading.delete(provider));
  return promise;
}

type Status = 'checking' | 'verified' | 'failed';

export default function Captcha({
  config,
  onToken,
  t,
}: {
  config: CaptchaConfig;
  onToken: (token: string | null) => void;
  t: Translate;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    let live = true;
    loadProvider(config.provider).then(
      (api) => {
        if (!live || !host.current) {
          return;
        }
        api.render(host.current, {
          sitekey: config.site_key,
          callback: (token: string) => {
            setStatus('verified');
            onToken(token);
          },
          'error-callback': () => {
            setStatus('failed');
            onToken(null);
          },
          'expired-callback': () => {
            setStatus('checking');
            onToken(null);
          },
        });
      },
      () => live && setStatus('failed'),
    );
    return () => {
      live = false;
    };
  }, [config.provider, config.site_key, onToken]);

  return (
    <fieldset class="hd-captcha">
      <legend class="hd-visually-hidden">{t('captcha.group')}</legend>
      <div ref={host} />
      <p
        class={`hd-captcha-status hd-captcha-${status}`}
        role={status === 'failed' ? 'alert' : undefined}
      >
        {status === 'verified' ? (
          <Icon name="shieldCheck" />
        ) : status === 'failed' ? (
          <Icon name="alert" />
        ) : null}
        {t(`captcha.${status}`)}
      </p>
    </fieldset>
  );
}
