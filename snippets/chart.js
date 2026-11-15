/* Tendriller snippet: chart.js — bounded, dependency-free numeric series.
 *
 * <script src="_tendril/snippets/chart.js"></script>
 * const chart = tendrilSnippets.chart.mount('#plot', {
 *   title: 'Measurements', xLabel: 'Step', yLabel: 'Loss', maxPoints: 500,
 * });
 * chart.update([{ id: 'run-a', label: 'Run A', points: [{ x: 1, y: 0.8 }] }]);
 * chart.append('run-a', { x: 2, y: 0.6 });
 * // Caller owns stream subscriptions; unsubscribe, then chart.destroy().
 *
 * mount(target, options) -> {update(series, options?), append(id, pointOrPoints), setCursor(x|null), destroy()}
 * update replaces the series. append requires an existing series id. Both return
 * {series, samples, min, max}; only finite numeric samples count. A null/nonnumeric
 * y breaks the line; invalid x values are ignored. No string/boolean coercion.
 * Points sort by x, retaining the newest maxPoints per series (default 500,
 * range 2..10000). At most 24 uniquely named series may be shown at once.
 * Options: title, xLabel, yLabel, xFormat(value), yFormat(value), maxPoints.
 * Optional emaAlpha in (0,1] weights the current sample: EMA = alpha*y +
 * (1-alpha)*previous. It runs in ascending x order, in original y units, resets
 * at gaps, and is recomputed from the bounded retained window. A faint raw line
 * remains visible. This is sample-weighted smoothing, not time-weighted smoothing.
 * yScale: 'linear' (default) or 'log' (base 10); nonpositive y values become plot
 * gaps on a log scale. Raw values remain in the table and returned statistics.
 * xDomain: [min,max] fixes the visible x range; null (default) uses the data.
 * crosshair: true enables pointer and keyboard inspection. It snaps to the nearest
 * observed x, showing exact-x values across series, never interpolation. The last
 * input at a duplicate x is inspected. setCursor(x|null) selects an exact x without
 * snapping or firing onCursor(x|null); use this pair to synchronize peer panels.
 * Shared panels must use the same x units/domain. Set emaAlpha:null to disable EMA.
 * maxPoints is fixed at mount. Formatters must return plain text, not HTML;
 * a formatter that throws falls back to the default numeric label.
 * For time axes: xFormat: x => new Date(x).toLocaleTimeString().
 * SVG axes, named legends and an expandable table work without Tendriller or
 * a CDN. The table contains at most the latest 100 samples across all series. Updates
 * preserve the details control and its focus/open state. destroy removes only
 * this chart and releases its resize observer.
 */
