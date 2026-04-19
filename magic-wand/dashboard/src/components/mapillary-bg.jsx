import { useEffect, useRef, useState } from 'react';
import { MAPILLARY_TOKEN } from '../config';
import 'mapillary-js/dist/mapillary.css';

const START = { lat: 40.6925, lng: -73.9872 };
const MAX_IMAGES = 150;
const TURN_THRESHOLD_DEG = 45;
const STEP_INTERVAL_MS = 1500;
const PIXEL_COLS = 480*2;
const PIXEL_ROWS = 270*2;

const POSTER_PALETTE = [
  [10,  4,  8],
  [122, 31, 58],
  [217, 58, 106],
  [255, 106, 45],
  [255, 180, 59],
  [255, 245, 221],
];

// Petra Collins haze — applied on top of posterized colors
const HAZE_R = 255, HAZE_G = 175, HAZE_B = 200;
const HAZE_BLEND  = 0.1;
const SHADOW_LIFT = 55;
const SHADOW_COMP = 0.65;
const BLOOM_START = 160;
const BLOOM_STR   = 0.50;
const DESATURATE  = 0.15;
const GRAIN       = 4;

function angleDelta(a, b) {
  const d = ((b - a) % 360 + 360) % 360;
  return d > 180 ? 360 - d : d;
}

async function fetchAnchorImage(lat, lng) {
  const d = 0.003;
  const url = [
    'https://graph.mapillary.com/images',
    `?fields=id,sequence`,
    `&bbox=${lng - d},${lat - d},${lng + d},${lat + d}`,
    `&limit=1`,
    `&access_token=${MAPILLARY_TOKEN}`,
  ].join('');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mapillary API ${res.status}`);
  const json = await res.json();
  const img = json.data?.[0];
  return img ? { id: img.id, sequenceId: img.sequence } : null;
}

async function fetchSequenceImageIds(sequenceId) {
  const url = `https://graph.mapillary.com/image_ids?sequence_id=${sequenceId}&access_token=${MAPILLARY_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mapillary sequence API ${res.status}`);
  const json = await res.json();
  return json.data?.map(img => img.id) ?? [];
}

async function fetchCompassAngles(ids) {
  const map = {};
  const CHUNK = 50;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const url = `https://graph.mapillary.com/images?ids=${chunk.join(',')}&fields=id,computed_compass_angle&access_token=${MAPILLARY_TOKEN}`;
    const res = await fetch(url);
    if (!res.ok) continue;
    const json = await res.json();
    for (const img of (json.data ?? [])) {
      map[img.id] = img.computed_compass_angle ?? null;
    }
  }
  return map;
}

