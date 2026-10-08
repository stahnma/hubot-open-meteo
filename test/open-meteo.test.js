const { expect } = require('chai');
const sinon = require('sinon');
const weather = require('../src/open-meteo.js');

const PORTLAND = { name: 'Portland', admin1: 'Oregon', country: 'United States', country_code: 'US', latitude: 45.52345, longitude: -122.67621, feature_code: 'PPLA2' };
const PORTLAND_ME = { name: 'Portland', admin1: 'Maine', country: 'United States', country_code: 'US', latitude: 43.65737, longitude: -70.2589, feature_code: 'PPLA2' };
const LONDON = { name: 'London', admin1: 'England', country: 'United Kingdom', country_code: 'GB', latitude: 51.50853, longitude: -0.12574, feature_code: 'PPLC' };
const LONDON_ON = { name: 'London', admin1: 'Ontario', country: 'Canada', country_code: 'CA', latitude: 42.98339, longitude: -81.23304, feature_code: 'PPL' };
const ST_PAUL_AIRPORT = { name: 'St. Paul Downtown Airport', admin1: 'Minnesota', country: 'United States', country_code: 'US', latitude: 44.93, longitude: -93.06, feature_code: 'AIRP' };
const SAINT_PAUL = { name: 'Saint Paul', admin1: 'Minnesota', country: 'United States', country_code: 'US', latitude: 44.94441, longitude: -93.09327, feature_code: 'PPLA' };

const FORECAST = {
  current: {
    temperature_2m: 26.1,
    apparent_temperature: 27.4,
    relative_humidity_2m: 40,
    weather_code: 2,
    wind_speed_10m: 8,
  },
  daily: {
    temperature_2m_max: [28],
    temperature_2m_min: [12.8],
    precipitation_probability_max: [10],
  },
};

const ALERT = {
  properties: {
    event: 'Heat Advisory',
    headline: 'Heat Advisory issued for Portland',
    description: 'Hot.',
    severity: 'Moderate',
    certainty: 'Likely',
    areaDesc: 'Multnomah',
  },
};

const json = body => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const status = code => Promise.resolve({ ok: false, status: code, json: () => Promise.resolve({}) });

// A minimal robot that records the respond listener and what gets sent.
const makeRobot = (adapterName = 'Shell') => {
  const robot = {
    adapterName,
    logger: { debug: sinon.spy(), error: sinon.spy() },
    respond(regex, callback) {
      this.listener = { regex, callback };
    },
  };
  weather(robot);
  // Send `text` to the bot and resolve with everything it replied.
  robot.say = text =>
    new Promise(resolve => {
      const sent = [];
      const match = text.match(robot.listener.regex);
      expect(match, `no match for ${text}`).to.not.be.null;
      robot.listener.callback({ match, send: reply => sent.push(reply) });
      setTimeout(() => resolve(sent), 20);
    });
  return robot;
};