(() => {
  const ns = (window.tendrilSnippets = window.tendrilSnippets || {});
  const numeric = value => typeof value === 'number' && Number.isFinite(value);
  const format = value => Math.abs(value) >= 1e6 || (value !== 0 && Math.abs(value) < 0.001)
    ? value.toExponential(3) : value.toLocaleString(undefined, { maximumSignificantDigits: 4 });
  const supported = () => typeof document.createElementNS === 'function';
  const svgNS = 'http://www.w3.org/2000/svg';
  const palette = ['#087c55', '#2768c5', '#a24e16', '#8145ba', '#b12e69', '#157b8a'];
  const dashes = ['', '8 3', '2 3', '8 3 2 3'];
  let serial = 0;
  // Convex interpolation stays finite even at the limits of floating point.
  const mix = (a, b, t) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), (1 - t) * a + t * b));
  const scale = (lo, hi) => {
    const divisor = Math.max(Math.abs(lo), Math.abs(hi), 1), start = lo / divisor, span = hi / divisor - start;
    return value => span ? (value / divisor - start) / span : 0.5;
  };
  const nearest = (values, value) => {
    let lo = 0, hi = values.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid] < value) lo = mid + 1; else hi = mid; }
    if (!lo) return 0;
    if (lo === values.length) return lo - 1;
    return value - values[lo - 1] <= values[lo] - value ? lo - 1 : lo;
  };
  const el = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
  const svgEl = (tag, attrs = {}, text) => {
    const node = document.createElementNS(svgNS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function mount(target, options = {}) {
    const host = typeof target === 'string' ? document.querySelector(target) : target;
    if (!host || typeof host.append !== 'function') throw new TypeError('chart.mount requires an element');
    const maxPoints = options.maxPoints === undefined ? 500 : options.maxPoints;
    if (!Number.isInteger(maxPoints) || maxPoints < 2 || maxPoints > 10000) throw new RangeError('maxPoints must be an integer from 2 to 10000');
    let settings = { title: 'Measurements', xLabel: 'X', yLabel: 'Value', xFormat: format, yFormat: format,
      emaAlpha: null, yScale: 'linear', xDomain: null, crosshair: false, onCursor: null };
    settings = configured(options); // Validate before creating any DOM.
    let series = [], prepared = [], xs = [], destroyed = false, frame = null, cursorX = null, geometry = null, overlay = null;
    const clipId = `tendril-chart-${Date.now().toString(36)}-${++serial}`;
    const root = el('figure'); root.dataset.tendrilChart = '';
    root.style.cssText = 'margin:0;min-width:0;font:inherit;overflow-wrap:anywhere';
    const style = el('style', `
      [data-tendril-chart] svg{display:block;width:100%;height:260px;overflow:hidden}
      [data-tendril-chart] svg text{font:12px system-ui,sans-serif;fill:currentColor}
      [data-tendril-chart] .tc-grid{stroke:currentColor;opacity:.15}
      [data-tendril-chart] .tc-series,[data-tendril-chart] .tc-raw{fill:none;stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round}
      [data-tendril-chart] .tc-raw{opacity:.25;stroke-width:1.5}
      [data-tendril-chart] .tc-crosshair{stroke:currentColor;stroke-width:1;stroke-dasharray:3 3;opacity:.65;pointer-events:none}
      [data-tendril-chart] figcaption{display:grid;gap:4px}
      [data-tendril-chart] .tc-summary{font-size:.9em;margin:0;opacity:.8}
      [data-tendril-chart] .tc-legend{display:flex;flex-wrap:wrap;gap:8px 20px;padding:0;list-style:none;font-size:.9em}
      [data-tendril-chart] .tc-legend svg{display:inline-block;width:28px;height:10px;margin-right:6px;vertical-align:middle}
      [data-tendril-chart] .tc-inspector{font-size:.9em}
      [data-tendril-chart] .tc-inspector label{display:flex;align-items:center;gap:12px;min-height:44px}
      [data-tendril-chart] .tc-inspector input{flex:1;min-width:0;accent-color:currentColor}
      [data-tendril-chart] .tc-cursor-label{margin:4px 0}
      [data-tendril-chart] summary{cursor:pointer;min-height:44px;display:list-item;align-content:center}
      [data-tendril-chart] summary:focus-visible{outline:2px solid currentColor;outline-offset:2px}
      [data-tendril-chart] .tc-table{overflow:auto;max-height:320px}
      [data-tendril-chart] table{border-collapse:collapse;font:inherit;font-size:.9em;width:100%}
      [data-tendril-chart] th,[data-tendril-chart] td{text-align:left;padding:6px 12px;border-bottom:1px solid #8884}
      [data-tendril-chart] caption{text-align:left;padding:4px 0}
      @media(prefers-color-scheme:dark){[data-tendril-chart]{--tc-0:#84e4b7;--tc-1:#7ec8ff;--tc-2:#ffb480;--tc-3:#c6a6ff;--tc-4:#f998bb;--tc-5:#70d6e4}}
    `);
    const caption = el('figcaption'), heading = el('strong'), summary = el('p'); summary.className = 'tc-summary';
    caption.append(heading, summary);
    const svg = svgEl('svg', { role: 'img' }), legend = el('ul'); legend.className = 'tc-legend';
    legend.setAttribute('aria-label', 'Chart series');
    const inspector = el('div'), inspectLabel = el('label', 'Inspect samples'), slider = el('input'), cursorLabel = el('p');
    inspector.className = 'tc-inspector'; cursorLabel.className = 'tc-cursor-label';
    slider.type = 'range'; slider.min = '0'; slider.step = '1';
    inspectLabel.append(slider); inspector.append(inspectLabel, cursorLabel);
    const details = el('details'), toggle = el('summary', 'View sample values'), tableWrap = el('div'); tableWrap.className = 'tc-table';
    details.append(toggle, tableWrap);
    root.append(style, caption, svg, inspector, legend, details); host.append(root);

    function normalize(points) {
      if (!Array.isArray(points)) throw new TypeError('Each chart series requires a points array');
      return points.filter(point => point && numeric(point.x))
        .map(point => ({ x: point.x, y: numeric(point.y) ? point.y : null }))
        .sort((a, b) => a.x - b.x).slice(-maxPoints);
    }
    function configured(next = {}) {
      const updated = { ...settings };
      for (const name of ['title', 'xLabel', 'yLabel']) if (next[name] !== undefined) updated[name] = String(next[name]);
      for (const name of ['xFormat', 'yFormat']) {
        if (next[name] !== undefined && typeof next[name] !== 'function') throw new TypeError(`${name} must be a function`);
        if (next[name] !== undefined) updated[name] = next[name];
      }
      if (next.emaAlpha !== undefined) {
        if (next.emaAlpha !== null && (!numeric(next.emaAlpha) || next.emaAlpha <= 0 || next.emaAlpha > 1)) throw new RangeError('emaAlpha must be null or a number greater than 0 and at most 1');
        updated.emaAlpha = next.emaAlpha;
      }
      if (next.yScale !== undefined) {
        if (!['linear', 'log'].includes(next.yScale)) throw new TypeError('yScale must be linear or log');
        updated.yScale = next.yScale;
      }
      if (next.xDomain !== undefined) {
        if (next.xDomain !== null && (!Array.isArray(next.xDomain) || next.xDomain.length !== 2
          || !numeric(next.xDomain[0]) || !numeric(next.xDomain[1]) || next.xDomain[0] > next.xDomain[1])) throw new RangeError('xDomain must be null or an ordered pair of finite numbers');
        updated.xDomain = next.xDomain === null ? null : [...next.xDomain];
      }
      if (next.crosshair !== undefined) {
        if (typeof next.crosshair !== 'boolean') throw new TypeError('crosshair must be a boolean');
        updated.crosshair = next.crosshair;
      }
      if (next.onCursor !== undefined) {
        if (next.onCursor !== null && typeof next.onCursor !== 'function') throw new TypeError('onCursor must be a function or null');
        updated.onCursor = next.onCursor;
      }
      return updated;
    }
    const text = (formatter, value) => {
      try { return String(formatter(value)); }
      catch { return format(value); }
    };
    const color = index => `var(--tc-${index % palette.length},${palette[index % palette.length]})`;
    const dash = index => dashes[Math.floor(index / palette.length) % dashes.length];
    function stats() {
      let samples = 0, min = Infinity, max = -Infinity;
      for (const group of series) for (const point of group.points) if (point.y !== null) {
        samples++; min = Math.min(min, point.y); max = Math.max(max, point.y);
      }
      return { series: series.length, samples, min: samples ? min : null, max: samples ? max : null };
    }
    function prepare() {
      return series.map(group => {
        let previous = null;
        return { ...group, points: group.points.map(point => {
          const raw = settings.yScale === 'log' && point.y !== null && point.y <= 0 ? null : point.y;
          const value = raw === null || settings.emaAlpha === null || previous === null ? raw : mix(previous, raw, settings.emaAlpha);
          previous = value;
          return { ...point, raw, value };
        }) };
      });
    }
    const rawText = point => !point || point.y === null ? '—' : text(settings.yFormat, point.y)
      + (settings.yScale === 'log' && point.y <= 0 ? ' (not shown on log scale)' : '');
    const valueText = point => settings.emaAlpha === null ? rawText(point)
      : `${!point || point.value === null ? '—' : text(settings.yFormat, point.value)} EMA (raw ${rawText(point)})`;
    function atX(points, x) {
      // Upper bound selects the last input when several samples share an x.
      let lo = 0, hi = points.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid].x <= x) lo = mid + 1; else hi = mid; }
      return points[lo - 1]?.x === x ? points[lo - 1] : null;
    }
    function renderCursor() {
      if (destroyed) return;
      const selected = settings.crosshair ? cursorX : null, values = [];
      overlay?.replaceChildren();
      if (selected !== null && geometry && selected >= geometry.minX && selected <= geometry.maxX) {
        const px = geometry.x(selected);
        overlay.append(svgEl('line', { x1: px, x2: px, y1: geometry.top, y2: geometry.bottom, class: 'tc-crosshair' }));
      }
      for (const [index, group] of prepared.entries()) {
        const point = selected === null ? group.points[group.points.length - 1] : atX(group.points, selected);
        const label = `${group.label}: ${valueText(point)}`;
        legend.children[index].lastChild.textContent = label; values.push(label);
        if (selected !== null && point?.value !== null && point?.value !== undefined && geometry
          && selected >= geometry.minX && selected <= geometry.maxX) {
          overlay.append(svgEl('circle', { cx: geometry.x(selected), cy: geometry.y(point.value), r: 4,
            fill: color(index), stroke: 'var(--tc-cursor-outline,Canvas)', 'stroke-width': 1.5, 'data-cursor-series': group.id }));
        }
      }
      inspector.hidden = !settings.crosshair;
      slider.disabled = !xs.length;
      slider.max = String(Math.max(0, xs.length - 1));
      slider.value = String(selected === null || !xs.length ? 0 : nearest(xs, selected));
      slider.setAttribute('aria-label', `${settings.title}: inspect ${settings.xLabel} samples`);
      const outside = selected !== null && geometry && (selected < geometry.minX || selected > geometry.maxX);
      cursorLabel.textContent = selected === null ? 'Hover or use the slider (arrow keys; Escape clears). Latest values are shown.'
        : `${settings.xLabel}: ${text(settings.xFormat, selected)}${outside ? ' (outside visible range)' : ''}. Exact-x values are shown.`;
      slider.setAttribute('aria-valuetext', selected === null ? 'Select a sample' : `${cursorLabel.textContent} ${values.join('; ')}`);
    }
    function selectCursor(value, notify = false) {
      if (value !== null && !numeric(value)) throw new TypeError('setCursor requires a finite number or null');
      const changed = value !== cursorX;
      cursorX = value; renderCursor();
      if (changed && notify) settings.onCursor?.(value);
    }
    function pointer(event) {
      if (!settings.crosshair || !geometry || !xs.length) return;
      const matrix = svg.getScreenCTM(); if (!matrix) return;
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      if (point.x < geometry.left || point.x > geometry.right || point.y < geometry.top || point.y > geometry.bottom) return selectCursor(null, true);
      const value = mix(geometry.minX, geometry.maxX, (point.x - geometry.left) / (geometry.right - geometry.left));
      selectCursor(xs[nearest(xs, value)], true);
    }
    const leave = event => { if (settings.crosshair && event.pointerType !== 'touch' && document.activeElement !== slider) selectCursor(null, true); };
    const slide = () => { if (xs.length) selectCursor(xs[Number(slider.value)], true); };
    const focus = () => { if (cursorX === null) slide(); };
    const keydown = event => { if (event.key === 'Escape') { event.preventDefault(); selectCursor(null, true); } };
    svg.addEventListener('pointermove', pointer); svg.addEventListener('pointerdown', pointer); svg.addEventListener('pointerleave', leave);
    slider.addEventListener('input', slide); slider.addEventListener('focus', focus); slider.addEventListener('keydown', keydown);

    function renderTable() {
      if (!details.open || destroyed) return;
      const table = el('table');
      table.append(el('caption', 'Latest 100 samples across all series; missing values are marked with a dash.'
        + (settings.emaAlpha === null ? '' : ' EMA is computed over the retained window, restarting after each gap.')));
      const head = el('thead'), header = el('tr'), body = el('tbody');
      for (const label of ['Series', settings.xLabel, settings.yLabel + (settings.emaAlpha === null ? '' : ' (raw)'),
        ...(settings.emaAlpha === null ? [] : [`${settings.yLabel} (EMA α=${settings.emaAlpha})`])]) { const th = el('th', label); th.scope = 'col'; header.append(th); }
      head.append(header);
      const recent = prepared.flatMap(group => group.points.slice(-100).map(point => ({ group, point })))
        .sort((a, b) => a.point.x - b.point.x).slice(-100);
      for (const { group, point } of recent) {
        const row = el('tr');
        row.append(el('td', group.label), el('td', text(settings.xFormat, point.x)), el('td', rawText(point)));
        if (settings.emaAlpha !== null) row.append(el('td', point.value === null ? '—' : text(settings.yFormat, point.value)));
        body.append(row);
      }
      table.append(head, body); tableWrap.replaceChildren(table);
    }
    details.addEventListener('toggle', renderTable);

    function render() {
      if (destroyed) return stats();
      const result = stats();
      prepared = prepare();
      heading.textContent = settings.title;
      let description = result.samples ? `${result.samples} samples across ${result.series} series · min ${text(settings.yFormat, result.min)} · max ${text(settings.yFormat, result.max)}` : 'Waiting for numeric samples.';
      if (settings.emaAlpha !== null) description += ` · EMA α=${settings.emaAlpha}; faint line shows raw values`;
      if (settings.yScale === 'log') description += ' · Log y scale; nonpositive values are not plotted';
      summary.textContent = description;
      svg.setAttribute('aria-label', `${settings.title}: ${description} ${settings.xLabel}; ${settings.yLabel}.`);
      const width = Math.max(320, Math.min(1200, host.getBoundingClientRect().width || 640)), height = 260;
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.replaceChildren(); legend.replaceChildren();
      for (const [index] of prepared.entries()) {
        const entry = el('li'), swatch = svgEl('svg', { viewBox: '0 0 28 10', 'aria-hidden': true });
        swatch.append(svgEl('line', { x1: 0, x2: 28, y1: 5, y2: 5, stroke: color(index), 'stroke-width': 3, 'stroke-dasharray': dash(index) }));
        entry.append(swatch, el('span')); legend.append(entry);
      }
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const group of prepared) for (const point of group.points) {
        minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
        if (point.raw !== null) { minY = Math.min(minY, point.raw, point.value); maxY = Math.max(maxY, point.raw, point.value); }
      }
      if (settings.xDomain) [minX, maxX] = settings.xDomain;
      else if (!Number.isFinite(minX)) { minX = 0; maxX = 1; }
      const hasValues = Number.isFinite(minY), transform = value => settings.yScale === 'log' ? Math.log10(value) : value;
      const xScale = scale(minX, maxX), yScale = hasValues ? scale(transform(minY), transform(maxY)) : () => 0.5;
      const left = 76, right = width - 20, top = 24, bottom = height - 54;
      const x = value => left + Math.max(0, Math.min(1, xScale(value))) * (right - left);
      const unitY = value => Math.max(0, Math.min(1, yScale(transform(value))));
      const pixelY = value => bottom - value * (bottom - top), y = value => pixelY(unitY(value));
      geometry = { minX, maxX, left, right, top, bottom, x, y };
      xs = [...new Set(prepared.flatMap(group => group.points.filter(point => point.x >= minX && point.x <= maxX).map(point => point.x)))].sort((a, b) => a - b);
      const defs = svgEl('defs'), clip = svgEl('clipPath', { id: clipId });
      clip.append(svgEl('rect', { x: left, y: top, width: right - left, height: bottom - top })); defs.append(clip); svg.append(defs);
      for (let i = 0; hasValues && i < 5; i++) {
        const fraction = i / 4;
        // Use exact endpoints to avoid pow(10, log10(MAX_VALUE)) overflowing.
        const value = minY === maxY || i === 0 ? minY : i === 4 ? maxY : settings.yScale === 'log'
          ? Math.max(minY, Math.min(maxY, 10 ** mix(Math.log10(minY), Math.log10(maxY), fraction))) : mix(minY, maxY, fraction);
        const position = minY === maxY ? top + fraction * (bottom - top) : pixelY(fraction);
        svg.append(svgEl('line', { x1: left, x2: right, y1: position, y2: position, class: 'tc-grid' }));
        if (minY !== maxY || i === 2) svg.append(svgEl('text', { x: left - 10, y: position + 4, 'text-anchor': 'end' }, text(settings.yFormat, value)));
      }
      if (!hasValues) svg.append(svgEl('text', { x: (left + right) / 2, y: height / 2, 'text-anchor': 'middle' },
        settings.yScale === 'log' ? 'Waiting for positive samples' : 'Waiting for numeric samples'));
      svg.append(svgEl('text', { x: left, y: 14 }, settings.yLabel + (settings.yScale === 'log' ? ' (log)' : '')));
      const ticks = width < 500 || minX === maxX ? [minX] : [minX, (minX / 2 + maxX / 2)];
      if (minX !== maxX) ticks.push(maxX);
      for (const value of ticks) svg.append(svgEl('text', { x: x(value), y: bottom + 23, 'text-anchor': value === minX && minX !== maxX ? 'start' : value === maxX && minX !== maxX ? 'end' : 'middle' }, text(settings.xFormat, value)));
      svg.append(svgEl('text', { x: (left + right) / 2, y: height - 5, 'text-anchor': 'middle' }, settings.xLabel));
      const paths = svgEl('g', { 'clip-path': `url(#${clipId})` }); svg.append(paths);
      const coordinates = (px, py) => `${x(px).toFixed(2)},${pixelY(py).toFixed(2)}`;
      function draw(group, index, field, className) {
        const commands = [];
        let previous = null, end = null;
        for (const point of group.points) {
          if (point[field] === null) { previous = null; end = null; continue; }
          const current = { x: point.x, y: unitY(point[field]) };
          if (!previous && point.x >= minX && point.x <= maxX) { end = coordinates(current.x, current.y); commands.push('M' + end); }
          if (previous) {
            // Clip each segment before converting to pixels, so even data far
            // outside a fixed x domain cannot generate infinite coordinates.
            const lo = Math.max(previous.x, minX), hi = Math.min(current.x, maxX);
            if (lo <= hi) {
              const fraction = scale(previous.x, current.x);
              const start = coordinates(lo, previous.x === current.x ? previous.y : mix(previous.y, current.y, fraction(lo)));
              const finish = coordinates(hi, previous.x === current.x ? current.y : mix(previous.y, current.y, fraction(hi)));
              if (end !== start) commands.push('M' + start);
              commands.push('L' + finish); end = finish;
            } else end = null;
          }
          previous = current;
        }
        paths.append(svgEl('path', { d: commands.join(' '), class: className, 'data-series': group.id, stroke: color(index), 'stroke-dasharray': dash(index) }));
        // Isolated samples remain visible, including samples either side of gaps.
        group.points.forEach((point, indexInGroup) => {
          if (point[field] !== null && point.x >= minX && point.x <= maxX
            && (!group.points[indexInGroup - 1] || group.points[indexInGroup - 1][field] === null)
            && (!group.points[indexInGroup + 1] || group.points[indexInGroup + 1][field] === null))
            paths.append(svgEl('circle', { cx: x(point.x), cy: y(point[field]), r: 3, fill: color(index),
              opacity: className === 'tc-raw' ? 0.25 : 1, 'data-series': group.id }));
        });
      }
      for (const [index, group] of prepared.entries()) {
        if (settings.emaAlpha !== null) draw(group, index, 'raw', 'tc-raw');
        draw(group, index, 'value', 'tc-series');
      }
      overlay = svgEl('g', { 'clip-path': `url(#${clipId})`, 'pointer-events': 'none' }); svg.append(overlay);
      renderCursor(); renderTable(); return result;
    }
    function resize() {
      if (destroyed || frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; render(); });
    }
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    if (observer) observer.observe(host); else window.addEventListener('resize', resize);
    render();
    return {
      update(value, nextOptions) {
        if (destroyed) throw new Error('chart is destroyed');
        if (!Array.isArray(value) || value.length > 24) throw new RangeError('chart.update requires an array of at most 24 series');
        const ids = new Set(), next = value.map(group => {
          if (!group || typeof group.id !== 'string' || !group.id || ids.has(group.id)) throw new TypeError('Chart series require unique nonempty string ids');
          ids.add(group.id);
          return { id: group.id, label: String(group.label ?? group.id), points: normalize(group.points) };
        });
        settings = configured(nextOptions); series = next; return render();
      },
      append(id, points) {
        if (destroyed) throw new Error('chart is destroyed');
        const group = series.find(item => item.id === id);
        if (!group) throw new Error(`Unknown chart series: ${id}`);
        group.points = normalize([...group.points, ...(Array.isArray(points) ? points : [points])]);
        return render();
      },
      setCursor(value) {
        if (destroyed) throw new Error('chart is destroyed');
        selectCursor(value);
      },
      destroy() {
        if (destroyed) return;
        destroyed = true; observer?.disconnect(); window.removeEventListener('resize', resize);
        if (frame !== null) cancelAnimationFrame(frame);
        details.removeEventListener('toggle', renderTable);
        svg.removeEventListener('pointermove', pointer); svg.removeEventListener('pointerdown', pointer); svg.removeEventListener('pointerleave', leave);
        slider.removeEventListener('input', slide); slider.removeEventListener('focus', focus); slider.removeEventListener('keydown', keydown);
        series = []; prepared = []; xs = []; geometry = null; overlay = null; root.remove();
      },
    };
  }
  ns.chart = { supported, mount };
})();
