'use client';

import { useEffect } from 'react';

/**
 * Syncs :user-invalid with ARIA aria-invalid / dynamic aria-describedby
 * and provides fallback interaction tracking on older engines.
 */
export function FormValidationSync() {
  useEffect(() => {
    const announcer = document.createElement('div');
    announcer.setAttribute('aria-live', 'polite');
    announcer.classList.add('visually-hidden');
    document.body.append(announcer);

    let announceTimer: ReturnType<typeof setTimeout> | undefined;
    let announcedField: Element | null = null;
    const flagged = new WeakSet<Element>();
    const announced = new WeakSet<Element>();

    const linkError = (el: HTMLElement, shown: boolean) => {
      const errorId = el.dataset.error;
      if (!errorId) return;
      const ids = (el.getAttribute('aria-describedby') || '')
        .split(/\s+/)
        .filter((id) => id && id !== errorId);
      if (shown) ids.push(errorId);
      if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
      else el.removeAttribute('aria-describedby');
    };

    const spokenText = (node: HTMLElement): string => {
      const copy = node.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
      copy
        .querySelectorAll('[role="img"][aria-label]')
        .forEach((n) => n.replaceWith(`${n.getAttribute('aria-label')}: `));
      return (copy.textContent || '').replace(/\s+/g, ' ').trim();
    };

    const announceError = (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) => {
      const errorId = el.dataset.error;
      if (!errorId) return;
      const errorEl = document.getElementById(errorId);
      if (!errorEl) return;
      const label = el.labels?.[0] ? `${spokenText(el.labels[0])}: ` : '';
      clearTimeout(announceTimer);
      announcer.textContent = '';
      announcedField = el;
      announceTimer = setTimeout(() => {
        announcer.textContent = label + spokenText(errorEl);
      }, 500);
    };

    const supportsUserInvalid =
      typeof CSS !== 'undefined' &&
      typeof CSS.supports === 'function' &&
      CSS.supports('selector(:user-invalid)');

    const supportsHas =
      typeof CSS !== 'undefined' &&
      typeof CSS.supports === 'function' &&
      CSS.supports('selector(:has(a))');

    const syncAria = (el: Element | null, announce = false) => {
      if (
        !(
          el instanceof HTMLInputElement ||
          el instanceof HTMLSelectElement ||
          el instanceof HTMLTextAreaElement
        )
      ) {
        return;
      }
      const invalid = supportsUserInvalid
        ? el.matches(':user-invalid')
        : el.classList.contains('user-invalid-fallback');
      const fieldWrapper = el.closest('.form-field');
      if (invalid) {
        if (announce && !announced.has(el)) {
          announceError(el);
          announced.add(el);
        }
        el.setAttribute('aria-invalid', 'true');
        linkError(el, true);
        if (!supportsHas) {
          fieldWrapper?.classList.add('has-error-fallback');
        }
        flagged.add(el);
      } else if (flagged.has(el) || el.getAttribute('aria-invalid') !== 'true') {
        el.setAttribute('aria-invalid', 'false');
        linkError(el, false);
        fieldWrapper?.classList.remove('has-error-fallback');
        flagged.delete(el);
        announced.delete(el);
        if (announcedField === el) {
          clearTimeout(announceTimer);
          announcer.textContent = '';
        }
      }
    };

    document
      .querySelectorAll('input, select, textarea')
      .forEach((el) => syncAria(el));

    const dirtyState = new WeakMap<Element, { hasInteracted: boolean; hasBlurred: boolean }>();

    const onBlur = (e: Event) => {
      const target = e.target as Element | null;
      if (!supportsUserInvalid && target && 'checkValidity' in target) {
        const state = dirtyState.get(target) || { hasInteracted: false, hasBlurred: false };
        state.hasBlurred = true;
        dirtyState.set(target, state);
        if (state.hasInteracted) {
          const valid = (target as HTMLInputElement).validity.valid;
          target.classList.toggle('user-invalid-fallback', !valid);
        }
      }
      syncAria(target, true);
    };

    const onInput = (e: Event) => {
      const target = e.target as Element | null;
      if (!supportsUserInvalid && target && 'checkValidity' in target) {
        const state = dirtyState.get(target) || { hasInteracted: false, hasBlurred: false };
        state.hasInteracted = true;
        dirtyState.set(target, state);
        if (state.hasBlurred) {
          const valid = (target as HTMLInputElement).validity.valid;
          target.classList.toggle('user-invalid-fallback', !valid);
        }
      }
      if (target?.hasAttribute('aria-invalid')) {
        syncAria(target);
      }
    };

    const onChange = (e: Event) => syncAria(e.target as Element | null, true);

    const onInvalid = (e: Event) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (!supportsUserInvalid) {
        dirtyState.set(target, { hasInteracted: true, hasBlurred: true });
        target.classList.add('user-invalid-fallback');
      }
      announced.add(target);
      syncAria(target);
    };

    const onReset = (e: Event) => {
      const form = e.target as HTMLFormElement | null;
      if (!form) return;
      setTimeout(() => {
        for (const el of Array.from(form.elements)) {
          dirtyState.delete(el);
          el.classList.remove('user-invalid-fallback');
          syncAria(el);
        }
      });
    };

    document.addEventListener('blur', onBlur, true);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onChange, true);
    document.addEventListener('invalid', onInvalid, true);
    document.addEventListener('reset', onReset, true);

    return () => {
      clearTimeout(announceTimer);
      document.removeEventListener('blur', onBlur, true);
      document.removeEventListener('input', onInput);
      document.removeEventListener('change', onChange, true);
      document.removeEventListener('invalid', onInvalid, true);
      document.removeEventListener('reset', onReset, true);
      announcer.remove();
    };
  }, []);

  return null;
}
