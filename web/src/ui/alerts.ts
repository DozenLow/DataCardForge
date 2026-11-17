/**
 * Best-effort attention alerts for the blocking gate: a short two-tone beep, a desktop
 * notification when the browser allows it, and a title flash that is visible from a
 * background tab.
 *
 * Every function swallows its failures on purpose — an alert is a courtesy, and a browser
 * refusing audio/notification permission must never turn into an error next to the real one.
 * The audio context is created on the first real user gesture (autoplay policy), so a block
 * discovered later can still be heard.
 */
let audioContext: AudioContext | null = null;
let titleTimer: number | null = null;
let originalTitle: string | null = null;

/** Create/resume the audio context on the first gesture; returns an uninstall function. */
export function armAlertAudio(): () => void {
  const start = (): void => {
    try {
      audioContext = audioContext ?? new AudioContext();
      void audioContext.resume();
    } catch {
      /* no audio in this browser */
    }
  };
  window.addEventListener('pointerdown', start, { once: true });
  window.addEventListener('keydown', start, { once: true });
  return () => {
    window.removeEventListener('pointerdown', start);
    window.removeEventListener('keydown', start);
  };
}

/** Two short tones; silently does nothing when audio is unavailable or still locked. */
export function playAlertSound(): void {
  try {
    const context = audioContext ?? new AudioContext();
    audioContext = context;
    if (context.state === 'suspended') void context.resume();
    const start = context.currentTime;
    for (const [frequency, offset] of [
      [880, 0],
      [660, 0.18],
    ] as const) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.16, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.16);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.18);
    }
  } catch {
    /* the in-page dialog is the guaranteed channel */
  }
}

export function desktopAlertPermission(): NotificationPermission | 'unavailable' {
  try {
    if (typeof Notification === 'undefined') return 'unavailable';
    return Notification.permission;
  } catch {
    return 'unavailable';
  }
}

/** Only meaningful from a user gesture (the modal's button). */
export function requestDesktopAlertPermission(): void {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  } catch {
    /* ignored */
  }
}

export function showDesktopAlert(title: string, body: string): void {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification(title, { body });
    }
  } catch {
    /* ignored */
  }
}

/** Alternate the tab title for `durationMs`, then restore it. */
export function flashTitle(message: string, durationMs = 6000): void {
  try {
    if (typeof document === 'undefined') return;
    originalTitle ??= document.title;
    if (titleTimer !== null) window.clearInterval(titleTimer);
    let on = false;
    const started = Date.now();
    titleTimer = window.setInterval(() => {
      on = !on;
      document.title = on ? `⚠ ${message}` : (originalTitle ?? document.title);
      if (Date.now() - started >= durationMs) stopTitleFlash();
    }, 900);
  } catch {
    /* ignored */
  }
}

export function stopTitleFlash(): void {
  try {
    if (titleTimer !== null) {
      window.clearInterval(titleTimer);
      titleTimer = null;
    }
    if (originalTitle !== null) {
      document.title = originalTitle;
      originalTitle = null;
    }
  } catch {
    /* ignored */
  }
}
