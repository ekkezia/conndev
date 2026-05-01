let audioCtx = null;
const audioBuffers = {};

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

export async function preloadSfx(src) {
  if (audioBuffers[src]) return;
  try {
    const ctx = getAudioCtx();
    const res = await fetch(src);
    const raw = await res.arrayBuffer();
    audioBuffers[src] = await ctx.decodeAudioData(raw);
  } catch {}
}

export function playSfx(src, vol = 0.7) {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") ctx.resume();
    const buf = audioBuffers[src];
    if (!buf) return;
    const source = ctx.createBufferSource();
    source.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = vol;
    source.connect(gain);
    gain.connect(ctx.destination);
    source.start(0);
  } catch {}
}
