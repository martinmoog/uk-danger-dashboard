"""Fetch the public UK feeds and write events.json, feeds.json and forecast.json for the site.

Usage: python scripts/refresh.py OUT_DIR scripts/ref.json [PREVIOUS_EVENTS_JSON]

When a feed fails, its incidents from PREVIOUS_EVENTS_JSON are kept and the feed is marked stale.

API keys come from the environment: ENWL_API_KEY (Electricity North West) and
SPEN_API_KEY (SP Energy Networks). A network whose key is missing is listed as
not connected instead of failing the run.
"""
import csv, io, json, os, re, sys, time, gzip, html, hashlib, urllib.parse, urllib.request, xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
OUT = sys.argv[1]
UK = ZoneInfo('Europe/London')
NOW = datetime.now(timezone.utc)
STAMP = NOW.strftime('%Y-%m-%dT%H:%M:%SZ')
REF = json.load(open(sys.argv[2]))
DISTRICTS, COUNTIES, ALIAS, GRID = REF['districts'], REF['counties'], REF['alias'], REF['grid']
class SkipRun(Exception): pass
class NoKey(Exception): pass
def norm(s):
    s = html.unescape(s).lower().replace('&', ' and ').replace("'", '')
    s = re.sub(r'[^a-z0-9]+', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()
def strip(s):
    s = norm(s)
    for pat in (r'\bcouncil\b', r'^the ', r'\bcity of\b', r'\bcounty of\b', r'\bcity\b', r'^county '):
        s = re.sub(pat, ' ', s).strip()
    return re.sub(r'\s+', ' ', s)
EXACT = {norm(n): n for n in DISTRICTS + COUNTIES}
LOOSE = {}
for n in DISTRICTS + COUNTIES:
    LOOSE.setdefault(strip(n), n)
UNMATCHED = set()
def resolve(name):
    k = norm(name)
    if k in ALIAS: return ALIAS[k]
    if k in EXACT: return [EXACT[k]]
    k2 = strip(name)
    if k2 in ALIAS: return ALIAS[k2]
    if k2 in LOOSE: return [LOOSE[k2]]
    UNMATCHED.add(name.strip()); return []

KEYS = {'electricitynorthwest.opendatasoft.com': os.environ.get('ENWL_API_KEY', ''),
        'spenergynetworks.opendatasoft.com': os.environ.get('SPEN_API_KEY', '')}

def get(url, timeout=60, tries=3):
    headers = {'User-Agent': 'uk-danger-dashboard/1.0 (+https://github.com/martinmoog/uk-danger-dashboard)', 'Accept-Encoding': 'gzip'}
    key = KEYS.get(urllib.parse.urlsplit(url).hostname)
    if key: headers['Authorization'] = 'Apikey ' + key
    req = urllib.request.Request(url, headers=headers)
    last = None
    for i in range(tries):
        if i: time.sleep(4 * i)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                b = r.read()
                if r.headers.get('Content-Encoding') == 'gzip' or b[:2] == b'\x1f\x8b': b = gzip.decompress(b)
                return b
        except Exception as e:
            last = e
    raise last

def rows_of(url):
    # opendatasoft exports sometimes come back as an empty list; treat that as a failed fetch and retry
    for i in range(3):
        if i: time.sleep(10)
        rows = json.loads(get(url, 90, 8))
        if rows: return rows
    raise RuntimeError('empty export')

def iso(dt):
    return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ') if dt else None
def clean(s, n=300):
    s = re.sub(r'<[^>]+>', ' ', html.unescape(s or ''))
    s = re.sub(r'\s+', ' ', s).strip()
    return s if len(s) <= n else s[:n - 1].rsplit(' ', 1)[0] + '…'

events, feeds = [], []
# The previous events file (optional third argument): when a feed fails, its last good incidents are kept.
PREV = []
if len(sys.argv) > 3:
    try: PREV = json.load(open(sys.argv[3]))
    except Exception: PREV = []

def feed(name, provider, coverage, fn, prefix=None):
    start = len(events)
    try:
        n, note = fn()
        feeds.append({'feed': name, 'provider': provider, 'coverage': coverage, 'status': 'live', 'items': n, 'checked': STAMP, 'note': note})
    except NoKey:
        feeds.append({'feed': name, 'provider': provider, 'coverage': coverage, 'status': 'not connected', 'items': 0, 'checked': STAMP, 'note': 'API key not set for this deployment.'})
    except SkipRun:
        feeds.append({'feed': name, 'provider': provider, 'coverage': coverage, 'status': 'live', 'items': 0, 'checked': STAMP, 'note': 'Refreshes every 3 hours; showing the last copy.'})
    except Exception as e:
        del events[start:]
        kept = [x for x in PREV if prefix and x.get('id', '').startswith(prefix)]
        if kept:
            events.extend(kept)
            feeds.append({'feed': name, 'provider': provider, 'coverage': coverage, 'status': 'stale', 'items': len(kept), 'checked': STAMP,
                          'note': f'Latest fetch failed ({type(e).__name__}); showing the previous update.'})
        else:
            feeds.append({'feed': name, 'provider': provider, 'coverage': coverage, 'status': 'failed', 'items': 0, 'checked': STAMP, 'note': f'Could not fetch this run ({type(e).__name__}).'})

# ---- Met Office weather warnings
def metoffice():
    root = ET.fromstring(get('https://www.metoffice.gov.uk/public/data/PWSCache/WarningsRSS/Region/UK'))
    n = 0
    for it in root.iter('item'):
        title = html.unescape(it.findtext('title') or ''); desc = html.unescape(it.findtext('description') or '')
        m = re.match(r'(Yellow|Amber|Red) warning of (.+?) affecting (.+)$', title)
        if not m: continue
        colour, hazard, region = m.groups()
        body = desc.split(':', 1)[1] if ':' in desc else ''
        tm = re.search(r'valid from (\d{4}) \w{3} (\d{1,2}) (\w{3}) to (\d{4}) \w{3} (\d{1,2}) (\w{3})', body)
        start = end = None
        if tm:
            def when(hhmm, d, mon):
                best = None
                for y in (NOW.year - 1, NOW.year, NOW.year + 1):
                    try: dt = datetime.strptime(f'{y} {mon} {d} {hhmm}', '%Y %b %d %H%M').replace(tzinfo=UK)
                    except ValueError: continue
                    if best is None or abs(dt - NOW) < abs(best - NOW): best = dt
                return best
            start, end = when(tm.group(1), tm.group(2), tm.group(3)), when(tm.group(4), tm.group(5), tm.group(6))
            body = body[:tm.start()]
        names = [x.strip() for x in body.split(',') if x.strip()]
        areas = sorted({a for nm in names for a in resolve(nm)})
        if end and end < NOW: continue
        link = html.unescape(it.findtext('link') or '')
        events.append({'id': 'mo-' + hashlib.sha1((it.findtext('guid') or title).encode()).hexdigest()[:12], 'kind': 'weather',
            'level': {'Yellow': 1, 'Amber': 2, 'Red': 3}[colour], 'label': f'{colour} warning: {hazard}', 'title': title,
            'place': region, 'lat': None, 'lon': None, 'areas': '|'.join(areas), 'start': iso(start), 'end': iso(end),
            'customers': None, 'network': 'Met Office', 'link': link, 'detail': clean(', '.join(names), 400)})
        n += 1
    note = 'Unmatched area names: ' + ', '.join(sorted(UNMATCHED)) if UNMATCHED else ''
    return n, note
feed('Weather warnings', 'Met Office', 'All UK', metoffice, 'mo-')

# ---- Environment Agency flood warnings (England)
def ea():
    floods = json.loads(get('https://environment.data.gov.uk/flood-monitoring/id/floods'))['items']
    active = [f for f in floods if f.get('severityLevel') in (1, 2, 3)]
    areas = {a['notation']: a for a in json.loads(get('https://environment.data.gov.uk/flood-monitoring/id/floodAreas?_limit=10000', 120))['items']}
    for f in active:
        a = areas.get(f.get('floodAreaID'))
        if a is None:
            try: a = json.loads(get('https://environment.data.gov.uk/flood-monitoring/id/floodAreas/' + f['floodAreaID']))['items']
            except Exception: a = {}
        lvl = {1: 3, 2: 2, 3: 1}[f['severityLevel']]
        events.append({'id': 'ea-' + f['floodAreaID'], 'kind': 'flood', 'level': lvl, 'label': f.get('severity') or 'Flood alert',
            'title': f.get('description') or a.get('label') or f['floodAreaID'], 'place': (f.get('floodArea') or {}).get('county') or a.get('county'),
            'lat': a.get('lat'), 'lon': a.get('long'), 'areas': '', 'start': iso(datetime.fromisoformat(f['timeRaised']).replace(tzinfo=UK)) if f.get('timeRaised') else None,
            'end': None, 'customers': None, 'network': 'Environment Agency',
            'link': 'https://check-for-flooding.service.gov.uk/target-area/' + f['floodAreaID'], 'detail': clean(f.get('message'))})
    return len(active), ''
feed('Flood warnings', 'Environment Agency', 'England', ea, 'ea-')

# ---- SSEN power cuts
def ssen():
    faults = json.loads(get('https://ssen-powertrack-api.opcld.com/gridiview/reporter/info/livefaults'))['Faults']
    n = 0
    for f in faults:
        if f.get('resolved'): continue
        c = f.get('affectedCustomerCount') or 0
        net = 'SSEN (North of Scotland)' if f.get('networkId', '').endswith('shepd') else 'SSEN (Southern England)'
        events.append({'id': 'ssen-' + str(f.get('reference')), 'kind': 'power', 'level': 3 if c >= 1000 else 2, 'label': 'Power cut',
            'title': f.get('name') or 'Power cut', 'place': ', '.join((f.get('affectedAreas') or [])[:3]), 'lat': f.get('latitude'), 'lon': f.get('longitude'),
            'areas': '', 'start': iso(datetime.fromisoformat(f['loggedAt'].replace('+0000', '+00:00'))) if f.get('loggedAt') else None,
            'end': iso(datetime.fromisoformat(f['estimatedRestoration'].replace('+0000', '+00:00'))) if f.get('estimatedRestoration') else None,
            'customers': c, 'network': net, 'link': 'https://powertrack.ssen.co.uk/powertrack', 'detail': clean(f.get('message'), 220)})
        n += 1
    return n, 'This feed returns at most 300 incidents.' if len(faults) >= 300 else ''
feed('Power cuts', 'SSEN', 'North of Scotland and central southern England', ssen, 'ssen-')

# ---- National Grid (NGED) power cuts
def nged():
    rows = list(csv.DictReader(io.StringIO(get('https://connecteddata.nationalgrid.co.uk/dataset/d6672e1e-c684-4cea-bb78-c7e5248b62a2/resource/292f788f-4339-455b-8cc0-153e14509d4d/download/power_outage_ext.csv').decode('utf-8-sig'))))
    n = 0
    for r in rows:
        try: lat, lon = float(r['Location Latitude']), float(r['Location Longitude'])
        except (ValueError, KeyError): continue
        planned = r.get('Planned', '').lower() == 'true'
        c = int(r.get('Confirmed Off') or 0) + int(r.get('Predicted Off') or 0)
        pcs = [p.strip() for p in (r.get('Postcodes') or '').split(',') if re.match(r'^[A-Z]{1,2}\d', p.strip())]
        def t(s):
            return iso(datetime.fromisoformat(s).replace(tzinfo=UK)) if s else None
        events.append({'id': 'nged-' + r['Incident ID'], 'kind': 'power', 'level': 1 if planned else (3 if c >= 1000 else 2),
            'label': 'Planned power cut' if planned else 'Power cut', 'title': (r.get('Category') or 'Power cut').title(),
            'place': ', '.join(dict.fromkeys(pcs))[:60], 'lat': lat, 'lon': lon, 'areas': '', 'start': t(r.get('Start Time')), 'end': t(r.get('ETR')),
            'customers': c, 'network': 'National Grid (' + r.get('Region', '') + ')', 'link': 'https://powercuts.nationalgrid.co.uk/',
            'detail': f"Status: {r.get('Status')}. {r.get('Voltage')} network."})
        n += 1
    return n, ''
feed('Power cuts', 'National Grid', 'Midlands, South West England and South Wales', nged, 'nged-')

# ---- UK Power Networks power cuts
def ukpn():
    rows = rows_of('https://ukpowernetworks.opendatasoft.com/api/explore/v2.1/catalog/datasets/ukpn-live-faults/exports/json')
    n = 0
    for r in rows:
        kind = r.get('powercuttype') or ''
        g = r.get('geopoint') or {}
        if kind == 'Restored' or g.get('lat') is None: continue
        planned = kind == 'Planned'
        c = (r.get('nocustomeraffected') or 0) + (r.get('noplannedcustomers') or 0 if planned else 0)
        def t(s):
            return iso(datetime.fromisoformat(s[:19]).replace(tzinfo=UK)) if s else None
        events.append({'id': 'ukpn-' + str(r.get('incidentreference')), 'kind': 'power', 'level': 1 if planned else (3 if c >= 1000 else 2),
            'label': 'Planned power cut' if planned else 'Power cut', 'title': (r.get('operatingzone') or 'Power cut').title(),
            'place': (r.get('postcodesaffected') or '')[:60], 'lat': g['lat'], 'lon': g['lon'], 'areas': '', 'start': t(r.get('creationdatetime')),
            'end': t(r.get('estimatedrestorationdate')), 'customers': c, 'network': 'UK Power Networks', 'link': 'https://www.ukpowernetworks.co.uk/power-cut/map',
            'detail': clean(r.get('mainmessage') or r.get('plannedincidentreason'), 220)})
        n += 1
    return n, ''
feed('Power cuts', 'UK Power Networks', 'London, South East and East of England', ukpn, 'ukpn-')

# ---- Northern Powergrid power cuts (one row per postcode, grouped by incident)
def npg():
    rows = rows_of('https://northernpowergrid.opendatasoft.com/api/explore/v2.1/catalog/datasets/live-power-cuts-data/exports/json')
    inc = {}
    for r in rows:
        if r.get('lat') is None: continue
        x = inc.setdefault(r.get('reference'), {'r': r, 'pcs': []})
        x['pcs'].extend(p.replace('  ', ' ') for p in (r.get('postcode') or []))
    for ref, x in inc.items():
        r = x['r']
        planned = 'plan' in (r.get('natureofoutage') or '').lower()
        c = (r.get('totalconfirmedpowercut') or 0) + (r.get('totalpredictedpowercut') or 0)
        def t(s):
            return iso(datetime.fromisoformat(s)) if s else None
        events.append({'id': 'npg-' + str(ref), 'kind': 'power', 'level': 1 if planned else (3 if c >= 1000 else 2),
            'label': 'Planned power cut' if planned else 'Power cut', 'title': r.get('natureofoutage') or 'Power cut',
            'place': ', '.join(list(dict.fromkeys(x['pcs']))[:3]), 'lat': r['lat'], 'lon': r['lng'], 'areas': '', 'start': t(r.get('loggedtime')),
            'end': t(r.get('estimatedtimetillresolution')), 'customers': c, 'network': 'Northern Powergrid (' + (r.get('area') or '') + ')',
            'link': 'https://www.northernpowergrid.com/power-cuts', 'detail': clean(r.get('reason'), 220)})
    return len(inc), ''
feed('Power cuts', 'Northern Powergrid', 'North East England and Yorkshire', npg, 'npg-')

# ---- Electricity North West live and planned power cuts (needs ENWL_API_KEY)
def enwl():
    if not KEYS['electricitynorthwest.opendatasoft.com']: raise NoKey()
    base = 'https://electricitynorthwest.opendatasoft.com/api/explore/v2.1/catalog/datasets/'
    rows = rows_of(base + 'live_incidents/exports/json')
    n = 0
    for r in rows:
        g = r.get('geo_point_2d') or {}
        if g.get('lat') is None: continue
        c = r.get('customers_off_supply') or r.get('customers_affected') or 0
        events.append({'id': 'enwl-' + str(r.get('incident_num')), 'kind': 'power', 'level': 3 if c >= 1000 else 2, 'label': 'Power cut',
            'title': r.get('incident_type') or 'Power cut', 'place': '', 'lat': g['lat'], 'lon': g['lon'], 'areas': '',
            'start': iso(datetime.fromisoformat(r['outage_time'])) if r.get('outage_time') else None,
            'end': iso(datetime.fromisoformat(r['estimated_restoration_time'])) if r.get('estimated_restoration_time') else None,
            'customers': c, 'network': 'Electricity North West', 'link': 'https://www.enwl.co.uk/power-cuts/', 'detail': f"Status: {r.get('incident_status')}."})
        n += 1
    planned = rows_of(base + 'psi/exports/json')
    soon = NOW.date() + timedelta(days=14)
    for r in planned:
        g = r.get('geo_point_2d') or {}
        if g.get('lat') is None or not r.get('outage_date'): continue
        day = datetime.fromisoformat(r['outage_date']).date()
        if day < NOW.date() or day > soon: continue
        end = r.get('outage_end_date') or r['outage_date']
        events.append({'id': 'enwl-psi-' + str(r.get('cifms_no')), 'kind': 'power', 'level': 1, 'label': 'Planned power cut',
            'title': 'Planned work', 'place': r.get('local_authority') or '', 'lat': g['lat'], 'lon': g['lon'], 'areas': '',
            'start': iso(datetime.fromisoformat(r['outage_date']).replace(tzinfo=UK)), 'end': iso(datetime.fromisoformat(end).replace(tzinfo=UK) + timedelta(hours=23, minutes=59)),
            'customers': 0, 'network': 'Electricity North West', 'link': 'https://www.enwl.co.uk/power-cuts/', 'detail': 'Planned supply interruption on ' + r['outage_date']})
        n += 1
    return n, ''
feed('Power cuts', 'Electricity North West', 'North West England', enwl, 'enwl-')

# ---- SP Energy Networks live power cuts (needs SPEN_API_KEY; no property counts published)
def spen():
    if not KEYS['spenergynetworks.opendatasoft.com']: raise NoKey()
    rows = rows_of('https://spenergynetworks.opendatasoft.com/api/explore/v2.1/catalog/datasets/national-energy-outage-data/exports/json')
    n = 0
    for r in rows:
        if r.get('status') == 'Completed' or r.get('date_of_restoration') or r.get('location_latitude') is None: continue
        planned = bool(r.get('planned'))
        start = r.get('planned_outage_start_date') if planned else r.get('date_of_reported_fault')
        events.append({'id': 'spen-' + str(r.get('fault_id')), 'kind': 'power', 'level': 1 if planned else 2,
            'label': 'Planned power cut' if planned else 'Power cut', 'title': (r.get('region') or 'Power cut').title(),
            'place': r.get('post_code') or '', 'lat': r['location_latitude'], 'lon': r['location_longitude'], 'areas': '',
            'start': iso(datetime.fromisoformat(start)) if start else None, 'end': iso(datetime.fromisoformat(r['etr'])) if r.get('etr') else None,
            'customers': None, 'network': 'SP Energy Networks (' + (r.get('licence_area') or '') + ')',
            'link': 'https://www.spenergynetworks.co.uk/pages/power_cuts_map.aspx', 'detail': f"Status: {r.get('status')}. {r.get('voltage')} network."})
        n += 1
    return n, 'Property counts are not published for this network.'
feed('Power cuts', 'SP Energy Networks', 'Central and southern Scotland, Merseyside, Cheshire and North Wales', spen, 'spen-')

for prov, cov, note in [('NIE Networks', 'Northern Ireland', 'No public data feed. Check https://powercheck.nienetworks.co.uk/'),
                        ('SEPA', 'Scotland', 'No public data feed. Check https://floodline.sepa.org.uk/floodupdates/'),
                        ('Natural Resources Wales', 'Wales', 'Needs a free API key from api-portal.naturalresources.wales. Until then check https://flood-warning.naturalresources.wales/'),
                        ('Northern Ireland flood warnings', 'Northern Ireland', 'No public flood warning feed. Check https://www.nidirect.gov.uk/articles/flooding')]:
    feeds.append({'feed': 'Flood warnings' if prov in ('SEPA', 'Natural Resources Wales', 'Northern Ireland flood warnings') else 'Power cuts', 'provider': prov,
                  'coverage': cov, 'status': 'not connected', 'items': 0, 'checked': STAMP, 'note': note})

# ---- Forecast grid (Open-Meteo), next 3 days, every third hour to stay inside the shared rate limit
forecast = None
def meteo():
    global forecast
    pts = GRID
    rows = []
    for i in range(0, len(pts), 100):
        chunk = pts[i:i + 100]
        u = ('https://api.open-meteo.com/v1/forecast?latitude=' + ','.join(str(p['lat']) for p in chunk) + '&longitude=' + ','.join(str(p['lon']) for p in chunk) +
             '&daily=wind_gusts_10m_max,precipitation_sum,snowfall_sum,temperature_2m_min&wind_speed_unit=mph&timezone=Europe%2FLondon&forecast_days=3')
        res = json.loads(get(u, 90))
        res = res if isinstance(res, list) else [res]
        for p, r in zip(chunk, res):
            d = r['daily']
            for k, day in enumerate(d['time']):
                rows.append({'cell': p['cell'], 'lat': p['lat'], 'lon': p['lon'], 'day': day, 'gust_mph': d['wind_gusts_10m_max'][k],
                             'rain_mm': d['precipitation_sum'][k], 'snow_cm': d['snowfall_sum'][k], 'tmin_c': d['temperature_2m_min'][k]})
    if not rows: raise RuntimeError('no forecast points')
    forecast = rows
    return len(pts), ''
feed('3-day forecast', 'Open-Meteo', 'All UK, about 50 km grid', meteo)
if forecast is None and os.path.exists(OUT + '/forecast.json'):
    feeds[-1]['note'] += ' Showing the previous forecast.'

json.dump(events, open(OUT + '/events.json', 'w'), separators=(',', ':'))
json.dump(feeds, open(OUT + '/feeds.json', 'w'), separators=(',', ':'))
if forecast: json.dump(forecast, open(OUT + '/forecast.json', 'w'), separators=(',', ':'))
print(json.dumps({'events': len(events), 'forecast': len(forecast or []), 'feeds': [(f['provider'], f['status'], f['items'], f['note'][:120]) for f in feeds]}, indent=0))
