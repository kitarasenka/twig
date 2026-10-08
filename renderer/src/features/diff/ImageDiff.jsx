import { useEffect, useRef, useState } from 'react';
import { formatSize } from './lfs-pointer.js';
import {
  IMAGE_MODES, compareScale, compareSummary, diffMask, differencePixels, dimensions, findRegions,
  readImagePrefs, regionLabel, scaleRegions, writeImagePrefs
} from './image-diff.js';
import { MAX_IMAGE_BYTES } from '../../../../main/git/image-types.js';

const storage = () => { try { return window.localStorage; } catch { return null; } };

/** One side's bytes as a decoded bitmap, without colour management, so equal pixels stay equal. */
async function decode(side, type) {
  if (side?.state !== 'ok') return side ?? { state: 'missing' };
  try {
    const bitmap = await createImageBitmap(new Blob([side.bytes], { type }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    return { state: 'ok', size: side.size, bitmap, width: bitmap.width, height: bitmap.height };
  } catch { return { state: 'broken', size: side.size }; }
}

/** A token's colour as `[r, g, b]`, whatever syntax the stylesheet writes it in. */
function tokenColor(name) {
  const context = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#000';
  context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#000';
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

function pixelsOf(bitmap, width, height, scale) {
  const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
  return context.getImageData(0, 0, width, height).data;
}

/** Lays both versions on one canvas, finds the changed areas and paints the Difference view. */
function compare(before, after) {
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const scale = compareScale(width, height);
  const compareWidth = Math.max(1, Math.round(width * scale));
  const compareHeight = Math.max(1, Math.round(height * scale));
  const a = pixelsOf(before.bitmap, compareWidth, compareHeight, scale);
  const b = pixelsOf(after.bitmap, compareWidth, compareHeight, scale);
  const { mask, changed } = diffMask(a, b, compareWidth, compareHeight);
  const found = findRegions(mask, compareWidth, compareHeight);
  const difference = new ImageData(differencePixels(a, b, mask, tokenColor('--danger')), compareWidth, compareHeight);
  return { width, height, scale, changed, total: compareWidth * compareHeight, difference,
    regions: scaleRegions(found.regions, scale, width, height), more: found.more };
}

/** A canvas showing an ImageBitmap or ImageData at its own pixel size; CSS scales it. */
function Pixels({ source, className = 'image-canvas' }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !source) return;
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext('2d');
    if (source instanceof ImageData) context.putImageData(source, 0, 0);
    else context.drawImage(source, 0, 0);
  }, [source]);
  return <canvas ref={ref} className={className} aria-hidden="true" />;
}

/** One version placed on the shared canvas: as wide and tall as it is, from the top-left corner. */
function Layer({ side, width, height, style = null }) {
  return <div className="image-layer" style={{ width: `${side.width / width * 100}%`, height: `${side.height / height * 100}%`, ...style }}>
    <Pixels source={side.bitmap} /></div>;
}

function Areas({ regions, width, height, active, onPick }) {
  return <div className="image-areas" aria-hidden="true">
    {regions.map((region, index) => <div key={index} data-area={index} className={`image-area${active === index ? ' active' : ''}`}
      onClick={() => onPick(index)} style={{
        left: `${region.x / width * 100}%`, top: `${region.y / height * 100}%`,
        width: `${region.width / width * 100}%`, height: `${region.height / height * 100}%`
      }}><span className="image-area-number">{index + 1}</span></div>)}
  </div>;
}

/**
 * The box both versions share, sized for the zoom: in Fit it fills its cell
 * without stretching past the image (a tiny icon may grow up to 8×), at 1:1
 * and 2:1 it is that many screen pixels per image pixel and the cell scrolls.
 */
function Stage({ width, height, zoom, label, className = '', children, ...props }) {
  const fitMax = width * height <= 256 * 256 ? 8 : 1;
  const pixelated = zoom === 'fit' ? fitMax > 1 : zoom === '2';
  const style = zoom === 'fit'
    ? { '--img-w': width, '--img-h': height, '--fit-max': fitMax }
    : { width: `${width * Number(zoom)}px` };
  return <div className={`image-stage${zoom === 'fit' ? ' fit' : ''}${pixelated ? ' pixelated' : ''}${className ? ` ${className}` : ''}`} style={{ aspectRatio: `${width} / ${height}`, ...style }}
    role="img" aria-label={label} {...props}>{children}</div>;
}

function sideLabel(side) {
  if (side.state === 'ok') return `${dimensions(side)} · ${formatSize(side.size)}`;
  if (side.state === 'large') return `${formatSize(side.size)} — larger than the ${formatSize(MAX_IMAGE_BYTES)} the viewer reads`;
  if (side.state === 'broken') return `${formatSize(side.size)} — 🌱 Twig could not decode this version`;
  if (side.state === 'other') return side.reason;
  return 'Not present';
}

