(() => {
  'use strict';
  const HOME = 'SK8 4NB';
  const RADIUS_KM = 25;
  const root = document.getElementById('watch');
  const $ = (s) => root.querySelector(s);
  const fmt = d3.format(',');
  const when = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London' });
  const showTime = (s) => (s ? when.format(new Date(s)) : '—');
  const levelColor = ['transparent', 'var(--yellow)', 'var(--amber)', 'var(--red)'];
  const kindColor = (e) => (e.kind === 'power' ? 'var(--power)' : e.kind === 'flood' ? 'var(--flood)' : levelColor[e.level]);
  const isPlanned = (e) => e.kind === 'power' && e.level === 1;

  const data = { events: null, feeds: null, forecast: null, outcodes: null, basemap: null };
  let place = null;
  let view = 'uk';

  // ---------- storage (per-browser conveniences only) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  // ---------- geography ----------
  const rad = Math.PI / 180;
  const km = (a, b) => 6371 * Math.hypot((b.lon - a.lon) * rad * Math.cos(((a.lat + b.lat) / 2) * rad), (b.lat - a.lat) * rad);
  const normPc = (txt) => (txt || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const prettyPc = (t) => (t.length >= 5 ? t.slice(0, -3) + ' ' + t.slice(-3) : t);

  async function lookup(text) {
    const t = normPc(text);
    if (!t) throw new Error('Enter a postcode.');
    if (t.length >= 5) {
      try {
        const r = await fetch('https://api.postcodes.io/postcodes/' + encodeURIComponent(t));
        if (r.ok) {
          const p = (await r.json()).result;
          return { label: p.postcode, outcode: p.outcode, lat: p.latitude, lon: p.longitude,
            areas: new Set([p.admin_district, p.admin_county].filter(Boolean)), exact: true };
        }
        if (r.status === 404) throw new Error(`We couldn't find ${prettyPc(t)}. Check the postcode and try again.`);
      } catch (e) {
        if (e.message.startsWith('We couldn')) throw e;
      }
    }
    const out = t.length >= 5 ? t.slice(0, -3) : t;
    const o = (data.outcodes || []).find((x) => x.outcode === out);
    if (!o) throw new Error(`We couldn't find the postcode district ${out}. Check the postcode and try again.`);
    return { label: t.length >= 5 ? prettyPc(t) : out, outcode: o.outcode, lat: o.lat, lon: o.lon,
      areas: new Set([...o.districts.split('|'), ...o.counties.split('|')].filter(Boolean)), exact: false };
  }

  async function reverse(lat, lon) {
    const r = await fetch(`https://api.postcodes.io/postcodes?lat=${lat}&lon=${lon}&limit=1&radius=2000`);
    const p = r.ok ? (await r.json()).result?.[0] : null;
    if (!p) throw new Error('No UK postcode found near your location.');
    return p.postcode;
  }

  // ---------- near-you analysis ----------
  function analyse() {
    if (!place || !data.events) return null;
    const mine = [];
    for (const e of data.events) {
      if (e.kind === 'weather') {
        if (e.areas.split('|').some((a) => place.areas.has(a))) mine.push({ ...e, km: null });
      } else if (e.lat != null) {
        const d = km(place, e);
        if (d <= RADIUS_KM) mine.push({ ...e, km: Math.round(d * 10) / 10 });
      }
    }
    const s = { weather_n: 0, weather_level: 0, power_n: 0, customers: 0, unknown: 0, power_close: 0, planned_n: 0, planned_close: 0, flood_n: 0, flood_level: 0, flood_max: 0 };
    for (const r of mine) {
      if (r.kind === 'weather') { s.weather_n++; s.weather_level = Math.max(s.weather_level, r.level); }
      else if (isPlanned(r)) { s.planned_n++; if (r.km <= 5) s.planned_close++; }
      else if (r.kind === 'power') { s.power_n++; if (r.customers == null) s.unknown++; else s.customers += r.customers; if (r.km <= 5) s.power_close++; }
      else if (r.kind === 'flood') { s.flood_n++; s.flood_max = Math.max(s.flood_max, r.level); s.flood_level = Math.max(s.flood_level, r.km <= 10 ? r.level : Math.min(r.level, 1)); }
    }
    let fcRows = [];
    if (data.forecast && data.forecast.length) {
      let best = null, bd = Infinity;
      for (const f of data.forecast) { const d = km(place, f); if (d < bd) { bd = d; best = f.cell; } }
      fcRows = data.forecast.filter((f) => f.cell === best).sort((a, b) => d3.ascending(a.day, b.day));
    }
    return { mine, s, fcRows };
  }
  const fcLevel = (r) => Math.max(r.gust_mph >= 60 ? 2 : r.gust_mph >= 45 ? 1 : 0, r.rain_mm >= 30 ? 2 : r.rain_mm >= 15 ? 1 : 0,
    r.snow_cm >= 5 ? 2 : r.snow_cm >= 1 ? 1 : 0, r.tmin_c <= -5 ? 1 : 0);

  // ---------- rendering helpers ----------
  const pill = (color, text, shape) => {
    const s = document.createElement('span'); s.className = 'ow-pill';
    const i = document.createElement('i'); i.className = 'ow-sw' + (shape ? ' ' + shape : '');
    if (shape === 'ring') i.style.borderColor = color; else i.style.background = color;
    s.append(i, document.createTextNode(text)); return s;
  };
  const cell = (tr, text, cls) => { const td = tr.insertCell(); td.textContent = text == null ? '—' : text; if (cls) td.className = cls; return td; };
  const note = (tbody, cols, msg) => { const tr = tbody.insertRow(); const td = tr.insertCell(); td.colSpan = cols; td.className = 'ow-empty'; td.textContent = msg; };

  function render() {
    const a = analyse();
    $('.ow-checked').textContent = data.feeds && data.feeds.length ? showTime(data.feeds[0].checked) : '—';
    root.querySelectorAll('.ow-pcname').forEach((n) => { n.textContent = place ? place.label : 'you'; });
    renderPlaces();
    renderStatus(a);
    renderTiles(a);
    renderNear(a);
    renderForecast(a);
    renderUk();
    renderWarnings(a);
    renderNetworks();
    renderFeeds();
    drawMap(a);
  }

  function renderStatus(a) {
    const status = $('#status'), badge = status.querySelector('.ow-badge'), head = status.querySelector('.ow-headline'), take = status.querySelector('.ow-take');
    take.replaceChildren();
    if (!a) { status.dataset.level = '0'; badge.textContent = 'Loading'; head.textContent = place ? 'Checking your area…' : 'Enter a postcode'; return; }
    const { s, mine, fcRows } = a;
    const fcMax = fcRows.reduce((m, r) => Math.max(m, fcLevel(r)), 0);
    const power = s.power_close ? 2 : (s.power_n || s.planned_close) ? 1 : 0;
    const level = Math.max(s.weather_level, s.flood_level, power, fcMax);
    status.dataset.level = String(level);
    badge.textContent = ['All clear', 'Be aware', 'Be prepared', 'Take action'][level];
    head.textContent = level === 0 ? `Nothing is affecting ${place.label} right now` : level === 3 ? `Severe conditions around ${place.label}` : `Conditions to watch around ${place.label}`;
    const parts = [];
    const ws = mine.filter((r) => r.kind === 'weather').sort((x, y) => y.level - x.level);
    if (ws.length) {
      const w = ws[0], started = w.start && new Date(w.start) <= new Date();
      parts.push(`${w.label.replace(/^\w/, (c) => c.toUpperCase())} ${started ? 'in force until ' + showTime(w.end) : 'from ' + showTime(w.start)}${ws.length > 1 ? `, plus ${ws.length - 1} more` : ''}.`);
    } else parts.push('No Met Office warnings for this area.');
    if (s.power_n) parts.push(`${fmt(s.power_n)} live power cut${s.power_n === 1 ? '' : 's'} within ${RADIUS_KM} km${s.customers ? `, ${fmt(s.customers)} properties off` : ''}.`);
    if (s.planned_n) {
      const next = mine.filter(isPlanned).sort((x, y) => d3.ascending(x.start, y.start) || x.km - y.km)[0];
      parts.push(`${fmt(s.planned_n)} planned power cut${s.planned_n === 1 ? '' : 's'} nearby in the next 2 weeks; the next is ${dayFmt.format(new Date(next.start))} in ${next.place || 'your area'}, ${next.km.toFixed(1)} km away.`);
    }
    if (s.flood_n) parts.push(`${fmt(s.flood_n)} flood warning${s.flood_n === 1 ? '' : 's'} or alert${s.flood_n === 1 ? '' : 's'} within ${RADIUS_KM} km.`);
    if (fcMax) {
      const top = fcRows.slice().sort((x, y) => fcLevel(y) - fcLevel(x) || y.gust_mph - x.gust_mph)[0];
      parts.push(`Forecast: gusts to ${Math.round(top.gust_mph)} mph and ${top.rain_mm.toFixed(1)} mm of rain on ${dayFmt.format(new Date(top.day + 'T12:00:00Z'))}.`);
    }
    if (level === 0) parts.push('A good time to check your emergency kit.');
    if (level >= 2) parts.push('Charge phones and power banks and check the advice below.');
    take.textContent = parts.join(' ');
  }

  function renderTiles(a) {
    const s = a && a.s;
    root.querySelectorAll('#near-tiles [data-k]').forEach((m) => { m.textContent = s ? fmt(s[m.dataset.k]) : '—'; });
    $('.ow-wn').textContent = s ? (s.weather_n ? ['', 'Highest: yellow', 'Highest: amber', 'Highest: red'][s.weather_level] : 'None in force or due') : '';
    $('.ow-pn').textContent = s ? `${s.customers ? fmt(s.customers) + ' properties off' : 'No property counts'}${s.unknown ? ` (${s.unknown} unreported)` : ''} · ${fmt(s.planned_n)} planned in 2 weeks` : '';
    $('.ow-fn').textContent = s ? (s.flood_n ? ['', 'Highest: flood alert', 'Highest: flood warning', 'Highest: severe flood warning'][s.flood_max] : 'England only for now') : '';
    const g = a && a.fcRows.length ? Math.round(d3.max(a.fcRows, (r) => r.gust_mph)) : null;
    $('.ow-gust').textContent = g == null ? '—' : fmt(g);
    $('.ow-gn').textContent = g == null ? 'Forecast not available yet' : 'mph at the nearest forecast point';
  }

  function renderNear(a) {
    const tb = $('.ow-near tbody'); tb.replaceChildren();
    if (!a) return;
    const rows = a.mine.slice().sort((x, y) => (x.km ?? -1) - (y.km ?? -1) || y.level - x.level);
    if (!rows.length) return note(tb, 4, 'Nothing reported nearby in the connected feeds.');
    for (const r of rows.slice(0, 100)) {
      const tr = tb.insertRow();
      tr.insertCell().append(pill(kindColor(r), r.label, r.kind === 'flood' ? 'sq' : isPlanned(r) ? 'ring' : ''));
      const where = isPlanned(r) ? `${r.place} · ${r.network} · ${dayFmt.format(new Date(r.start))}`
        : r.kind === 'power' ? `${r.place || r.title} · ${r.network}${r.customers == null ? '' : ' · ' + fmt(r.customers) + ' off'}`
        : r.kind === 'weather' ? r.place : r.title;
      const td = cell(tr, '');
      if (r.link) { const l = document.createElement('a'); l.href = r.link; l.rel = 'noopener'; l.target = '_blank'; l.textContent = where; td.append(l); } else td.textContent = where;
      cell(tr, r.km == null ? 'Area' : r.km.toFixed(1), 'num');
      cell(tr, isPlanned(r) ? 'End of ' + dayFmt.format(new Date(r.end || r.start)) : r.end ? showTime(r.end) : r.kind === 'flood' ? 'Until lifted' : '—');
    }
  }

  function renderForecast(a) {
    const tb = $('.ow-fc tbody'); tb.replaceChildren();
    if (!a) return;
    if (!a.fcRows.length) return note(tb, 5, 'The forecast is not available yet. It fills in on the next hourly update.');
    for (const r of a.fcRows) {
      const tr = tb.insertRow();
      cell(tr, dayFmt.format(new Date(r.day + 'T12:00:00Z')));
      const hi = (td, l) => { if (l) td.classList.add('ow-hi' + l); };
      hi(cell(tr, Math.round(r.gust_mph), 'num'), r.gust_mph >= 60 ? 2 : r.gust_mph >= 45 ? 1 : 0);
      hi(cell(tr, r.rain_mm.toFixed(1), 'num'), r.rain_mm >= 30 ? 2 : r.rain_mm >= 15 ? 1 : 0);
      hi(cell(tr, r.snow_cm.toFixed(1), 'num'), r.snow_cm >= 5 ? 2 : r.snow_cm >= 1 ? 1 : 0);
      hi(cell(tr, r.tmin_c.toFixed(1), 'num'), r.tmin_c <= -5 ? 1 : 0);
    }
  }

  function renderUk() {
    const ev = data.events || [];
    const live = ev.filter((e) => e.kind === 'power' && !isPlanned(e));
    const n = { weather: ev.filter((e) => e.kind === 'weather').length, power: live.length, flood: ev.filter((e) => e.kind === 'flood').length };
    root.querySelectorAll('[data-uk]').forEach((m) => { m.textContent = data.events ? fmt(n[m.dataset.uk]) : '—'; });
    $('[data-uk-c="power"]').textContent = data.events ? fmt(d3.sum(live, (e) => e.customers || 0)) : '—';
  }

  function renderWarnings(a) {
    const tb = $('.ow-mo tbody'); tb.replaceChildren();
    if (!data.events) return;
    const mineIds = new Set(a ? a.mine.map((r) => r.id) : []);
    const ws = data.events.filter((e) => e.kind === 'weather').sort((x, y) => y.level - x.level || d3.ascending(x.start, y.start));
    if (!ws.length) return note(tb, 4, 'No Met Office warnings in force or due.');
    for (const w of ws) {
      const tr = tb.insertRow();
      tr.insertCell().append(pill(levelColor[w.level], w.label));
      const pl = cell(tr, w.place + ' ');
      if (mineIds.has(w.id)) { const t = document.createElement('span'); t.className = 'ow-tag you'; t.textContent = 'Your area'; pl.append(t); }
      cell(tr, showTime(w.start)); cell(tr, showTime(w.end));
    }
  }

  function renderNetworks() {
    const tb = $('.ow-net tbody'); tb.replaceChildren();
    if (!data.events) return;
    const rows = d3.rollups(data.events.filter((e) => e.kind === 'power' && !isPlanned(e)), (v) => ({ n: v.length, c: d3.sum(v, (e) => e.customers || 0), unk: v.every((e) => e.customers == null) }), (e) => e.network)
      .sort((x, y) => y[1].c - x[1].c || y[1].n - x[1].n);
    for (const [net, v] of rows) { const tr = tb.insertRow(); cell(tr, net); cell(tr, fmt(v.n), 'num'); cell(tr, v.unk ? 'Not published' : fmt(v.c), 'num'); }
  }

  function renderFeeds() {
    const tb = $('.ow-feeds tbody'); tb.replaceChildren();
    for (const r of data.feeds || []) {
      const tr = tb.insertRow();
      cell(tr, r.provider); cell(tr, r.feed); cell(tr, r.coverage);
      const st = tr.insertCell(); const t = document.createElement('span');
      t.className = 'ow-tag ' + (r.status === 'live' ? 'live' : r.status === 'failed' ? 'failed' : ''); t.textContent = r.status; st.append(t);
      cell(tr, fmt(r.items), 'num'); cell(tr, r.note || '');
    }
  }

  // ---------- map ----------
  const map = { svg: null, zoom: null, k: 1, W: 0, H: 0, P: null };
  function drawMap(a) {
    const box = $('.ow-map'), tip = box.querySelector('.ow-tip'), detail = $('.ow-detail');
    if (!data.basemap || !data.outcodes || !data.events) return;
    const W = Math.max(280, box.clientWidth);
    const H = Math.round(Math.min(W * 1.35, 760));
    const b = { x0: -8.4, x1: 2.0, y0: 49.8, y1: 60.95 };
    const k0 = Math.cos(55 * rad);
    const s = Math.min(W / ((b.x1 - b.x0) * k0), H / (b.y1 - b.y0));
    const ox = (W - (b.x1 - b.x0) * k0 * s) / 2, oy = (H - (b.y1 - b.y0) * s) / 2;
    const P = (lon, lat) => [ox + (lon - b.x0) * k0 * s, oy + (b.y1 - lat) * s];
    Object.assign(map, { W, H, P });
    box.querySelectorAll('svg').forEach((n) => n.remove());
    box.style.minHeight = H + 'px';

    const svg = d3.select(box).append('svg').attr('width', '100%').attr('height', H).attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', 'Map of current incidents');
    const g = svg.append('g');
    const rings = data.basemap.flatMap((r) => JSON.parse(r.rings));
    const line = (ring) => 'M' + ring.map(([x, y]) => P(x, y).map((v) => v.toFixed(1)).join(',')).join('L') + 'Z';
    g.append('path').attr('d', rings.map(line).join('')).attr('fill', 'var(--panel)').attr('stroke', 'var(--chart-muted)').attr('stroke-width', 0.8).attr('vector-effect', 'non-scaling-stroke');

    const wsets = data.events.filter((e) => e.kind === 'weather').map((w) => ({ w, a: new Set(w.areas.split('|')) }));
    const pts = data.outcodes.map((o) => {
      const names = [...o.districts.split('|'), ...o.counties.split('|')];
      let lv = 0; const ws = [];
      for (const x of wsets) if (names.some((n) => x.a.has(n))) { lv = Math.max(lv, x.w.level); ws.push(x.w); }
      const [x, y] = P(o.lon, o.lat);
      return { x, y, o, lv, ws, r: lv ? 2.2 : 1.6 };
    });
    const items = data.events.filter((e) => e.kind !== 'weather' && e.lat != null).map((e) => { const [x, y] = P(e.lon, e.lat); return { e, x, y }; });
    const pw = items.filter((d) => d.e.kind === 'power').sort((x, y) => (y.e.customers || 0) - (x.e.customers || 0));
    const rs = d3.scaleSqrt([0, d3.max(pw, (d) => d.e.customers || 0) || 1], [2.5, 11]);
    pw.forEach((d) => { d.r = rs(d.e.customers || 0); });
    const fl = items.filter((d) => d.e.kind === 'flood');

    const gDots = g.append('g'), gFlood = g.append('g'), gPower = g.append('g'), gHome = g.append('g');
    const dots = gDots.selectAll('circle').data(pts).join('circle').attr('cx', (d) => d.x).attr('cy', (d) => d.y)
      .attr('fill', (d) => (d.lv ? levelColor[d.lv] : 'var(--chart-muted)')).attr('fill-opacity', (d) => (d.lv ? 0.85 : 0.35));
    const floods = gFlood.selectAll('rect').data(fl).join('rect').attr('fill', 'var(--flood)').attr('fill-opacity', (d) => 0.45 + d.e.level * 0.18)
      .attr('stroke', 'var(--panel)').attr('vector-effect', 'non-scaling-stroke');
    const power = gPower.selectAll('circle').data(pw).join('circle').attr('cx', (d) => d.x).attr('cy', (d) => d.y)
      .attr('fill', (d) => (isPlanned(d.e) ? 'none' : 'var(--power)')).attr('fill-opacity', 0.55)
      .attr('stroke', 'var(--power)').attr('stroke-width', (d) => (isPlanned(d.e) ? 1.5 : 0.8)).attr('vector-effect', 'non-scaling-stroke');

    let hx = null, hy = null;
    const homeRing = gHome.append('ellipse').attr('fill', 'none').attr('stroke', 'var(--fg)').attr('stroke-width', 1.2).attr('stroke-dasharray', '4 3').attr('vector-effect', 'non-scaling-stroke');
    const homeDot = gHome.append('circle').attr('fill', 'var(--fg)').attr('stroke', 'var(--panel)').attr('stroke-width', 2).attr('vector-effect', 'non-scaling-stroke');
    const homeLab = gHome.append('text').attr('fill', 'var(--fg)').attr('font-weight', 600).attr('paint-order', 'stroke').attr('stroke', 'var(--panel)').attr('stroke-width', 3);
    if (place) {
      [hx, hy] = P(place.lon, place.lat);
      homeRing.attr('cx', hx).attr('cy', hy).attr('rx', (RADIUS_KM / (111.2 * Math.cos(place.lat * rad))) * k0 * s).attr('ry', (RADIUS_KM / 111.2) * s);
      homeLab.text(place.label);
    }

    const sizeFor = (k) => {
      const z = Math.sqrt(k);
      dots.attr('r', (d) => (d.r * Math.min(z, 2.5)) / k);
      power.attr('r', (d) => (d.r * Math.min(z, 2)) / k);
      const fs = (5 * Math.min(z, 2)) / k;
      floods.attr('x', (d) => d.x - fs / 2).attr('y', (d) => d.y - fs / 2).attr('width', fs).attr('height', fs).attr('transform', (d) => `rotate(45 ${d.x} ${d.y})`);
      if (place) { homeDot.attr('cx', hx).attr('cy', hy).attr('r', 5 / k); homeLab.attr('x', hx + 9 / k).attr('y', hy - 8 / k).attr('font-size', 12 / k).attr('stroke-width', 3 / k); }
    };
    const zoom = d3.zoom().scaleExtent([1, 40]).translateExtent([[-W * 0.2, -H * 0.2], [W * 1.2, H * 1.2]])
      .on('zoom', (ev) => { g.attr('transform', ev.transform); map.k = ev.transform.k; sizeFor(ev.transform.k); tip.hidden = true; });
    svg.call(zoom).on('dblclick.zoom', null);
    Object.assign(map, { svg, zoom });
    const target = view === 'local' && place ? d3.zoomIdentity.translate(W / 2, H / 2).scale(9).translate(-hx, -hy) : d3.zoomIdentity;
    svg.call(zoom.transform, target);

    // Picking: nearest marker to the pointer, in screen pixels
    const pick = [...items, ...pts.filter((d) => d.lv)];
    const describe = (d, el) => {
      el.replaceChildren();
      const l1 = document.createElement('div'); l1.className = 't';
      const l2 = document.createElement('div');
      if (d.e) {
        const e = d.e;
        l1.textContent = e.kind === 'power' ? e.network : `${e.label} · ${e.place || ''}`;
        l2.textContent = isPlanned(e) ? `Planned work in ${e.place || 'this area'} on ${dayFmt.format(new Date(e.start))}.`
          : e.kind === 'power' ? `${e.title}${e.place ? ' (' + e.place + ')' : ''}: ${e.customers == null ? 'properties affected not published' : fmt(e.customers) + ' properties off'}. Since ${showTime(e.start)}${e.end ? ', expected back ' + showTime(e.end) : ''}.`
          : e.title;
        el.append(l1, l2);
        if (el === detail && e.link) { const a2 = document.createElement('a'); a2.href = e.link; a2.target = '_blank'; a2.rel = 'noopener'; a2.textContent = 'More from ' + e.network; el.append(a2); }
      } else {
        l1.textContent = `${d.o.outcode} · ${d.o.districts.split('|').join(', ')}`;
        l2.textContent = d.ws.map((w) => `${w.label}, ${showTime(w.start)} to ${showTime(w.end)}`).join('; ');
        el.append(l1, l2);
      }
    };
    const nearest = (ev) => {
      const t = d3.zoomTransform(svg.node());
      const rect = svg.node().getBoundingClientRect(), sc = W / rect.width;
      const [mx, my] = [(ev.clientX - rect.left) * sc, (ev.clientY - rect.top) * sc];
      let best = null, bd = 22;
      for (const d of pick) { const dd = Math.hypot(t.applyX(d.x) - mx, t.applyY(d.y) - my); if (dd < bd) { bd = dd; best = d; } }
      return best ? { d: best, x: t.applyX(best.x) / sc, y: t.applyY(best.y) / sc } : null;
    };
    svg.on('pointermove', (ev) => {
      if (ev.pointerType !== 'mouse') return;
      const n = nearest(ev);
      if (!n) { tip.hidden = true; return; }
      describe(n.d, tip); tip.hidden = false;
      const bw = box.clientWidth, tw = Math.min(260, bw - 16);
      tip.style.left = Math.max(4, Math.min(bw - tw - 4, n.x + 12)) + 'px';
      tip.style.top = Math.max(4, n.y + 14 + tip.offsetHeight > box.clientHeight ? n.y - tip.offsetHeight - 10 : n.y + 14) + 'px';
    }).on('pointerleave', () => { tip.hidden = true; })
      .on('click', (ev) => { const n = nearest(ev); detail.hidden = !n; if (n) describe(n.d, detail); });
  }

  // ---------- places ----------
  function renderPlaces() {
    const box = $('#ow-places'); box.replaceChildren();
    const places = store.get('ow.places', [HOME]);
    for (const p of places) {
      const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'ow-chip';
      chip.setAttribute('aria-current', String(!!place && place.label === p));
      chip.append(document.createTextNode(p === HOME ? `${p} (home)` : p));
      chip.addEventListener('click', () => go(p));
      if (p !== HOME) {
        const x = document.createElement('span'); x.className = 'x'; x.textContent = '×'; x.title = `Remove ${p}`; x.setAttribute('role', 'button');
        x.addEventListener('click', (e) => { e.stopPropagation(); store.set('ow.places', places.filter((q) => q !== p)); renderPlaces(); });
        chip.append(x);
      }
      box.append(chip);
    }
  }

  const input = $('#ow-postcode'), err = $('.ow-err');
  async function go(text) {
    err.hidden = true;
    try {
      place = await lookup(text);
      input.value = place.label;
      store.set('ow.current', place.label);
      const url = new URL(location.href); url.searchParams.set('pc', place.label); history.replaceState(null, '', url);
      render();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  }
  $('#pc-form').addEventListener('submit', (e) => { e.preventDefault(); go(input.value); });
  $('#ow-save').addEventListener('click', () => {
    if (!place) return;
    const places = store.get('ow.places', [HOME]);
    if (!places.includes(place.label)) { places.push(place.label); store.set('ow.places', places); }
    renderPlaces();
  });
  $('#ow-locate').addEventListener('click', () => {
    if (!navigator.geolocation) { err.textContent = 'Location is not available in this browser.'; err.hidden = false; return; }
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try { go(await reverse(pos.coords.latitude, pos.coords.longitude)); } catch (e) { err.textContent = e.message; err.hidden = false; }
    }, () => { err.textContent = 'Location permission was declined. Type a postcode instead.'; err.hidden = false; }, { timeout: 10000 });
  });
  root.querySelectorAll('.ow-v').forEach((b) => b.addEventListener('click', () => {
    view = b.dataset.view;
    root.querySelectorAll('.ow-v').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    drawMap(analyse());
  }));
  root.querySelector('.ow-v[data-view="uk"]').setAttribute('aria-pressed', 'true');
  root.querySelector('.ow-v[data-view="local"]').setAttribute('aria-pressed', 'false');
  let lastW = 0;
  new ResizeObserver(() => { const w = $('.ow-map').clientWidth; if (Math.abs(w - lastW) > 20) { lastW = w; drawMap(analyse()); } }).observe($('.ow-map'));

  // ---------- data loading ----------
  async function load(name, opts = {}) {
    const r = await fetch(`data/${name}.json${opts.fresh ? '?t=' + Date.now() : ''}`, { cache: opts.fresh ? 'no-cache' : 'default' });
    if (!r.ok) throw new Error(name);
    return r.json();
  }
  async function refresh() {
    const [events, feeds, forecast] = await Promise.all(['events', 'feeds', 'forecast'].map((n) => load(n, { fresh: true }).catch(() => null)));
    if (events) data.events = events;
    if (feeds) data.feeds = feeds;
    if (forecast) data.forecast = forecast;
    render();
  }
  (async () => {
    const [outcodes, basemap] = await Promise.all([load('outcodes'), load('basemap')]);
    Object.assign(data, { outcodes, basemap });
    const start = new URL(location.href).searchParams.get('pc') || store.get('ow.current', HOME);
    await refresh();
    await go(start);
    setInterval(refresh, 10 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  })().catch(() => { $('.ow-headline').textContent = 'Could not load the data. Check your connection and reload.'; });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
