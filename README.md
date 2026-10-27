# UK Outage Watch

A small web app that shows power cuts, flood warnings, Met Office weather warnings and a 3-day outlook for any UK postcode, with an early-warning status for the places you save.

Live site: https://martinmoog.github.io/uk-danger-dashboard/

## How it works

- `site/` is a static web app (HTML, CSS, vanilla JavaScript and d3). It can be installed to a phone's home screen and keeps working offline with the last data it loaded.
- `scripts/refresh.py` fetches the public feeds and writes `site/data/events.json`, `feeds.json` and `forecast.json`. It uses only the Python standard library.
- `.github/workflows/refresh-and-deploy.yml` runs the script every hour and publishes `site/` to GitHub Pages.

Postcode lookups and "Near me" use [postcodes.io](https://postcodes.io) from the browser. `site/data/outcodes.json` (postcode district centres) and `site/data/basemap.json` (UK and Ireland outline) are static.

## Data sources

| Data | Source | Key needed |
|---|---|---|
| Weather warnings | Met Office warnings RSS | No |
| Flood warnings (England) | Environment Agency flood-monitoring API | No |
| Power cuts | SSEN, National Grid, UK Power Networks, Northern Powergrid | No |
| Power cuts | Electricity North West | `ENWL_API_KEY` |
| Power cuts | SP Energy Networks | `SPEN_API_KEY` |
| 3-day forecast | Open-Meteo | No |

Keys are free from each network's open data portal and are stored as repository secrets (Settings → Secrets and variables → Actions). Without a key that network is shown as "not connected".

`.github/workflows/keep-alive.yml` re-enables the scheduled workflows on the 1st of each month, so GitHub's 60-day inactivity rule never pauses the hourly refresh.

## Phone alerts

`scripts/alerts.py` runs after each refresh and posts to [ntfy](https://ntfy.sh) when a watched postcode reaches amber ("Be prepared") or red ("Take action"), and once more when it clears. It only alerts about something once. Set these repository secrets:

- `NTFY_TOPIC`: a private, hard-to-guess topic name. Subscribe to the same name in the ntfy app.
- `ALERT_POSTCODES`: the postcodes to watch, comma separated.

Postcodes are never written to the repository or the site; the alert state published with the site holds only salted hashes.

## Run locally

```sh
python3 scripts/refresh.py site/data scripts/ref.json
python3 -m http.server -d site 8000
```

Then open http://localhost:8000.

Not an official warning service. In an emergency call 999; for power cuts call 105.
