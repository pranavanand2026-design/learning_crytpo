import { useCallback, useEffect, useMemo, useState } from "react";

const SCRIPT_ID = "recaptcha-script";

const loadRecaptchaScript = (siteKey) =>
  new Promise((resolve, reject) => {
    if (!siteKey) {
      reject(new Error("Missing reCAPTCHA site key"));
      return;
    }

    if (window.grecaptcha?.enterprise && typeof window.grecaptcha.enterprise.ready === "function") {
      window.grecaptcha.enterprise.ready(() => resolve(window.grecaptcha.enterprise));
      return;
    }

    const existing = document.getElementById(SCRIPT_ID);
    if (existing) {
      existing.addEventListener("load", () => resolve(window.grecaptcha.enterprise));
      existing.addEventListener("error", () => reject(new Error("Failed to load reCAPTCHA")));
      return;
    }

    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.src = `https://www.google.com/recaptcha/enterprise.js?render=${siteKey}`;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.grecaptcha?.enterprise) {
        window.grecaptcha.enterprise.ready(() => resolve(window.grecaptcha.enterprise));
      } else {
        reject(new Error("reCAPTCHA did not initialise"));
      }
    };
    script.onerror = () => reject(new Error("Failed to load reCAPTCHA"));
    document.body.appendChild(script);
  });

export function useRecaptcha(siteKey) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let mounted = true;
    setReady(false);
    setError(null);

    loadRecaptchaScript(siteKey)
      .then(() => {
        if (mounted) setReady(true);
      })
      .catch((err) => {
        if (mounted) setError(err);
      });

    return () => {
      mounted = false;
      const script = document.getElementById(SCRIPT_ID);
      if (script) {
        script.parentNode?.removeChild(script);
      }
      const badge = document.querySelector('.grecaptcha-badge');
      if (badge?.parentNode) {
        badge.parentNode.removeChild(badge);
      }
      if (window.grecaptcha) {
        delete window.grecaptcha;
      }
    };
  }, [siteKey]);

  const execute = useCallback(
    async (action = "submit") => {
      if (!window.grecaptcha?.enterprise || !ready) return null;
      return window.grecaptcha.enterprise.execute(siteKey, { action });
    },
    [ready, siteKey]
  );

  return useMemo(
    () => ({ ready, error, execute }),
    [ready, error, execute]
  );
}
