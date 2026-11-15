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
 * mount(target, options) -> { update(series, options?), append(id, pointOrPoints), destroy() }
 * update replaces the series. append requires an existing series id. Both return
 * {series, samples, min, max}; only finite numeric samples count. A null/nonnumeric
 * y breaks the line; invalid x values are ignored. No string/boolean coercion.
 * Points sort by x, retaining the newest maxPoints per series (default 500,
 * range 2..10000). At most 24 uniquely named series may be shown at once.
 * Options: title, xLabel, yLabel, xFormat(value), yFormat(value), maxPoints.
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
    for (const name of ['xFormat', 'yFormat']) if (options[name] !== undefined && typeof options[name] !== 'function') throw new TypeError(`${name} must be a function`);
    let settings = { title: 'Measurements', xLabel: 'X', yLabel: 'Value', xFormat: format, yFormat: format };
    let series = [], destroyed = false, frame = null;
    const root = el('figure'); root.dataset.tendrilChart = '';
    root.style.cssText = 'margin:0;min-width:0;font:inherit;overflow-wrap:anywhere';
    const style = el('style', `
      [data-tendril-chart] svg{display:block;width:100%;height:260px;overflow:hidden}
      [data-tendril-chart] svg text{font:12px system-ui,sans-serif;fill:currentColor}
      [data-tendril-chart] .tc-grid{stroke:currentColor;opacity:.15}
      [data-tendril-chart] .tc-series{fill:none;stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round}
      [data-tendril-chart] figcaption{display:grid;gap:4px}
      [data-tendril-chart] .tc-summary{font-size:.9em;margin:0;opacity:.8}
      [data-tendril-chart] .tc-legend{display:flex;flex-wrap:wrap;gap:8px 20px;padding:0;list-style:none;font-size:.9em}
      [data-tendril-chart] .tc-legend svg{display:inline-block;width:28px;height:10px;margin-right:6px;vertical-align:middle}
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
    const details = el('details'), toggle = el('summary', 'View sample values'), tableWrap = el('div'); tableWrap.className = 'tc-table';
    details.append(toggle, tableWrap);
    root.append(style, caption, svg, legend, details); host.append(root);

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
      return updated;
    }
    settings = configured(options);
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
    function renderTable() {
      if (!details.open || destroyed) return;
      const table = el('table');
      table.append(el('caption', 'Latest 100 samples across all series; missing values are marked with a dash.'));
      const head = el('thead'), header = el('tr'), body = el('tbody');
      for (const label of ['Series', settings.xLabel, settings.yLabel]) { const th = el('th', label); th.scope = 'col'; header.append(th); }
      head.append(header);
      const recent = series.flatMap(group => group.points.slice(-100).map(point => ({ group, point })))
        .sort((a, b) => a.point.x - b.point.x).slice(-100);
      for (const { group, point } of recent) {
        const row = el('tr');
        row.append(el('td', group.label), el('td', text(settings.xFormat, point.x)), el('td', point.y === null ? '—' : text(settings.yFormat, point.y)));
        body.append(row);
      }
      table.append(head, body); tableWrap.replaceChildren(table);
    }
    details.addEventListener('toggle', renderTable);

    function render() {
      if (destroyed) return stats();
      const result = stats();
      heading.textContent = settings.title;
      const description = result.samples ? `${result.samples} samples across ${result.series} series · min ${text(settings.yFormat, result.min)} · max ${text(settings.yFormat, result.max)}` : 'Waiting for numeric samples.';
      summary.textContent = description;
      svg.setAttribute('aria-label', `${settings.title}: ${description} ${settings.xLabel}; ${settings.yLabel}.`);
      const width = Math.max(320, Math.min(1200, host.getBoundingClientRect().width || 640)), height = 260;
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.replaceChildren(); legend.replaceChildren();
      for (const [index, group] of series.entries()) {
        const entry = el('li'), swatch = svgEl('svg', { viewBox: '0 0 28 10', 'aria-hidden': true });
        swatch.append(svgEl('line', { x1: 0, x2: 28, y1: 5, y2: 5, stroke: color(index), 'stroke-width': 3, 'stroke-dasharray': dash(index) }));
        const latest = group.points[group.points.length - 1];
        entry.append(swatch, el('span', `${group.label}: ${latest && latest.y !== null ? text(settings.yFormat, latest.y) : '—'}`)); legend.append(entry);
      }
      if (!result.samples) {
        svg.append(svgEl('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle' }, 'Waiting for numeric samples'));
        renderTable(); return result;
      }
      let minX = Infinity, maxX = -Infinity;
      for (const group of series) for (const point of group.points) { minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x); }
      // Normalize before subtracting so finite values near Number.MAX_VALUE do
      // not overflow their ranges. A flat range is centered in the plot.
      const scale = (lo, hi) => {
        const divisor = Math.max(Math.abs(lo), Math.abs(hi), 1);
        const start = lo / divisor, span = hi / divisor - start;
        return value => span ? (value / divisor - start) / span : 0.5;
      };
      const xScale = scale(minX, maxX), yScale = scale(result.min, result.max);
      const left = 76, right = width - 20, top = 24, bottom = height - 54;
      const x = value => left + xScale(value) * (right - left), y = value => bottom - yScale(value) * (bottom - top);
      for (let i = 0; i < 5; i++) {
        const fraction = i / 4, value = (1 - fraction) * result.min + fraction * result.max;
        const position = result.min === result.max ? top + fraction * (bottom - top) : y(value);
        svg.append(svgEl('line', { x1: left, x2: right, y1: position, y2: position, class: 'tc-grid' }));
        if (result.min !== result.max || i === 2) svg.append(svgEl('text', { x: left - 10, y: position + 4, 'text-anchor': 'end' }, text(settings.yFormat, value)));
      }
      svg.append(svgEl('text', { x: left, y: 14 }, settings.yLabel));
      const ticks = width < 500 || minX === maxX ? [minX] : [minX, (minX / 2 + maxX / 2)];
      if (minX !== maxX) ticks.push(maxX);
      for (const value of ticks) svg.append(svgEl('text', { x: x(value), y: bottom + 23, 'text-anchor': value === minX && minX !== maxX ? 'start' : value === maxX && minX !== maxX ? 'end' : 'middle' }, text(settings.xFormat, value)));
      svg.append(svgEl('text', { x: (left + right) / 2, y: height - 5, 'text-anchor': 'middle' }, settings.xLabel));
      for (const [index, group] of series.entries()) {
        let commands = [], connected = false;
        for (const point of group.points) {
          if (point.y === null) { connected = false; continue; }
          commands.push(`${connected ? 'L' : 'M'}${x(point.x).toFixed(2)},${y(point.y).toFixed(2)}`); connected = true;
        }
        svg.append(svgEl('path', { d: commands.join(' '), class: 'tc-series', 'data-series': group.id, stroke: color(index), 'stroke-dasharray': dash(index) }));
        // Isolated samples remain visible, including samples either side of gaps.
        group.points.forEach((point, indexInGroup) => {
          if (point.y !== null && (!group.points[indexInGroup - 1] || group.points[indexInGroup - 1].y === null)
            && (!group.points[indexInGroup + 1] || group.points[indexInGroup + 1].y === null))
            svg.append(svgEl('circle', { cx: x(point.x), cy: y(point.y), r: 3, fill: color(index), 'data-series': group.id }));
        });
      }
      renderTable(); return result;
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
      destroy() {
        if (destroyed) return;
        destroyed = true; observer?.disconnect(); window.removeEventListener('resize', resize);
        if (frame !== null) cancelAnimationFrame(frame);
        details.removeEventListener('toggle', renderTable); series = []; root.remove();
      },
    };
  }
  ns.chart = { supported, mount };
})();
