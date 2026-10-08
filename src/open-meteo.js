// Description:
//   Current weather from Open-Meteo, plus active National Weather Service
//   alerts for US locations. Neither service needs an API key.
//
// Configuration:
//   HUBOT_WEATHER_DEFAULT_LOCATION - (optional) place used by a bare `weather`,
//     e.g. "Portland, OR" or "97201"
//   HUBOT_DEFAULT_LATITUDE, HUBOT_DEFAULT_LONGITUDE - (optional) coordinates used
//     by a bare `weather` when HUBOT_WEATHER_DEFAULT_LOCATION is not set
//   HUBOT_WEATHER_USER_AGENT - (optional) User-Agent sent to the National Weather
//     Service, which asks for a way to contact you
//
// Commands:
//   hubot weather - Get the weather for the default location
//   hubot weather <place> - Get the weather for a city, "City, ST", "City, Country" or US ZIP code
//
// Notes:
//   Weather data by Open-Meteo.com (CC BY 4.0). Alerts from the National
//   Weather Service (api.weather.gov), US only.
//
// Author:
//   stahnma
//
// Category: social

'use strict';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active';
const DEFAULT_USER_AGENT = 'hubot-open-meteo (https://github.com/stahnma/hubot-open-meteo)';

const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

// Common names for countries whose ISO code isn't obvious from their name.
const COUNTRY_ALIASES = { uk: 'gb', usa: 'us', england: 'gb', scotland: 'gb', wales: 'gb' };

// WMO weather interpretation codes, as used by Open-Meteo.
const WEATHER_CODES = {
  0: ['Clear sky', '☀️'],
  1: ['Mainly clear', '🌤️'],
  2: ['Partly cloudy', '⛅'],
  3: ['Overcast', '☁️'],
  45: ['Fog', '🌫️'],
  48: ['Freezing fog', '🌫️'],
  51: ['Light drizzle', '🌦️'],
  53: ['Drizzle', '🌦️'],
  55: ['Heavy drizzle', '🌧️'],
  56: ['Light freezing drizzle', '🌧️'],
  57: ['Freezing drizzle', '🌧️'],
  61: ['Light rain', '🌦️'],
  63: ['Rain', '🌧️'],
  65: ['Heavy rain', '🌧️'],
  66: ['Light freezing rain', '🌧️'],
  67: ['Freezing rain', '🌧️'],
  71: ['Light snow', '🌨️'],
  73: ['Snow', '🌨️'],
  75: ['Heavy snow', '❄️'],
  77: ['Snow grains', '🌨️'],
  80: ['Light rain showers', '🌦️'],
  81: ['Rain showers', '🌧️'],
  82: ['Violent rain showers', '⛈️'],
  85: ['Snow showers', '🌨️'],
  86: ['Heavy snow showers', '❄️'],
  95: ['Thunderstorm', '⛈️'],
  96: ['Thunderstorm with hail', '⛈️'],
  99: ['Thunderstorm with heavy hail', '⛈️'],
};

const SEVERITY_COLORS = {
  extreme: '#FF3838',
  severe: '#FFB302',
  moderate: '#FCE83A',
  minor: '#56F000',
};

class NotFoundError extends Error {}

const describeCode = code => WEATHER_CODES[code] || ['Unknown conditions', '🌡️'];

const toF = c => Math.round((c * 9) / 5 + 32);
const temp = c => `${toF(c)}°F/${Math.round(c)}°C`;
const kmhToMph = kmh => Math.round(kmh / 1.609344);

