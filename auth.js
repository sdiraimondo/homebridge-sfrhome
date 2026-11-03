// auth.js - SFR Home SSO authentication for Homebridge plugin
const fs = require('fs');
const axios = require('axios');
const querystring = require('querystring');
const cheerio = require('cheerio');

const BASE_URL = 'https://home.sfr.fr/';
const LOGIN_URL = 'https://home.sfr.fr/login';
const SSO_ENDPOINT = 'https://home.sfr.fr/sso-connector.php';
const MYSENSORS_URL = 'https://home.sfr.fr/mysensors';

class SFRAuth {
  constructor(log, config = {}) {
    this.log = log;
    this.config = config;
    this.cookiePath = config.cookiePath || '/tmp/sfrhome_session_cookies.json';
    this.user = config.username || config.user || process.env.SFR_USER;
    this.password = config.password || process.env.SFR_PASS;
    this.axios = axios.create({
      maxRedirects: 5,
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
  }

  loadCookies() {
    try {
      if (!fs.existsSync(this.cookiePath)) return null;
      const data = JSON.parse(fs.readFileSync(this.cookiePath, 'utf8'));
      return data;
    } catch (e) {
      this.log.debug(`Failed to load cookies: ${e.message}`);
      return null;
    }
  }

  saveCookies(cookies) {
    try {
      fs.writeFileSync(this.cookiePath, JSON.stringify(cookies, null, 2));
      this.log.debug('Cookies saved');
    } catch (e) {
      this.log.error(`Failed to save cookies: ${e.message}`);
    }
  }

  cookiesToHeader(cookies) {
    if (!cookies || !Array.isArray(cookies)) return null;
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }

  extractCookiesFromResponse(resp) {
    const setCookie = resp.headers['set-cookie'];
    if (!setCookie) return [];
    const cookies = [];
    for (const sc of setCookie) {
      const match = sc.match(/^([^=]+)=([^;]+)/);
      if (match) {
        cookies.push({
          name: match[1].trim(),
          value: match[2].trim(),
          domain: '.sfr.fr',
          path: '/'
        });
      }
    }
    return cookies;
  }

  mergeCookies(existing, newCookies) {
    const map = new Map();
    if (existing) {
      for (const c of existing) map.set(c.name, c);
    }
    for (const c of newCookies) map.set(c.name, c);
    return Array.from(map.values());
  }

  async doSSO() {
    if (!this.user || !this.password) {
      throw new Error('Missing SFR credentials (username/password)');
    }

    this.log.info('Starting SFR SSO authentication...');
    let cookies = [];
    this.axios.defaults.headers.Cookie = '';

    // Step 1: POST to SSO connector
    try {
      const ssoResp = await this.axios.post(SSO_ENDPOINT, 
        querystring.stringify({ connectionSFR: this.user, passSFR: this.password }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': BASE_URL.replace(/\/$/, ''),
            'Referer': LOGIN_URL
          },
          validateStatus: () => true
        }
      );
      cookies = this.mergeCookies(cookies, this.extractCookiesFromResponse(ssoResp));
      
      let token = null;
      try {
        const data = typeof ssoResp.data === 'string' ? JSON.parse(ssoResp.data) : ssoResp.data;
        if (data && data.result && data.result.token_sso) {
          token = data.result.token_sso;
        }
      } catch (e) {}
      
      if (!token) {
        throw new Error('Failed to get SSO token');
      }
      this.log.debug('SSO token obtained');
      
      // Step 2: Get login page and submit form
      this.axios.defaults.headers.Cookie = this.cookiesToHeader(cookies);
      const loginPageResp = await this.axios.get(LOGIN_URL, {
        headers: { 'Referer': LOGIN_URL },
        validateStatus: () => true
      });
      cookies = this.mergeCookies(cookies, this.extractCookiesFromResponse(loginPageResp));
      this.axios.defaults.headers.Cookie = this.cookiesToHeader(cookies);
      
      const $ = cheerio.load(loginPageResp.data);
      const form = $('#login_form_add_rib, #loginForm').first();
      if (!form.length) {
        throw new Error('Login form not found');
      }
      
      const payload = {};
      form.find('input').each((i, el) => {
        const name = $(el).attr('name');
        const type = ($(el).attr('type') || '').toLowerCase();
        const value = $(el).attr('value') || '';
        if (!name) return;
        if (type === 'checkbox' && !$(el).attr('checked')) return;
        payload[name] = value;
      });
      
      const submitBtn = form.find('input[type="submit"]').first();
      if (submitBtn.attr('name')) {
        payload[submitBtn.attr('name')] = submitBtn.attr('value') || '';
      }
      
      payload['token_sso'] = token;
      if (this.user && payload.email === undefined && form.find('input[name="email"]').length) {
        payload['email'] = this.user;
      }
      if (this.password && payload.passwd === undefined && form.find('input[name="passwd"]').length) {
        payload['passwd'] = this.password;
      }
      
      const action = form.attr('action') || LOGIN_URL;
      const actionUrl = action.startsWith('http') ? action : new URL(action, LOGIN_URL).href;
      
      const formResp = await this.axios.post(actionUrl, querystring.stringify(payload), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': new URL(actionUrl).origin,
          'Referer': LOGIN_URL
        },
        validateStatus: () => true,
        maxRedirects: 10
      });
      cookies = this.mergeCookies(cookies, this.extractCookiesFromResponse(formResp));
      
      // Step 3: Warm up dashboard
      this.axios.defaults.headers.Cookie = this.cookiesToHeader(cookies);
      const dashResp = await this.axios.get(BASE_URL, {
        headers: { 'Referer': BASE_URL },
        validateStatus: () => true
      });
      cookies = this.mergeCookies(cookies, this.extractCookiesFromResponse(dashResp));
      
      this.saveCookies(cookies);
      this.log.info('SSO authentication successful');
      return cookies;
    } catch (e) {
      this.log.error(`SSO authentication failed: ${e.message}`);
      throw e;
    }
  }

  async getValidCookies() {
    let cookies = this.loadCookies();
    if (cookies && cookies.length > 0) {
      // Test if cookies are valid
      try {
        const header = this.cookiesToHeader(cookies);
        const resp = await this.axios.get(MYSENSORS_URL, {
          headers: {
            'Cookie': header,
            'Referer': BASE_URL,
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/xml,text/xml,*/*'
          },
          validateStatus: () => true,
          maxRedirects: 0
        });
        if (resp.status !== 403 && resp.status !== 302 && resp.status !== 303) {
          return cookies;
        }
        this.log.debug('Stored cookies invalid, re-authenticating...');
      } catch (e) {
        this.log.debug('Cookie test failed, re-authenticating...');
      }
    }
    
    // Need to re-authenticate
    if (!this.user || !this.password) {
      throw new Error('No valid cookies and no credentials for re-authentication');
    }
    return await this.doSSO();
  }

  async makeRequest(url, options = {}) {
    const cookies = await this.getValidCookies();
    const header = this.cookiesToHeader(cookies);
    
    try {
      const resp = await this.axios.get(url, {
        ...options,
        headers: {
          ...options.headers,
          'Cookie': header
        },
        validateStatus: options.validateStatus || (() => true)
      });
      
      // If auth failed, try re-auth once
      if (resp.status === 403 || resp.status === 302 || resp.status === 303) {
        this.log.debug('Auth failed, re-authenticating...');
        const newCookies = await this.doSSO();
        const newHeader = this.cookiesToHeader(newCookies);
        const resp2 = await this.axios.get(url, {
          ...options,
          headers: {
            ...options.headers,
            'Cookie': newHeader
          },
          validateStatus: options.validateStatus || (() => true)
        });
        return resp2;
      }
      
      return resp;
    } catch (e) {
      throw e;
    }
  }
}

module.exports = SFRAuth;
