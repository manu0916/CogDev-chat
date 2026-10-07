import { useEffect, useRef } from 'react';

declare global {
  interface Window {
    turnstile?: {
      render: (element: HTMLElement, options: Record<string, unknown>) => string;
      remove: (widgetId: string) => void;
      reset: (widgetId: string) => void;
    };
  }
}

type Props = {
  siteKey: string;
  onToken: (token: string) => void;
  onError: () => void;
  resetKey: number;
};

const SCRIPT_ID = 'cf-turnstile-script';

export function Turnstile({ siteKey, onToken, onError, resetKey }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<string | null>(null);
  const callbacksRef = useRef({ onToken, onError });
  callbacksRef.current = { onToken, onError };

  useEffect(() => {
    let disposed = false;
    const renderWidget = () => {
      if (disposed || !containerRef.current || !window.turnstile || widgetRef.current) return;
      try {
        widgetRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          action: 'quote_submit',
          theme: 'light',
          size: 'flexible',
          callback: (token: string) => callbacksRef.current.onToken(token),
          'expired-callback': () => callbacksRef.current.onToken(''),
          'error-callback': () => {
            callbacksRef.current.onToken('');
            callbacksRef.current.onError();
          },
          'timeout-callback': () => {
            callbacksRef.current.onToken('');
            callbacksRef.current.onError();
          },
        });
      } catch {
        callbacksRef.current.onToken('');
        callbacksRef.current.onError();
      }
    };

    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      if (window.turnstile) renderWidget();
      else existing.addEventListener('load', renderWidget, { once: true });
    } else {
      const script = document.createElement('script');
      script.id = SCRIPT_ID;
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.addEventListener('load', renderWidget, { once: true });
      script.addEventListener('error', () => callbacksRef.current.onError(), { once: true });
      document.head.appendChild(script);
    }

    return () => {
      disposed = true;
      if (widgetRef.current && window.turnstile) window.turnstile.remove(widgetRef.current);
      widgetRef.current = null;
    };
  }, [siteKey]);

  useEffect(() => {
    if (widgetRef.current && window.turnstile) {
      window.turnstile.reset(widgetRef.current);
      callbacksRef.current.onToken('');
    }
  }, [resetKey]);

  return <div ref={containerRef} className="turnstile" aria-label="Verificação de segurança" />;
}