function Placeholder({ side }) {
  return <p className="image-missing">{sideLabel(side)}</p>;
}

/**
 * Before and after of an image file, with the rectangles where its pixels
 * changed. The bytes come from main (`getImagePair`), already limited in
 * size; decoding, comparing and drawing happen here, on canvases — nothing is
 * loaded by URL, so the page's content policy stays as it is.
 */
export default function ImageDiff({ repositoryId, file, source }) {
  const [state, setState] = useState({ loading: true });
  const [prefs, setPrefs] = useState(() => readImagePrefs(storage()));
  const [zoom, setZoom] = useState('fit');
  const [active, setActive] = useState(null);
  const [swipe, setSwipe] = useState(50);
  const [onion, setOnion] = useState(50);
  const view = useRef(null);
  const dragging = useRef(false);
  const sourceKey = `${source.kind}:${source.oid ?? ''}:${source.base ?? ''}`;

  useEffect(() => {
    let alive = true;
    const bitmaps = [];
    setState({ loading: true });
    setActive(null);
    (async () => {
      try {
        const pair = await window.twig.getImagePair(repositoryId, file, source);
        const [before, after] = await Promise.all([decode(pair.old, pair.type), decode(pair.new, pair.type)]);
        for (const side of [before, after]) if (side.bitmap) bitmaps.push(side.bitmap);
        if (!alive) return;
        const both = before.state === 'ok' && after.state === 'ok';
        setState({ before, after, comparing: both });
        if (!both) return;
        // One frame so "Comparing…" is on screen before a large image takes the thread.
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (!alive) return;
        let comparison;
        try { comparison = compare(before, after); } catch { comparison = { failed: true }; }
        if (alive) setState({ before, after, comparison });
      } catch {
        if (alive) setState({ error: 'Could not read this image. Show output in the console.' });
      }
    })();
    return () => { alive = false; for (const bitmap of bitmaps) bitmap.close(); };
    // `source` is rebuilt on every render of the parent; its key says when it really changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repositoryId, file, sourceKey]);

  // Bring the picked area into view inside its own scrolling box only:
  // `scrollIntoView` would also scroll the panels around the viewer, which
  // clip their overflow but still scroll when asked, and slide it off screen.
  useEffect(() => {
    if (active === null) return;
    for (const area of view.current?.querySelectorAll(`[data-area="${active}"]`) ?? []) {
      const frame = area.closest('.image-fit');
      if (!frame) continue;
      const outer = frame.getBoundingClientRect();
      const inner = area.getBoundingClientRect();
      if (inner.left < outer.left || inner.right > outer.right) frame.scrollLeft += inner.left - outer.left - (outer.width - inner.width) / 2;
      if (inner.top < outer.top || inner.bottom > outer.bottom) frame.scrollTop += inner.top - outer.top - (outer.height - inner.height) / 2;
    }
  }, [active, zoom, prefs.mode]);

  function update(next) {
    const merged = { ...prefs, ...next };
    setPrefs(merged);
    writeImagePrefs(storage(), merged);
  }

  if (state.loading) return <div className="loading-shell" aria-label="Loading image"><div className="skeleton" /></div>;
  if (state.error) return <p role="alert" className="empty-inline">{state.error}</p>;
  const { before, after, comparison } = state;
  const both = before.state === 'ok' && after.state === 'ok';
  const ready = both && comparison && !comparison.failed;
  const width = both ? Math.max(before.width, after.width) : 0;
  const height = both ? Math.max(before.height, after.height) : 0;
  const regions = ready && prefs.areas ? comparison.regions : [];
  const mode = both ? prefs.mode : 'single';
  const areas = regions.length > 0 && <Areas regions={regions} width={width} height={height} active={active} onPick={setActive} />;

  const summary = !both ? (before.state === 'missing' ? (source.kind === 'untracked' ? 'New file, not in Git yet' : 'Added in this change')
    : after.state === 'missing' ? 'Deleted in this change' : 'One version cannot be shown')
    : !comparison ? 'Comparing…'
      : comparison.failed ? 'These two versions could not be compared'
        : compareSummary({ before, after, changed: comparison.changed, total: comparison.total, regions: comparison.regions, more: comparison.more, scale: comparison.scale });

  function swipeTo(event) {
    const box = event.currentTarget.getBoundingClientRect();
    setSwipe(Math.round(Math.min(100, Math.max(0, (event.clientX - box.left) / box.width * 100))));
  }

  const label = (name, side) => <p className="image-caption"><strong>{name}</strong> {sideLabel(side)}</p>;
  let body;
  if (mode === 'single') {
    const shown = [['Before', before], ['After', after]].filter(([, side]) => side.state !== 'missing');
    body = <div className="image-pair">
      {shown.map(([name, side]) => <div className="image-cell" key={name}>
        {label(name, side)}
        <div className="image-fit">{side.state === 'ok'
          ? <Stage width={side.width} height={side.height} zoom={zoom} label={`${name}: ${file}, ${dimensions(side)}`}>
            <Layer side={side} width={side.width} height={side.height} /></Stage>
          : <Placeholder side={side} />}</div>
      </div>)}
    </div>;
  } else if (mode === 'side') {
    body = <div className="image-pair">
      {[['Before', before], ['After', after]].map(([name, side]) => <div className="image-cell" key={name}>
        {label(name, side)}
        <div className="image-fit"><Stage width={width} height={height} zoom={zoom} label={`${name}: ${file}, ${dimensions(side)}`}>
          <Layer side={side} width={width} height={height} />{areas}</Stage></div>
      </div>)}
    </div>;
  } else if (mode === 'swipe') {
    body = <div className="image-cell">
      <p className="image-caption"><strong>Before</strong> left of the line · <strong>After</strong> right of it</p>
      <div className="image-fit"><Stage width={width} height={height} zoom={zoom} label={`${file}: before and after, split at ${swipe}%`}
        className="swipe"
        onPointerDown={event => { dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); swipeTo(event); }}
        onPointerMove={event => { if (dragging.current) swipeTo(event); }}
        onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }}>
        <Layer side={before} width={width} height={height} />
        <div className="image-clip" style={{ clipPath: `inset(0 0 0 ${swipe}%)` }}><Layer side={after} width={width} height={height} /></div>
        <div className="image-swipe-line" style={{ left: `${swipe}%` }} />
        {areas}</Stage></div>
      <label className="image-slider">Before<input type="range" min="0" max="100" value={swipe} onChange={event => setSwipe(Number(event.target.value))} aria-label="Swipe position" />After</label>
    </div>;
  } else if (mode === 'onion') {
    body = <div className="image-cell">
      <p className="image-caption"><strong>After</strong> over <strong>Before</strong> at {onion}%</p>
      <div className="image-fit"><Stage width={width} height={height} zoom={zoom} label={`${file}: after over before at ${onion}% opacity`}>
        <Layer side={before} width={width} height={height} />
        <Layer side={after} width={width} height={height} style={{ opacity: onion / 100 }} />
        {areas}</Stage></div>
      <label className="image-slider">Before<input type="range" min="0" max="100" value={onion} onChange={event => setOnion(Number(event.target.value))} aria-label="After opacity" />After</label>
    </div>;
  } else {
    body = <div className="image-cell">
      <p className="image-caption"><strong>Changed pixels</strong> in colour; everything else is the after-image in grey</p>
      <div className="image-fit">{ready
        ? <Stage width={width} height={height} zoom={zoom} label={`${file}: changed pixels`} className="difference">
          <div className="image-layer" style={{ width: '100%', height: '100%' }}><Pixels source={comparison.difference} /></div>{areas}</Stage>
        : <p className="image-missing">{summary}</p>}</div>
    </div>;
  }

  return <div className="image-diff" ref={view}>
    <div className="diff-toolbar image-toolbar">
      <span className="image-summary" aria-live="polite">{summary}</span>
      <span className="image-controls">
        {both && <div className="segmented" role="group" aria-label="Image view">
          {IMAGE_MODES.map(item => <button type="button" key={item.id} aria-pressed={prefs.mode === item.id} title={item.title}
            onClick={() => update({ mode: item.id })}>{item.label}</button>)}
        </div>}
        {both && <label className="image-toggle" title="Draw a numbered rectangle around each area where pixels changed">
          <input type="checkbox" checked={prefs.areas} onChange={event => update({ areas: event.target.checked })} />Changed areas</label>}
        <div className="segmented" role="group" aria-label="Zoom">
          {[['fit', 'Fit', 'Fit the image in the panel'], ['1', '1:1', 'One screen pixel per image pixel'], ['2', '2:1', 'Two screen pixels per image pixel']]
            .map(([id, text, title]) => <button type="button" key={id} aria-pressed={zoom === id} title={title} onClick={() => setZoom(id)}>{text}</button>)}
        </div>
      </span>
    </div>
    <div className="image-view">{body}</div>
    {regions.length > 0 && <div className="image-regions" role="group" aria-label="Changed areas">
      {regions.map((region, index) => <button type="button" key={index} aria-pressed={active === index}
        onClick={() => setActive(active === index ? null : index)} title={`${region.pixels} changed pixels${comparison.scale < 1 ? ' (counted at the compared scale)' : ''}`}>
        <span className="image-area-number">{index + 1}</span>{regionLabel(region)}</button>)}
      {comparison.more > 0 && <span className="muted">and {comparison.more} smaller {comparison.more === 1 ? 'area' : 'areas'} not drawn</span>}
    </div>}
  </div>;
}