describe('hubot-open-meteo', () => {
  let fetch;
  let geocodeResults;
  let alerts;

  beforeEach(() => {
    geocodeResults = { Portland: [PORTLAND, PORTLAND_ME], 97201: [PORTLAND], London: [LONDON, LONDON_ON], 'Saint Paul': [SAINT_PAUL], 'St. Paul': [ST_PAUL_AIRPORT] };
    alerts = () => json({ features: [] });
    fetch = sinon.stub(global, 'fetch').callsFake(async url => {
      const u = new URL(url);
      if (u.hostname === 'geocoding-api.open-meteo.com') {
        // Like Open-Meteo, ignore case when matching names.
        const name = u.searchParams.get('name').toLowerCase();
        const key = Object.keys(geocodeResults).find(k => k.toLowerCase() === name);
        return json({ results: geocodeResults[key] });
      }
      if (u.hostname === 'api.open-meteo.com') return json(FORECAST);
      if (u.hostname === 'api.weather.gov') return alerts(u);
      throw new Error(`unexpected fetch ${url}`);
    });
  });

  afterEach(() => {
    sinon.restore();
    delete process.env.HUBOT_WEATHER_DEFAULT_LOCATION;
    delete process.env.HUBOT_DEFAULT_LATITUDE;
    delete process.env.HUBOT_DEFAULT_LONGITUDE;
    delete process.env.HUBOT_WEATHER_USER_AGENT;
  });

  const urls = host => fetch.args.map(([url]) => new URL(url)).filter(u => u.hostname === host);

  describe('geocode', () => {
    it('takes the top result for a bare name', async () => {
      expect((await weather.geocode('Portland')).name).to.equal('Portland, Oregon');
    });

    it('matches a US state abbreviation or name', async () => {
      expect((await weather.geocode('Portland, ME')).name).to.equal('Portland, Maine');
      expect((await weather.geocode('portland, maine')).name).to.equal('Portland, Maine');
      expect(urls('geocoding-api.open-meteo.com')[0].searchParams.get('countryCode')).to.equal('US');
    });

    it('matches a country code, alias or region', async () => {
      expect((await weather.geocode('London, UK')).name).to.equal('London, United Kingdom');
      expect((await weather.geocode('London, Canada')).name).to.equal('London, Canada');
      expect((await weather.geocode('London, Ontario')).name).to.equal('London, Canada');
    });

    it('limits a ZIP code to the US', async () => {
      const place = await weather.geocode('97201');
      expect(place).to.include({ name: 'Portland, Oregon', countryCode: 'US' });
      expect(urls('geocoding-api.open-meteo.com')[0].searchParams.get('countryCode')).to.equal('US');
    });

    it('prefers a town over an airport with the same name', async () => {
      geocodeResults.Portland = [{ ...PORTLAND, name: 'Portland International Airport', feature_code: 'AIRP' }, PORTLAND];
      expect((await weather.geocode('Portland, OR')).name).to.equal('Portland, Oregon');
    });

    it('retries "St." as "Saint" when only a non-town matches', async () => {
      expect((await weather.geocode('St. Paul, MN')).name).to.equal('Saint Paul, Minnesota');
    });

    it('rejects a place it cannot find', async () => {
      let error;
      await weather.geocode('Portland, TX').catch(err => (error = err));
      expect(error).to.be.an('error');
      expect(error.constructor.name).to.equal('NotFoundError');
    });
  });

  describe('formatting', () => {
    it('maps weather codes, with a fallback', () => {
      expect(weather.describeCode(95)).to.deep.equal(['Thunderstorm', '⛈️']);
      expect(weather.describeCode(12345)[0]).to.equal('Unknown conditions');
    });

    it('writes plain text outside Slack', () => {
      const text = weather.formatWeather({ adapterName: 'Shell' }, { name: 'Portland, Oregon' }, FORECAST);
      expect(text).to.equal(
        '⛅ Partly cloudy and 79°F/26°C in Portland, Oregon. High 82°F/28°C, low 55°F/13°C, 10% chance of precipitation.'
      );
    });

    it('builds a Slack attachment with a text fallback', () => {
      const reply = weather.formatWeather({ adapterName: 'SlackBot' }, { name: 'Portland, Oregon' }, FORECAST);
      const [attachment] = reply.attachments;
      expect(attachment.title).to.equal('⛅ Weather in Portland, Oregon');
      expect(attachment.fallback).to.match(/^⛅ Partly cloudy and 79°F\/26°C/);
      expect(attachment.fields.map(f => `${f.title}: ${f.value}`)).to.deep.equal([
        'Conditions: Partly cloudy',
        'Temperature: 79°F/26°C',
        'Feels like: 81°F/27°C',
        'Humidity: 40%',
        'Wind: 5 mph (8 km/h)',
        'Today: 82°F/28°C / 55°F/13°C, 10% precip',
      ]);
      expect(attachment.footer).to.match(/Open-Meteo/);
    });
  });

  describe('weather command', () => {
    it('reports the weather for a place', async () => {
      const replies = await makeRobot().say('weather Portland, OR');
      expect(replies).to.have.length(1);
      expect(replies[0]).to.match(/in Portland, Oregon\./);
      const [forecast] = urls('api.open-meteo.com');
      expect(forecast.searchParams.get('latitude')).to.equal('45.52345');
      expect(forecast.searchParams.get('timezone')).to.equal('auto');
    });

    it('follows up with NWS alerts for a US place', async () => {
      alerts = () => json({ features: [ALERT] });
      process.env.HUBOT_WEATHER_USER_AGENT = 'burrito (ops@example.com)';
      const replies = await makeRobot().say('weather 97201');
      expect(replies).to.have.length(2);
      expect(replies[1]).to.equal(
        '⚠️ Weather alerts for Portland, Oregon:\n- Heat Advisory issued for Portland\nSee https://weather.gov for details.'
      );
      const [, options] = fetch.args.find(([url]) => url.startsWith('https://api.weather.gov'));
      expect(options.headers['User-Agent']).to.equal('burrito (ops@example.com)');
      expect(urls('api.weather.gov')[0].searchParams.get('point')).to.equal('45.5234,-122.6762');
    });

    it('formats alerts as Slack attachments', async () => {
      alerts = () => json({ features: [ALERT] });
      const replies = await makeRobot('SlackBot').say('weather Portland');
      expect(replies[1].text).to.equal('*⚠️ Weather alerts for Portland, Oregon*');
      expect(replies[1].attachments[0]).to.include({ title: 'Heat Advisory issued for Portland', color: '#FCE83A' });
    });

    it('does not ask NWS about places outside the US', async () => {
      const replies = await makeRobot().say('weather London, UK');
      expect(replies).to.have.length(1);
      expect(urls('api.weather.gov')).to.have.length(0);
    });

    it('still reports the weather when NWS fails', async () => {
      alerts = () => status(500);
      const robot = makeRobot();
      const replies = await robot.say('weather Portland');
      expect(replies).to.have.length(1);
      expect(robot.logger.debug.calledOnce).to.be.true;
    });

    it('uses HUBOT_WEATHER_DEFAULT_LOCATION for a bare weather', async () => {
      process.env.HUBOT_WEATHER_DEFAULT_LOCATION = 'Portland, ME';
      const [reply] = await makeRobot().say('weather');
      expect(reply).to.match(/in Portland, Maine\./);
    });

    it('falls back to HUBOT_DEFAULT_LATITUDE/LONGITUDE', async () => {
      process.env.HUBOT_DEFAULT_LATITUDE = '45.5';
      process.env.HUBOT_DEFAULT_LONGITUDE = '-122.7';
      const [reply] = await makeRobot().say('weather');
      expect(reply).to.match(/in 45\.5, -122\.7\./);
      expect(urls('geocoding-api.open-meteo.com')).to.have.length(0);
    });

    it('says when no default location is set', async () => {
      const [reply] = await makeRobot().say('weather');
      expect(reply).to.match(/^No default location set/);
    });

    it('says when it cannot find a place', async () => {
      const [reply] = await makeRobot().say('weather Atlantis');
      expect(reply).to.equal('Sorry, I couldn\'t find Atlantis. Try a city, "City, ST" or a ZIP code.');
    });

    it('reports an API failure', async () => {
      fetch.callsFake(() => status(503));
      const robot = makeRobot();
      const [reply] = await robot.say('weather Portland');
      expect(reply).to.equal("Sorry, I couldn't get the weather: geocoding-api.open-meteo.com returned HTTP 503");
      expect(robot.logger.error.calledOnce).to.be.true;
    });

    it('does not answer words that merely start with weather', () => {
      const robot = makeRobot();
      expect('weatherman says hi'.match(robot.listener.regex)).to.be.null;
    });
  });
});
