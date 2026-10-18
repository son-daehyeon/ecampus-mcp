import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as cheerio from 'cheerio';

export const BASE = 'https://ecampus.kookmin.ac.kr';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36';
const CONFIG_DIR = process.env.ECAMPUS_CONFIG_DIR || path.join(os.homedir(), '.config', 'ecampus-mcp');
const SESSION_FILE = path.join(CONFIG_DIR, 'session.json');
export const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials.json');

export class EcampusError extends Error {}

export function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function savedCredentials() {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export class Client {
  constructor(id = process.env.ECAMPUS_ID || savedCredentials().id, pw = process.env.ECAMPUS_PW || savedCredentials().pw) {
    if (!id || !pw) throw new EcampusError('로그인 정보가 없습니다. 터미널에서 `ecampus-mcp login`을 실행하거나 ECAMPUS_ID, ECAMPUS_PW 환경변수를 설정하세요.');
    this.id = id;
    this.pw = pw;
    this.cookies = {};
    this.token = null;
    this.userid = null;
    this.loginPromise = null;
    this.load();
  }

  load() {
    try {
      const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      if (s.id !== this.id) return;
      Object.assign(this, { cookies: s.cookies, token: s.token, userid: s.userid });
    } catch {}
  }

  save() {
    writePrivate(SESSION_FILE, { id: this.id, cookies: this.cookies, token: this.token, userid: this.userid });
  }

  cookieHeader(url) {
    const jar = this.cookies[new URL(url).hostname] || {};
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  storeCookies(url, res) {
    const host = new URL(url).hostname;
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const jar = (this.cookies[host] ||= {});
      const name = pair.slice(0, i).trim();
      const expires = c.match(/expires=([^;]+)/i)?.[1];
      if (/max-age=0\b/i.test(c) || (expires && Date.parse(expires) < Date.now())) delete jar[name];
      else jar[name] = pair.slice(i + 1).trim();
    }
  }

  async request(url, { method = 'GET', form, follow = true, headers = {} } = {}) {
    for (let hop = 0; hop < 10; hop++) {
      const res = await fetch(url, {
        method,
        redirect: 'manual',
        headers: {
          'User-Agent': UA,
          Cookie: this.cookieHeader(url),
          ...(form && { 'Content-Type': 'application/x-www-form-urlencoded' }),
          ...headers,
        },
        body: form && new URLSearchParams(form).toString(),
      });
      this.storeCookies(url, res);
      const location = res.headers.get('location');
      if (!follow || res.status < 300 || res.status >= 400 || !location) return Object.assign(res, { finalUrl: url });
      url = new URL(location, url).href;
      method = 'GET';
      form = undefined;
    }
    throw new EcampusError('리다이렉트가 너무 많습니다.');
  }

  login() {
    this.loginPromise ||= this.doLogin().finally(() => { this.loginPromise = null; });
    return this.loginPromise;
  }

  relogin(staleToken) {
    return this.token === staleToken ? this.login() : this.loginPromise;
  }

  sessionCookie() {
    return this.cookies['ecampus.kookmin.ac.kr']?.MoodleSession;
  }

  async doLogin() {
    this.cookies = {};
    const loginPage = await (await this.request(`${BASE}/login/index.php`)).text();
    const logintoken = cheerio.load(loginPage)('input[name=logintoken]').val() || '';
    let res = await this.request(`${BASE}/magicsso/requestAuth.php`, {
      method: 'POST',
      form: { anchor: '', logintoken, loginId: this.id, loginPwd: this.pw },
    });
    let html = await res.text();
    for (let hop = 0; hop < 6 && !html.includes('"sesskey"'); hop++) {
      const $ = cheerio.load(html);
      const action = html.match(/\.action\s*=\s*["']([^"']+)["']/)?.[1] || $('form').attr('action');
      if (!action) break;
      const form = Object.fromEntries($('form input[name]').map((_, el) => [[$(el).attr('name'), $(el).val() ?? '']]).get());
      res = await this.request(new URL(action, res.finalUrl).href, { method: 'POST', form });
      html = await res.text();
    }
    if (!html.includes('"sesskey"') || res.finalUrl.includes('/login/')) {
      throw new EcampusError('eCampus 로그인 실패: 아이디/비밀번호를 확인하세요.');
    }
    await this.fetchToken();
    this.save();
  }

  async fetchToken() {
    const url = `${BASE}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=${Date.now()}&urlscheme=moodlemobile`;
    const location = (await this.request(url, { follow: false })).headers.get('location') || '';
    const encoded = location.match(/token=([A-Za-z0-9+/=]+)/)?.[1];
    if (!encoded) throw new EcampusError('모바일 토큰 발급 실패');
    this.token = Buffer.from(encoded, 'base64').toString().split(':::')[1];
    this.userid = (await this.callWs('core_webservice_get_site_info')).userid;
  }

  async callWs(fn, args = {}) {
    const form = { wstoken: this.token, wsfunction: fn, moodlewsrestformat: 'json', ...flatten(args) };
    const res = await fetch(`${BASE}/webservice/rest/server.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
    return res.json();
  }

  async ws(fn, args = {}) {
    if (!this.token) await this.login();
    const token = this.token;
    let data = await this.callWs(fn, args);
    if (['invalidtoken', 'accessexception'].includes(data?.errorcode)) {
      await this.relogin(token);
      data = await this.callWs(fn, args);
    }
    if (data?.exception) throw new EcampusError(`${fn}: ${data.message}`);
    return data;
  }

  async page(pathOrUrl) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl;
    if (!this.sessionCookie()) await this.login();
    const session = this.sessionCookie();
    let res = await this.request(url);
    if (res.finalUrl.includes('/login/index.php')) {
      if (this.sessionCookie() === session) await this.login();
      else await this.loginPromise;
      res = await this.request(url);
    }
    if (res.finalUrl.includes('/login/index.php')) throw new EcampusError('eCampus 세션을 만들 수 없습니다. 다시 로그인하세요.');
    if (!res.ok) throw new EcampusError(`페이지 요청 실패 (${res.status})`);
    return res.text();
  }

  async download(url, dest) {
    const u = new URL(url);
    const own = u.origin === BASE;
    const isWs = own && u.pathname.startsWith('/webservice/pluginfile.php');
    if (own && !this.token) await this.login();
    const withToken = () => {
      const t = new URL(u);
      t.searchParams.set('token', this.token);
      return t.href;
    };
    const token = this.token;
    let res = await this.request(isWs ? withToken() : url);
    const loggedOut = isWs ? res.headers.get('content-type')?.includes('json') : own && res.finalUrl.includes('/login/index.php');
    if (loggedOut) {
      await this.relogin(token);
      res = await this.request(isWs ? withToken() : url);
    }
    if (!res.ok || (own && res.finalUrl.includes('/login/index.php'))) throw new EcampusError(`다운로드 실패 (${res.status}): ${url}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
    return { path: dest, bytes: fs.statSync(dest).size };
  }
}

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === 'object') flatten(v, key, out);
    else if (v !== undefined) out[key] = typeof v === 'boolean' ? Number(v) : v;
  }
  return out;
}
