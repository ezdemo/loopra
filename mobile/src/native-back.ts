type BackDetail = { handle: () => void };

declare global {
  interface Window {
    __loopraBack?: () => boolean;
    __loopraResume?: () => void;
  }
}

export function installNativeBackBridge() {
  if (!window.__loopraBack) {
    window.__loopraBack = () => {
      let handled = false;
      const event = new CustomEvent<BackDetail>('loopra:native-back', {
        cancelable: true,
        detail: { handle: () => { handled = true; } },
      });
      window.dispatchEvent(event);
      return handled || event.defaultPrevented;
    };
  }
  window.__loopraResume = () => window.dispatchEvent(new Event('loopra:native-resume'));
}

export function onNativeBack(handler: () => boolean) {
  const listener = (event: Event) => {
    if (!handler()) return;
    (event as CustomEvent<BackDetail>).detail.handle();
    event.preventDefault();
  };
  window.addEventListener('loopra:native-back', listener);
  return () => window.removeEventListener('loopra:native-back', listener);
}

export function onNativeResume(handler: () => void) {
  window.addEventListener('loopra:native-resume', handler);
  return () => window.removeEventListener('loopra:native-resume', handler);
}
