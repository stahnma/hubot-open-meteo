# hubot-open-meteo

Current weather for [Hubot](https://hubot.github.com/) from
[Open-Meteo](https://open-meteo.com/), followed by any active
[National Weather Service](https://www.weather.gov/) alerts for US locations.

Neither service needs an API key.

```
user>  hubot weather Portland, OR
hubot> ⛅ Partly cloudy and 79°F/26°C in Portland, Oregon. High 82°F/28°C, low 55°F/13°C, 10% chance of precipitation.
```

In Slack the weather comes as an attachment with conditions, temperature,
feels-like, humidity, wind and today's high/low, and each alert gets its own
attachment colored by severity.

## Installation

    npm install --save hubot-open-meteo

Then add `hubot-open-meteo` to your `external-scripts.json`.

## Commands

| Command | |
|---|---|
| `hubot weather` | Weather for the default location |
| `hubot weather <place>` | Weather for a place |

A place can be a city (`Portland`, the most populous match wins), a city and
US state (`Portland, ME` or `Portland, Maine`), a city and country or region
(`London, UK`, `London, Ontario`), or a US ZIP code (`97201`).

## Configuration

| Variable | |
|---|---|
| `HUBOT_WEATHER_DEFAULT_LOCATION` | Place used by a bare `hubot weather`, in any form above |
| `HUBOT_DEFAULT_LATITUDE`, `HUBOT_DEFAULT_LONGITUDE` | Coordinates used by a bare `hubot weather` when `HUBOT_WEATHER_DEFAULT_LOCATION` is not set |
| `HUBOT_WEATHER_USER_AGENT` | User-Agent sent to the National Weather Service, which asks that it include a way to contact you. Defaults to `hubot-open-meteo (https://github.com/stahnma/hubot-open-meteo)` |

## Usage limits and attribution

Open-Meteo's free API is for non-commercial use and has a daily request limit;
see its [terms](https://open-meteo.com/en/terms). Weather data by
[Open-Meteo.com](https://open-meteo.com/), licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Development

    npm install
    npm run lint
    npm test