export default function MapillaryBg({ className, lastHitPos, active, onReady, onTurn }) {
  const containerRef = useRef(null);
  const pixelCanvasRef = useRef(null);
  const viewerRef = useRef(null);
  const rafRef = useRef(null);
  const turnSetRef = useRef(new Set());
  const stateRef = useRef({ mounted: true, imgIdx: 0 });
  const idsRef = useRef([]);
  const timerRef = useRef(null);
  const activeRef = useRef(active);
  const [status, setStatus] = useState('loading');
  const [loadProgress, setLoadProgress] = useState(0);
  const [pixelate, setPixelate] = useState(true);
  const pixelateRef = useRef(true);

  useEffect(() => { activeRef.current = active; }, [active]);

  // P key toggle
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'p' || e.key === 'P') {
        pixelateRef.current = !pixelateRef.current;
        setPixelate(pixelateRef.current);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  // Rotate view toward last hit
  useEffect(() => {
    if (!lastHitPos || !viewerRef.current) return;
    viewerRef.current.setCenter([lastHitPos.xNorm, lastHitPos.yNorm])?.catch(() => {});
  }, [lastHitPos]);

  // Pixel render loop
  useEffect(() => {
    if (status !== 'ready') return;
    const offscreen = document.createElement('canvas');
    offscreen.width = PIXEL_COLS;
    offscreen.height = PIXEL_ROWS;
    const offCtx = offscreen.getContext('2d');

    function loop() {
      rafRef.current = requestAnimationFrame(loop);
      const mlCanvas = containerRef.current?.querySelector('canvas');
      const pixelCanvas = pixelCanvasRef.current;
      if (!mlCanvas || !pixelCanvas) return;
      const w = pixelCanvas.width;
      const h = pixelCanvas.height;
      const ctx = pixelCanvas.getContext('2d');
      try {
        if (!pixelateRef.current) {
          ctx.drawImage(mlCanvas, 0, 0, w, h);
        } else {
          offCtx.drawImage(mlCanvas, 0, 0, PIXEL_COLS, PIXEL_ROWS);
          const imageData = offCtx.getImageData(0, 0, PIXEL_COLS, PIXEL_ROWS);
          const { data } = imageData;

          for (let idx = 0, len = PIXEL_COLS * PIXEL_ROWS; idx < len; idx++) {
            const i = idx * 4;
            const pr = data[i], pg = data[i + 1], pb = data[i + 2];
            const lum0 = 0.299 * pr + 0.587 * pg + 0.114 * pb;

            // 1. Posterize
            const isSky   = pb > pr * 1.05 && pb > pg * 0.95 && lum0 > 40;
            const isGreen = pg > pr * 1.05 && pg > pb * 1.05 && lum0 > 20;
            let r, g, b;
            if (isSky || isGreen) {
              r = pr; g = pg; b = pb;
            } else {
              const level = Math.min(POSTER_PALETTE.length - 1, Math.floor(lum0 / 256 * POSTER_PALETTE.length));
              [r, g, b] = POSTER_PALETTE[level];
            }

            // 2. Lift blacks
            r = r * SHADOW_COMP + SHADOW_LIFT;
            g = g * SHADOW_COMP + SHADOW_LIFT * 0.80;
            b = b * SHADOW_COMP + SHADOW_LIFT * 0.88;

            // 3. Desaturate
            const gray = 0.299 * r + 0.587 * g + 0.114 * b;
            r = r + (gray - r) * DESATURATE;
            g = g + (gray - g) * DESATURATE;
            b = b + (gray - b) * DESATURATE;

            // 4. Pink haze
            r = r + (HAZE_R - r) * HAZE_BLEND;
            g = g + (HAZE_G - g) * HAZE_BLEND;
            b = b + (HAZE_B - b) * HAZE_BLEND;

            // 5. Highlight bloom
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            if (lum > BLOOM_START) {
              const t = Math.min(1, (lum - BLOOM_START) / (255 - BLOOM_START)) * BLOOM_STR;
              r = r + (255 - r) * t;
              g = g + (248 - g) * t;
              b = b + (235 - b) * t;
            }

            // 6. Grain
            const grain = (Math.random() - 0.5) * GRAIN;
            data[i]     = Math.min(255, Math.max(0, r + grain));
            data[i + 1] = Math.min(255, Math.max(0, g + grain));
            data[i + 2] = Math.min(255, Math.max(0, b + grain));
          }

          offCtx.putImageData(imageData, 0, 0);
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(offscreen, 0, 0, w, h);
        }
      } catch { /* tainted canvas */ }
    }

    loop();
    return () => cancelAnimationFrame(rafRef.current);
  }, [status]);

  // Resize canvas to match CSS size
  useEffect(() => {
    const canvas = pixelCanvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(([entry]) => {
      canvas.width = entry.contentRect.width;
      canvas.height = entry.contentRect.height;
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // Init viewer
  useEffect(() => {
    stateRef.current.mounted = true;
    if (!MAPILLARY_TOKEN) { setStatus('no-token'); return; }

    let viewer;

    async function init() {
      try {
        setLoadProgress(0.1);
        const anchor = await fetchAnchorImage(START.lat, START.lng);
        if (!anchor?.sequenceId) throw new Error('No anchor image found');
        setLoadProgress(0.3);

        const allIds = await fetchSequenceImageIds(anchor.sequenceId);
        const startIdx = Math.max(0, allIds.indexOf(anchor.id));
        const ids = allIds.slice(startIdx, startIdx + MAX_IMAGES);
        if (ids.length === 0) throw new Error('No images in sequence');
        setLoadProgress(0.6);

        const angles = await fetchCompassAngles(ids);
        setLoadProgress(0.85);

        const turnSet = new Set();
        for (let i = 1; i < ids.length; i++) {
          const prev = angles[ids[i - 1]];
          const curr = angles[ids[i]];
          if (prev != null && curr != null && angleDelta(prev, curr) > TURN_THRESHOLD_DEG) {
            turnSet.add(ids[i]);
          }
        }
        turnSetRef.current = turnSet;

        if (!stateRef.current.mounted) return;

        const { Viewer } = await import('mapillary-js');
        if (!stateRef.current.mounted) return;

        idsRef.current = ids;

        viewer = new Viewer({
          accessToken: MAPILLARY_TOKEN,
          container: containerRef.current,
          imageId: ids[0],
          component: { cover: false, direction: false, sequence: false, bearing: false, zoom: false, attribution: false },
        });

        viewerRef.current = viewer;
        setTimeout(() => { if (stateRef.current.mounted) viewer.resize(); }, 200);

        setLoadProgress(1);
        setStatus('ready');
        onReady?.();

        async function step() {
          if (!stateRef.current.mounted) return;
          if (!activeRef.current) {
            timerRef.current = setTimeout(step, 300);
            return;
          }
          const s = stateRef.current;
          s.imgIdx = (s.imgIdx + 1) % idsRef.current.length;
          const id = idsRef.current[s.imgIdx];
          await viewer.moveTo(id).catch(() => {});
          if (!stateRef.current.mounted) return;
          if (turnSetRef.current.has(id)) onTurn?.();
          timerRef.current = setTimeout(step, STEP_INTERVAL_MS);
        }

        timerRef.current = setTimeout(step, STEP_INTERVAL_MS);

      } catch (err) {
        console.warn('MapillaryBg:', err);
        setStatus('error');
      }
    }

    init();

    return () => {
      stateRef.current.mounted = false;
      clearTimeout(timerRef.current);
      viewer?.remove();
    };
  }, []);

  if (status === 'no-token') {
    return (
      <div className={`absolute inset-0 flex items-center justify-center bg-berry-shadow/60 ${className ?? ''}`}>
        <p className="text-cream-soda/50 font-mono text-xs text-center px-8">
          add REACT_APP_MAPILLARY_TOKEN to .env to enable street view
        </p>
      </div>
    );
  }

  return (
    <div className={`absolute inset-0 ${className ?? ''}`}>
      {/* Mapillary renders here — hidden, sampled by pixel loop */}
      <div style={{ position: 'absolute', width: 1280, height: 720, visibility: 'hidden', pointerEvents: 'none' }}>
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      </div>

      <canvas
        ref={pixelCanvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
      />

      {status === 'loading' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none gap-3">
          <span className="text-cream-soda/50 font-mono text-xs tracking-widest">LOADING...</span>
          <div className="w-48 h-1 bg-cream-soda/10 rounded-full overflow-hidden">
            <div className="h-full bg-pink-rose-punch rounded-full transition-all duration-300" style={{ width: `${loadProgress * 100}%` }} />
          </div>
          <span className="text-cream-soda/30 font-mono text-[10px]">{Math.round(loadProgress * 100)}%</span>
        </div>
      )}

      {status === 'ready' && !pixelate && (
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 pointer-events-none">
          <span className="text-cream-soda/20 font-mono text-[9px] tracking-widest">full res · P to pixelate</span>
        </div>
      )}
    </div>
  );
}
