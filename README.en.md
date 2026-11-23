<h1 align="center">EV Range · Where Every Kilowatt-Hour Goes</h1>

<p align="center">
  <a href="README.md"><img src="https://img.shields.io/badge/%E4%B8%AD%E6%96%87-SWITCH-4E9A06?style=flat-square" alt="Switch to Chinese"></a>
  &nbsp;
  <img src="https://img.shields.io/badge/English-CURRENT-1F4E79?style=flat-square" alt="English">
</p>

<p align="center">
  Give it a car, a passenger count, an origin and a destination. It returns a per-segment energy breakdown, not a single optimistic number.
</p>

## The problem

Manufacturer range figures are measured on a flat test cycle. Real trips have hills. A route that climbs two passes and descends twice has a net elevation change of zero and a very real energy cost, because ascent is paid in full and descent is only partly recovered. Averaging the two away is why the dashboard number and the trip computer disagree.

This tool refuses to average. It computes ascent and descent separately and reports both.

## What it actually computes

| Component | Method |
|---|---|
| **Base driving energy** | Official CLTC consumption per 100 km, times distance, times a **1.20 real-road factor**, then modified by three corrections: speed (U-shaped curve), temperature (battery efficiency), payload |
| **Climb work** | `E = m·g·Δh`, with Δh taken as **cumulative ascent**, not net elevation change |
| **Descent recovery** | Cumulative descent work times **62% recovery efficiency**, capped at 50% of consumption, so the car can never gain charge by driving downhill |
| **HVAC and low-voltage loads** | Heating `0.85 + 0.085 × (20 − T)` kW, cooling `0.55 + 0.055 × (T − 26)` kW, multiplied by actual driving hours |

Three calibration curves were fitted against real trips rather than assumed.

### Battery swap models

Models that support swap are handled separately, because charge time is not a function of the car but of the station generation:

| Platform | Architecture | Peak DC | Models |
|---|---|---|---|
| NT3.0 | 900V (up to 925V / 765A), 5C | **600 kW** | NIO ES8 gen 3, ET9, ES9; Onvo L60 / L90 |
| NT2.5 | 400V | ~180 kW | NIO ET5, ES6 (2025, NX9031 cabin) |
| NT2.0 | 400V | ~125 kW | NIO ET7 |

## Elevation profile

The output includes an elevation chart per route. The orange line is where the energy goes; flat-looking segments are cheap, and a single sustained climb can cost more than a hundred kilometres of motorway.

## Taking the result with you

- **Shareable link** encoding the full input set, so a result can be reproduced by whoever receives it.
- **Multi-car comparison** on the same route, two to five models side by side.
- **Print layout** for handing to someone who will not open a browser.

## Conversational follow-ups

An optional chat layer exposes the model as tools:

| Tool | Purpose |
|---|---|
| `analyze_trip` | Main entry: route, elevation, weather, chargers, energy breakdown, charging plan |
| `compare_cars` | Two to five models on one route |
| `estimate_energy` | Pure model query, for counterfactuals such as "what if it were -5°C" |
| `plan_route`, `get_weather_along_route`, `find_charging_stations` | Individual lookups |
| `search_car_model` | Search across a built-in catalogue of 51 Chinese EV models, annotated with platform and swap support |

## Why it is a static site

No bundler, no framework, no dependencies, no API keys. The entire application is served as static files, which means it can be hosted for free, opened from a USB stick, and audited by anyone who reads the source. Every data source used is keyless and publicly reachable.

## Running it

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` directly from the file system will fail on module loading; serve it over HTTP.

## Limitations

- The 1.20 real-road factor and the 62% recovery figure are calibrated on a limited set of trips. They are documented constants, not universal truths; cold weather and heavy traffic will both be underestimated.
- Wind is not modelled.
- The catalogue covers 51 models. An unlisted car cannot be analysed.
- Elevation data is sampled along the route, so very short climbs are smoothed.

## Licence

MIT. See [LICENSE](LICENSE).
