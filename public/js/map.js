// Interactive route map: flat (Natural Earth) or globe (orthographic), with
// drag/zoom, hover tooltips, route & airport selection, and a chronological replay.
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';
import * as topojson from 'https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/+esm';

const ATLAS = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/';
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function createMap(el, { tooltip, onRoute, onAirport }) {
  const svg = d3.select(el).append('svg');
  const gSphere = svg.append('path').attr('class', 'sphere');
  const gGrat = svg.append('path').attr('class', 'graticule');
  const gLand = svg.append('g');
  const gRoutes = svg.append('g');
  const gHits = svg.append('g');
  const gReplay = svg.append('g');
  const gAirports = svg.append('g');
  const gLabels = svg.append('g');
  const graticule = d3.geoGraticule10();
  const sphere = { type: 'Sphere' };

  let land = { lo: null, hi: null }, visited = new Set();
  let data = { routes: [], airports: [] };
  let mode = 'flat', colorBy = 'frequency';
  let w = 800, h = 500, k = 1, rot = [0, 0], ty = 0, center = 0;
  let interacting = false, idleTimer = null, highlight = null, replayState = null;
  const proj = { flat: d3.geoNaturalEarth1(), globe: d3.geoOrthographic().clipAngle(90) };
  let projection = proj.flat, path = d3.geoPath(projection);

  // The standalone build embeds the world map; otherwise fetch it from the CDN.
  const embedded = globalThis.SKYLOG_ATLAS;
  (embedded ? Promise.resolve([embedded.lo, embedded.hi])
    : Promise.all([d3.json(ATLAS + 'countries-110m.json'), d3.json(ATLAS + 'countries-50m.json')])).then(([lo, hi]) => {
    land.lo = topojson.feature(lo, lo.objects.countries).features;
    land.hi = topojson.feature(hi, hi.objects.countries).features;
    render();
  }).catch(() => { el.dataset.offline = '1'; render(); });

  function configure() {
    if (mode === 'globe') {
      const r = Math.min(w, h) / 2 - 12;
      projection = proj.globe.scale(r * k).translate([w / 2, h / 2]).rotate([rot[0], rot[1]]);
    } else {
      if (!fit) fitFlat();
      const [bx, by] = fit.t;
      projection = proj.flat.rotate([-center, 0]).scale(fit.s * k).translate([w / 2 + (bx - w / 2) * k, h / 2 + (by - h / 2) * k + ty]);
      // Vertical panning stops at the poles: a map taller than the view must always fill it,
      // and a shorter one must stay inside it.
      const [[, y0], [, y1]] = d3.geoPath(projection).bounds(sphere);
      const dy = y1 - y0 > h ? (y0 > 0 ? -y0 : y1 < h ? h - y1 : 0) : (y0 < 0 ? -y0 : y1 > h ? h - y1 : 0);
      if (dy) { ty += dy; const [x, y] = projection.translate(); projection.translate([x, y + dy]); }
    }
    path = d3.geoPath(projection);
  }

  // Base scale/translate for the flat map: fits the flown network (not the whole sphere), leaving
  // room for the stats overlay. Recomputed only when the data or size changes, so rotating doesn't refit.
  let fit = null;
  function fitFlat() {
    const fitTo = data.routes.length ? { type: 'MultiLineString', coordinates: data.routes.map(r => r.path || [[r.a.lon, r.a.lat], [r.b.lon, r.b.lat]]) } : sphere;
    const top = Math.min(110, h * 0.2);
    proj.flat.rotate([-center, 0]).fitExtent([[24, top], [w - 24, h - 28]], fitTo);
    fit = { s: proj.flat.scale(), t: proj.flat.translate() };
  }
  // Degrees of longitude per screen pixel at the equator (Natural Earth's x-scale is ~0.8707).
  const degPerPx = () => 180 / (Math.PI * fit.s * k * 0.8707);
  const spin = px => { center = ((center - px * degPerPx()) % 360 + 540) % 360 - 180; };

  const visible = (lon, lat) => mode !== 'globe' || d3.geoDistance([lon, lat], [-rot[0], -rot[1]]) < Math.PI / 2 - 0.02;
  const line = r => ({ type: 'LineString', coordinates: [[r.a.lon, r.a.lat], [r.b.lon, r.b.lat]] });

  function routeColor(r) {
    if (colorBy !== 'recency') return css('--s1');
    const [y0, y1] = data.yearRange;
    const t = y1 === y0 ? 1 : (r.lastYear - y0) / (y1 - y0);
    return d3.interpolateLab(css('--route-old'), css('--route-new'))(t);
  }

  function render() {
    configure();
    const lowres = interacting && land.lo;
    gSphere.attr('d', path(sphere));
    gGrat.attr('d', path(graticule));
    const feats = (lowres ? land.lo : land.hi || land.lo) || [];
    gLand.selectAll('path').data(feats, d => d.id ?? d.properties.name).join('path')
      .attr('class', d => 'land' + (visited.has(d.id) ? ' visited' : ''))
      .attr('d', path);

    const maxC = d3.max(data.routes, r => r.count) || 1;
    const width = d3.scaleSqrt().domain([1, maxC]).range([1.1, 4.2]);
    const routes = replayState ? [] : data.routes;
    gRoutes.classed('dim', !!highlight && !replayState);
    gRoutes.selectAll('path').data(routes, r => r.key).join('path')
      .attr('class', r => 'route' + (highlight?.has(r.key) ? ' hl' : ''))
      .attr('d', r => path(line(r)))
      .attr('stroke', routeColor)
      .attr('stroke-width', r => width(r.count))
      .attr('stroke-opacity', r => colorBy === 'recency' ? 0.9 : 0.35 + 0.6 * (r.count / maxC));
    gRoutes.selectAll('path.hl').raise();
    gHits.selectAll('path').data(routes, r => r.key).join('path')
      .attr('class', 'route-hit').attr('d', r => path(line(r)))
      .on('mousemove', (ev, r) => tooltip.show(ev, routeTip(r)))
      .on('mouseenter', (ev, r) => setHighlight([r.key], true))
      .on('mouseleave', () => { tooltip.hide(); setHighlight(null, true); })
      .on('click', (ev, r) => onRoute?.(r));

    const maxV = d3.max(data.airports, a => a.count) || 1;
    const rad = d3.scaleSqrt().domain([1, maxV]).range([2.6, 7.5]);
    const aps = data.airports.filter(a => visible(a.a.lon, a.a.lat));
    gAirports.selectAll('circle').data(aps, a => a.code).join('circle')
      .attr('class', a => 'airport' + (highlight?.ap === a.code ? ' hl' : ''))
      .attr('r', a => rad(a.count))
      .attr('transform', a => `translate(${projection([a.a.lon, a.a.lat])})`)
      .on('mousemove', (ev, a) => tooltip.show(ev, `<b>${a.code}</b> · ${a.a.label}<div class="t-sub">${a.a.countryName} · ${a.count} visit${a.count > 1 ? 's' : ''} (${a.deps} dep, ${a.arrs} arr)</div>`))
      .on('mouseleave', () => tooltip.hide())
      .on('click', (ev, a) => onAirport?.(a));
    // Label the busiest airports first, skipping any label that would collide with one already placed.
    const labelN = Math.round(8 + 8 * Math.min(k, 4)), boxes = [], labeled = [];
    for (const a of aps) {
      if (labeled.length >= labelN) break;
      const p = projection([a.a.lon, a.a.lat]); if (!p) continue;
      const x = p[0] + rad(a.count) + 3, y = p[1] - 5, bw = a.code.length * 7.5, bh = 12;
      if (boxes.some(b => x < b[0] + b[2] && x + bw > b[0] && y < b[1] + b[3] && y + bh > b[1])) continue;
      boxes.push([x, y, bw, bh]); labeled.push(a);
    }
    gLabels.selectAll('text').data(labeled, a => a.code).join('text')
      .attr('class', 'ap-label')
      .attr('transform', a => { const [x, y] = projection([a.a.lon, a.a.lat]); return `translate(${x + rad(a.count) + 3},${y + 4})`; })
      .text(a => a.code);

    if (replayState) drawReplay();
    if (interacting) { clearTimeout(idleTimer); idleTimer = setTimeout(() => { interacting = false; render(); }, 160); }
  }

  function routeTip(r) {
    const dir = r.fwd === r.count ? `${r.a.iata} → ${r.b.iata}` : r.fwd === 0 ? `${r.b.iata} → ${r.a.iata}` : `${r.a.iata} ⇄ ${r.b.iata}`;
    return `<b>${dir}</b> · ${r.count} flight${r.count > 1 ? 's' : ''}<div class="t-sub">${r.a.city} – ${r.b.city} · ${data.fmtDist(r.km)}</div>`;
  }

  function setHighlight(keys, fromHover) {
    highlight = keys ? Object.assign(new Set(keys), { ap: null }) : null;
    if (fromHover) {
      gRoutes.classed('dim', !!highlight);
      gRoutes.selectAll('path').classed('hl', r => !!highlight?.has(r.key));
      gRoutes.selectAll('path.hl').raise();
    } else render();
  }

  // ---------- interaction
  const interact = () => { interacting = true; };
  d3.select(el).call(d3.drag()
    .on('start', () => el.classList.add('dragging'))
    .on('drag', ev => {
      interact();
      if (mode === 'globe') {
        const s = 0.25 / k;
        rot = [rot[0] + ev.dx * s, Math.max(-85, Math.min(85, rot[1] - ev.dy * s))];
      } else { spin(ev.dx); ty += ev.dy; } // horizontal drag spins the world; it wraps instead of sliding off
      render();
    })
    .on('end', () => el.classList.remove('dragging')));
  // The wheel scrolls the page until the map is clicked (or Ctrl/⌘ is held), so a tall map can't trap scrolling.
  let engaged = false;
  el.addEventListener('pointerdown', () => { engaged = true; });
  el.addEventListener('pointerleave', () => { engaged = false; });
  function zoomAt(nk, px = 0, py = 0) {
    nk = Math.max(0.8, Math.min(14, nk));
    const ratio = nk / k;
    k = nk;
    // Keep the point under the cursor fixed: the horizontal part becomes a rotation.
    if (mode === 'flat' && fit) { spin(px * (1 - ratio)); ty = py - (py - ty) * ratio; }
    interact(); render();
  }
  el.addEventListener('wheel', ev => {
    if (!engaged && !ev.ctrlKey && !ev.metaKey) return;
    ev.preventDefault();
    const rect = el.getBoundingClientRect();
    zoomAt(k * Math.pow(2, -ev.deltaY * 0.0018), ev.clientX - rect.left - w / 2, ev.clientY - rect.top - h / 2);
  }, { passive: false });
  el.addEventListener('dblclick', () => api.reset());

  new ResizeObserver(() => {
    const r = el.getBoundingClientRect();
    if (r.width && r.height) { w = r.width; h = r.height; fit = null; svg.attr('viewBox', `0 0 ${w} ${h}`); render(); }
  }).observe(el);

  // Pick the central meridian that splits the fewest flown routes at the map edge.
  function bestCenter(routes) {
    let best = 0, bestCost = Infinity;
    for (let c = -180; c < 180; c += 10) {
      const edge = ((c + 360) % 360) - 180;
      let cost = 0;
      for (const r of routes) {
        if (!r.path) continue;
        for (let i = 1; i < r.path.length; i++) {
          const a = ((r.path[i - 1][0] - edge) % 360 + 360) % 360, b = ((r.path[i][0] - edge) % 360 + 360) % 360;
          if (Math.abs(a - b) > 180) { cost += r.count; break; }
        }
      }
      if (cost < bestCost - 0.5 || (cost <= bestCost && Math.abs(c) < Math.abs(best))) { bestCost = cost; best = c; }
    }
    return best;
  }

  // ---------- replay
  function drawReplay() {
    const { list, i, t } = replayState;
    gReplay.selectAll('path.replay-done').data(list.slice(0, i), f => f.id).join('path')
      .attr('class', 'replay-done').attr('d', f => path(line(f)));
    const cur = list[i];
    if (!cur) { gReplay.selectAll('.replay-trail,.plane').remove(); return; }
    const interp = d3.geoInterpolate([cur.a.lon, cur.a.lat], [cur.b.lon, cur.b.lat]);
    const p = interp(t), ahead = interp(Math.min(1, t + 0.01)), behind = interp(Math.max(0, t - 0.01));
    gReplay.selectAll('path.replay-trail').data([cur]).join('path').attr('class', 'replay-trail')
      .attr('d', path({ type: 'LineString', coordinates: [[cur.a.lon, cur.a.lat], p] }));
    const P = projection(p), A = projection(ahead), B = projection(behind);
    const ang = P && A && B ? Math.atan2(A[1] - B[1], A[0] - B[0]) * 180 / Math.PI : 0;
    const show = visible(p[0], p[1]) && P;
    gReplay.selectAll('path.plane').data(show ? [cur] : []).join('path').attr('class', 'plane')
      .attr('d', 'M9,0 L-6,-6 L-3,0 L-6,6 Z')
      .attr('transform', show ? `translate(${P}) rotate(${ang}) scale(1.3)` : null);
  }

  const api = {
    update(next) {
      const changedRoutes = next.routes !== data.routes;
      data = next;
      visited = new Set(next.countries || []);
      if (changedRoutes) { center = bestCenter(next.routes); fit = null; ty = 0; }
      render();
    },
    setMode(m) {
      mode = m; k = 1; ty = 0;
      if (m === 'globe') {
        const top = data.airports[0]?.a;
        rot = top ? [-top.lon, -Math.max(-40, Math.min(40, top.lat * 0.8))] : [0, -20];
      } else { center = bestCenter(data.routes); fit = null; }
      render();
    },
    setColorBy(c) { colorBy = c; render(); },
    highlightRoutes(keys) { setHighlight(keys?.length ? keys : null, true); },
    reset() { api.setMode(mode); },
    zoomBy(f) { zoomAt(k * f); },
    replay(list, { onFrame, onEnd, speed = () => 1 }) {
      api.stopReplay();
      if (!list.length) return;
      replayState = { list, i: 0, t: 0, paused: false };
      let last = performance.now();
      const step = now => {
        if (!replayState) return;
        const dt = Math.min(64, now - last); last = now;
        if (!replayState.paused) {
          const cur = list[replayState.i];
          const legMs = Math.max(450, Math.min(2400, 300 + (cur.dist || 500) / 6)) / speed();
          replayState.t += dt / legMs;
          if (replayState.t >= 1) { replayState.i++; replayState.t = 0; }
          if (mode === 'globe' && list[replayState.i]) {
            const c = list[replayState.i], p = d3.geoInterpolate([c.a.lon, c.a.lat], [c.b.lon, c.b.lat])(replayState.t);
            const target = [-p[0], -Math.max(-60, Math.min(60, p[1]))];
            let dl = target[0] - rot[0]; dl = ((dl + 540) % 360) - 180;
            rot = [rot[0] + dl * 0.06, rot[1] + (target[1] - rot[1]) * 0.06];
          }
          if (replayState.i >= list.length) { const s = replayState; replayState.i = list.length; render(); onFrame?.(s); api.stopReplay(); onEnd?.(); return; }
        }
        render();
        onFrame?.(replayState);
        replayState.raf = requestAnimationFrame(step);
      };
      replayState.raf = requestAnimationFrame(step);
    },
    pauseReplay(p) { if (replayState) replayState.paused = p; },
    get replaying() { return !!replayState; },
    stopReplay() {
      if (!replayState) return;
      cancelAnimationFrame(replayState.raf);
      replayState = null;
      gReplay.selectAll('*').remove();
      render();
    },
    rerender: () => render(),
  };
  return api;
}
