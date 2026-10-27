"""Send ntfy push alerts when a watched postcode reaches amber or red.

Usage: python scripts/alerts.py DATA_DIR PREVIOUS_STATE_JSON

Settings come from the environment, so nothing personal is stored in the repository:
  NTFY_TOPIC        the private ntfy topic to post to (required; without it the script does nothing)
  ALERT_POSTCODES   comma-separated postcodes to watch, e.g. "SK8 4NB, M1 1AE"
  NTFY_SERVER       optional, defaults to https://ntfy.sh
  SITE_URL          optional, link opened when the notification is tapped
  DRY_RUN           set to 1 to print instead of sending

Each run works out the level for every postcode (0 clear, 1 be aware, 2 be prepared, 3 take action),
using the same rules as the site. A notification is sent when a postcode reaches level 2 or more with
something it has not been alerted about before, and once more when it drops back below 2.
Only hashes are written to the state file, never postcodes.
"""
import hashlib, json, math, os, sys, urllib.parse, urllib.request
from datetime import datetime, timezone

DATA, STATE_IN = sys.argv[1], sys.argv[2]
TOPIC = os.environ.get('NTFY_TOPIC', '').strip()
SERVER = os.environ.get('NTFY_SERVER', 'https://ntfy.sh').rstrip('/')
SITE = os.environ.get('SITE_URL', '')
DRY = os.environ.get('DRY_RUN') == '1'
RADIUS_KM = 25


def h(*parts):
    # Salted with the private topic so the published state can't be matched back to a postcode
    return hashlib.sha256('|'.join((TOPIC,) + parts).encode()).hexdigest()[:16]


def km(a, b):
    x = math.radians(b['lon'] - a['lon']) * math.cos(math.radians((a['lat'] + b['lat']) / 2))
    return 6371 * math.hypot(x, math.radians(b['lat'] - a['lat']))


def lookup(pc):
    url = 'https://api.postcodes.io/postcodes/' + urllib.parse.quote(pc.replace(' ', ''))
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'uk-danger-dashboard'}), timeout=30) as r:
        p = json.load(r)['result']
    return {'label': p['postcode'], 'lat': p['latitude'], 'lon': p['longitude'],
            'areas': {a for a in (p['admin_district'], p['admin_county']) if a}}


def assess(place, events, forecast):
    """Return (level, [(item_level, item_id, text)]) for a place."""
    items = []
    for e in events:
        if e['kind'] == 'weather':
            if place['areas'] & set(e['areas'].split('|')):
                items.append((e['level'], e['id'], f"{e['label']} for {e['place']}, {e['start'][:16].replace('T', ' ')} to {e['end'][:16].replace('T', ' ')} UTC"))
            continue
        if e.get('lat') is None:
            continue
        d = km(place, e)
        if d > RADIUS_KM:
            continue
        if e['kind'] == 'flood':
            items.append((e['level'] if d <= 10 else min(e['level'], 1), e['id'], f"{e['label']}: {e['title']} ({d:.0f} km)"))
        elif e['kind'] == 'power' and e['level'] == 1:
            if d <= 5:
                items.append((1, e['id'], f"Planned power cut {d:.0f} km away on {e['start'][:10]} ({e['network']})"))
        elif e['kind'] == 'power':
            off = f"{e['customers']} properties off" if e['customers'] is not None else 'properties affected not published'
            items.append((2 if d <= 5 else 1, e['id'], f"Power cut {d:.1f} km away, {off} ({e['network']})"))
    if forecast:
        cell = min({(r['lat'], r['lon']) for r in forecast}, key=lambda c: km(place, {'lat': c[0], 'lon': c[1]}))
        for r in forecast:
            if (r['lat'], r['lon']) != cell:
                continue
            lv = max(2 if r['gust_mph'] >= 60 else 1 if r['gust_mph'] >= 45 else 0,
                     2 if r['rain_mm'] >= 30 else 1 if r['rain_mm'] >= 15 else 0,
                     2 if r['snow_cm'] >= 5 else 1 if r['snow_cm'] >= 1 else 0)
            if lv:
                items.append((lv, 'fc-' + r['day'], f"Forecast {r['day']}: gusts {r['gust_mph']:.0f} mph, rain {r['rain_mm']:.0f} mm, snow {r['snow_cm']:.0f} cm"))
    items.sort(reverse=True)
    return max([i[0] for i in items], default=0), items


def send(title, body, level, place_label):
    headers = {'Title': title, 'Priority': 'urgent' if level >= 3 else 'high' if level == 2 else 'default',
               'Tags': 'rotating_light' if level >= 3 else 'warning' if level == 2 else 'white_check_mark'}
    if SITE:
        headers['Click'] = SITE + '?pc=' + urllib.parse.quote(place_label)
    if DRY:
        print('DRY RUN', headers, body)
        return
    req = urllib.request.Request(f'{SERVER}/{TOPIC}', data=body.encode(), headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=30) as r:
        r.read()


def main():
    if not TOPIC:
        print('NTFY_TOPIC not set; skipping alerts.')
        return
    postcodes = [p.strip() for p in os.environ.get('ALERT_POSTCODES', '').split(',') if p.strip()]
    events = json.load(open(os.path.join(DATA, 'events.json')))
    try:
        forecast = json.load(open(os.path.join(DATA, 'forecast.json')))
    except Exception:
        forecast = []
    try:
        state = json.load(open(STATE_IN))
    except Exception:
        state = {}
    sent, levels = set(state.get('sent', [])), dict(state.get('levels', {}))
    new_sent, sent_count = set(), 0
    for pc in postcodes:
        try:
            place = lookup(pc)
        except Exception as e:
            print(f'::warning title=Alerts::Could not look up one of the watched postcodes ({type(e).__name__}).')
            continue
        key = h('place', place['label'])
        level, items = assess(place, events, forecast)
        serious = [i for i in items if i[0] >= 2]
        fresh = [i for i in serious if h(key, i[1]) not in sent]
        new_sent.update(h(key, i[1]) for i in serious)
        was = levels.get(key, 0)
        if fresh:
            word = 'TAKE ACTION' if level >= 3 else 'BE PREPARED'
            body = '\n'.join(f'• {t}' for _, _, t in serious[:6])
            send(f"{word}: {place['label']}", body, level, place['label'])
            sent_count += 1
        elif was >= 2 and level < 2:
            send(f"Back to normal: {place['label']}", 'No amber or red conditions nearby now.', 1, place['label'])
            sent_count += 1
        levels[key] = level
    out = {'updated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'sent': sorted(new_sent), 'levels': levels}
    with open(os.path.join(DATA, 'alert-state.json'), 'w') as f:
        json.dump(out, f)
    print(f'::notice title=Alerts::Checked {len(postcodes)} postcode(s); sent {sent_count} notification(s).')


main()
