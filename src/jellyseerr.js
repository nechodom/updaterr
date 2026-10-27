// Jellyseerr / Seerr (volitelné): spouští po schválení žádosti hledání v Radarru/Sonarru? Kvůli prvnímu stažení
// (firstgrab.js) má být vypnuté – jinak Radarr/Sonarr stáhne dřív a Updaterr jeho stažení ruší.
// Zdroj: namountovaný settings.json (JELLYSEERR_CONFIG), nebo API (JELLYSEERR_URL + JELLYSEERR_API_KEY).
// JELLYSEERR_URL je zároveň odkaz do nastavení v UI. Bez Jellyseerru vrací null a UI o něm nemluví.
const fs = require('node:fs');

const CACHE_MS = 60e3;

// Servery Radarr/Sonarr z nastavení Jellyseerru → [{ name, search }]
const servers = (list) => (Array.isArray(list) ? list : []).map((x) => ({ name: x.name || '?', is4k: Boolean(x.is4k), search: !x.preventSearch }));

class Jellyseerr {
  constructor(env) {
    this.file = env.JELLYSEERR_CONFIG || '';
    this.url = String(env.JELLYSEERR_URL || '').replace(/\/+$/, '');
    this.apiKey = env.JELLYSEERR_API_KEY || '';
    this.cache = null;
  }

  get enabled() { return Boolean((this.file && fs.existsSync(this.file)) || (this.url && this.apiKey)); }

  async read() {
    if (this.file && fs.existsSync(this.file)) {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { radarr: servers(s.radarr), sonarr: servers(s.sonarr) };
    }
    const get = async (path) => {
      const res = await fetch(`${this.url}/api/v1${path}`, { headers: { 'X-Api-Key': this.apiKey }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`Jellyseerr ${path} → HTTP ${res.status}`);
      return res.json();
    };
    const [radarr, sonarr] = await Promise.all([get('/settings/radarr'), get('/settings/sonarr')]);
    return { radarr: servers(radarr), sonarr: servers(sonarr) };
  }

  // { url, radarr, sonarr, error? } (nejvýš minutu staré), nebo null bez Jellyseerru
  async status() {
    if (!this.enabled) return null;
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    let value;
    try {
      value = { url: this.url || null, ...(await this.read()) };
    } catch (e) {
      value = { url: this.url || null, radarr: [], sonarr: [], error: e.message };
    }
    this.cache = { at: Date.now(), value };
    return value;
  }

  // Poslední známý stav bez čekání (přehled se načítá často)
  summary() {
    if (!this.enabled) return null;
    if (!this.cache || Date.now() - this.cache.at >= CACHE_MS) this.status().catch(() => {});
    return this.cache?.value || null;
  }
}

module.exports = { Jellyseerr, servers };