const getJSON = async (url, params, headers = {}) => {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(query ? `${url}?${query}` : url, { headers });
  if (!res.ok) {
    const err = new Error(`${new URL(url).hostname} returned HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
};

// Does a geocoding result match a qualifier like "OR", "Oregon", "UK" or "France"?
const matchesQualifier = (place, qualifier) => {
  const q = qualifier.toLowerCase();
  const state = US_STATES[qualifier.toUpperCase()];
  const candidates = [place.admin1, place.country, place.country_code]
    .filter(Boolean)
    .map(v => v.toLowerCase());
  return (
    candidates.includes(q) ||
    candidates.includes(COUNTRY_ALIASES[q]) ||
    (state && place.country_code === 'US' && place.admin1 === state)
  );
};

const searchPlaces = async (name, qualifiers) => {
  const params = { name, count: 10, language: 'en', format: 'json' };
  // A lone US state narrows the search to the US, so "Springfield, IL" isn't
  // crowded out of the results by bigger Springfields elsewhere.
  if (/^\d{5}$/.test(name) || (qualifiers.length === 1 && US_STATES[qualifiers[0].toUpperCase()])) {
    params.countryCode = 'US';
  }
  const { results = [] } = await getJSON(GEOCODE_URL, params);
  return results.filter(place => qualifiers.every(q => matchesQualifier(place, q)));
};

// Towns and cities (GeoNames PPL* feature codes), as opposed to airports,
// parks and the like that share a name.
const isPopulated = place => /^PPL/.test(place.feature_code || '');

// Turn "Portland", "Portland, OR", "London, UK" or "97201" into one place.
const geocode = async query => {
  const [name, ...qualifiers] = query.split(',').map(part => part.trim()).filter(Boolean);
  if (!name) throw new NotFoundError(query);
  let places = await searchPlaces(name, qualifiers);
  // Open-Meteo knows "Saint Paul", not "St. Paul" (which finds the airport).
  if (!places.some(isPopulated) && /\bst\.?\s/i.test(name)) {
    const saints = await searchPlaces(name.replace(/\bst\.?\s/i, 'Saint '), qualifiers);
    if (saints.length > 0) places = saints;
  }
  if (places.length === 0) throw new NotFoundError(query);
  const place = places.find(isPopulated) || places[0];
  // "Portland, Oregon" in the US, "Paris, France" elsewhere.
  const region = place.country_code === 'US' ? place.admin1 : place.country;
  const label = [place.name, region].filter(Boolean).join(', ');
  return {
    name: label,
    latitude: place.latitude,
    longitude: place.longitude,
    countryCode: place.country_code,
  };
};

const getForecast = ({ latitude, longitude }) =>
  getJSON(FORECAST_URL, {
    latitude,
    longitude,
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: 1,
  });

const getAlerts = ({ latitude, longitude }) =>
  getJSON(
    NWS_ALERTS_URL,
    { point: `${latitude.toFixed(4)},${longitude.toFixed(4)}` },
    {
      'User-Agent': process.env.HUBOT_WEATHER_USER_AGENT || DEFAULT_USER_AGENT,
      Accept: 'application/geo+json',
    }
  ).then(json => json.features || []);

const isSlack = robot => /slack/i.test(robot.adapterName || (robot.adapter && robot.adapter.name) || '');

const formatWeather = (robot, place, forecast) => {
  const now = forecast.current;
  const today = forecast.daily;
  const [conditions, emoji] = describeCode(now.weather_code);
  const high = today.temperature_2m_max[0];
  const low = today.temperature_2m_min[0];
  const rain = today.precipitation_probability_max[0];
  const wind = `${kmhToMph(now.wind_speed_10m)} mph (${Math.round(now.wind_speed_10m)} km/h)`;
  const text =
    `${emoji} ${conditions} and ${temp(now.temperature_2m)} in ${place.name}. ` +
    `High ${temp(high)}, low ${temp(low)}` +
    (rain == null ? '.' : `, ${rain}% chance of precipitation.`);

  if (!isSlack(robot)) return text;
  return {
    attachments: [
      {
        fallback: text,
        title: `${emoji} Weather in ${place.name}`,
        color: '#3a7bd5',
        fields: [
          { title: 'Conditions', value: conditions, short: true },
          { title: 'Temperature', value: temp(now.temperature_2m), short: true },
          { title: 'Feels like', value: temp(now.apparent_temperature), short: true },
          { title: 'Humidity', value: `${now.relative_humidity_2m}%`, short: true },
          { title: 'Wind', value: wind, short: true },
          {
            title: 'Today',
            value: `${temp(high)} / ${temp(low)}` + (rain == null ? '' : `, ${rain}% precip`),
            short: true,
          },
        ],
        footer: 'Weather data by Open-Meteo.com',
        footer_icon: 'https://open-meteo.com/favicon.ico',
      },
    ],
  };
};

const formatAlerts = (robot, place, alerts) => {
  const text = [
    `⚠️ Weather alerts for ${place.name}:`,
    ...alerts.map(alert => `- ${alert.properties.headline || alert.properties.event}`),
    'See https://weather.gov for details.',
  ].join('\n');

  if (!isSlack(robot)) return text;
  return {
    text: `*⚠️ Weather alerts for ${place.name}*`,
    attachments: alerts.map(({ properties: alert }) => ({
      fallback: alert.headline || alert.event,
      pretext: alert.event,
      title: alert.headline || alert.event,
      text: alert.description ? '```\n' + alert.description + '\n```' : undefined,
      mrkdwn_in: ['text'],
      fields: [
        { title: 'Severity', value: alert.severity, short: true },
        { title: 'Certainty', value: alert.certainty, short: true },
        { title: 'Areas affected', value: alert.areaDesc, short: false },
      ],
      color: SEVERITY_COLORS[(alert.severity || '').toLowerCase()] || '#A4ABB6',
      footer: 'Alerts provided by the National Weather Service',
    })),
  };
};

// The place a bare `weather` reports on, or null if none is configured.
const defaultPlace = async () => {
  if (process.env.HUBOT_WEATHER_DEFAULT_LOCATION) {
    return geocode(process.env.HUBOT_WEATHER_DEFAULT_LOCATION);
  }
  const latitude = parseFloat(process.env.HUBOT_DEFAULT_LATITUDE);
  const longitude = parseFloat(process.env.HUBOT_DEFAULT_LONGITUDE);
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) return null;
  // Without a name to geocode the country is unknown; NWS just ignores non-US points.
  return { name: `${latitude}, ${longitude}`, latitude, longitude, countryCode: null };
};

module.exports = robot => {
  const report = async (msg, query) => {
    const place = query ? await geocode(query) : await defaultPlace();
    if (!place) {
      msg.send('No default location set. Set HUBOT_WEATHER_DEFAULT_LOCATION, or ask for `weather <place>`.');
      return;
    }
    msg.send(formatWeather(robot, place, await getForecast(place)));

    if (place.countryCode && place.countryCode !== 'US') return;
    try {
      const alerts = await getAlerts(place);
      if (alerts.length > 0) msg.send(formatAlerts(robot, place, alerts));
    } catch (err) {
      // Alerts are a bonus: points outside the US get a 400, and NWS has outages.
      robot.logger.debug(`open-meteo: no NWS alerts for ${place.name}: ${err.message}`);
    }
  };

  robot.respond(/weather(?:\s+(.+?))?\s*$/i, msg => {
    const query = msg.match[1];
    report(msg, query).catch(err => {
      if (err instanceof NotFoundError) {
        msg.send(`Sorry, I couldn't find ${query || 'that place'}. Try a city, "City, ST" or a ZIP code.`);
        return;
      }
      robot.logger.error(`open-meteo: weather ${query || ''} failed: ${err.stack || err}`);
      msg.send(`Sorry, I couldn't get the weather: ${err.message}`);
    });
  });
};

module.exports.geocode = geocode;
module.exports.formatWeather = formatWeather;
module.exports.describeCode = describeCode;
