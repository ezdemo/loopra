let audio: AudioContext | undefined;

/** Resume during the send gesture so the later network completion can play audio. */
export function prepareCompletionSound() {
  try {
    if (!window.AudioContext) return;
    audio ||= new AudioContext();
    void audio.resume().catch(() => {});
  } catch { /* Audio availability must never prevent sending a message. */ }
}

export function playCompletionSound() {
  if (!audio || audio.state !== 'running') return;
  try {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.connect(gain); gain.connect(audio.destination);
    oscillator.frequency.setValueAtTime(660, audio.currentTime);
    oscillator.frequency.setValueAtTime(880, audio.currentTime + 0.12);
    gain.gain.setValueAtTime(0, audio.currentTime);
    gain.gain.linearRampToValueAtTime(0.08, audio.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.28);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    oscillator.start(); oscillator.stop(audio.currentTime + 0.3);
  } catch { /* The completed reply remains usable if audio is unavailable. */ }
}
