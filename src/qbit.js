// Minimální klient qBittorrent WebUI API v2 – pro "donor" torrenty, ze kterých bereme jen zvukovou stopu
// (mimo Radarr/Sonarr, aby je neimportovaly jako náhradu filmu), a pro zastavování zaseknutých torrentů.
const { t } = require('./i18n');

class QbitClient {
  constructor({ url, username, password }) {
    this.url = String(url || '').replace(/\/+$/, '');
    this.username = username || '';
    this.password = password || '';
    this.sid = null;
  }

  get enabled() { return Boolean(this.url && this.password); }

  async login() {
    const res = await fetch(`${this.url}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: this.url },
      body: new URLSearchParams({ username: this.username, password: this.password }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    // Cookie se jmenuje "SID" (qBittorrent 4) nebo "QBT_SID_<port>" (qBittorrent 5) – vezmeme ji celou
    const sid = (res.headers.get('set-cookie') || '').match(/((?:QBT_)?SID[^=]*=[^;]+)/)?.[1];
    // qBittorrent 4 vrací 200 "Ok.", qBittorrent 5 vrací 204 bez textu; neúspěch je "Fails." nebo 401/403
    if (!res.ok || text.trim() === 'Fails.' || !sid) throw new Error(t('qbit.loginFailed', { status: res.status }));
    this.sid = sid;
  }

  async req(path, { method = 'GET', query, form, retry = true } = {}) {
    if (!this.sid) await this.login();
    const u = new URL(`${this.url}/api/v2/${path}`);
    for (const [k, v] of Object.entries(query || {})) u.searchParams.set(k, v);
    const res = await fetch(u, {
      method,
      headers: { Cookie: this.sid, Referer: this.url },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 403 && retry) {
      this.sid = null;
      return this.req(path, { method, query, form, retry: false });
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`qBittorrent ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    try { return text ? JSON.parse(text) : null; } catch { return text; }
  }

  version() { return this.req('app/version'); }

  async ensureCategory(name, savePath) {
    const cats = await this.req('torrents/categories');
    if (cats && cats[name]) return;
    await this.req('torrents/createCategory', { method: 'POST', form: new URLSearchParams({ category: name, savePath }) });
  }

  /**
   * Přidá torrent. Soubor .torrent stáhneme sami (z Prowlarru přes Radarr/Sonarr odkaz) a nahrajeme,
   * protože qBittorrent by k odkazu nemusel dosáhnout; když odkaz přesměruje na magnet, předáme magnet.
   */
  async add({ downloadUrl, magnetUrl, savepath, category, tags }) {
    const form = new FormData();
    form.set('savepath', savepath);
    form.set('category', category);
    form.set('tags', tags);
    form.set('autoTMM', 'false');
    let added = false;
    if (downloadUrl) {
      const res = await fetch(downloadUrl, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
      const loc = res.headers.get('location') || '';
      if (res.status >= 300 && res.status < 400 && loc.startsWith('magnet:')) {
        form.set('urls', loc);
        added = true;
      } else if (res.status >= 300 && res.status < 400 && loc) {
        const r2 = await fetch(loc, { signal: AbortSignal.timeout(60_000) });
        if (!r2.ok) throw new Error(t('qbit.torrentFetchFailed', { status: r2.status }));
        form.set('torrents', new Blob([await r2.arrayBuffer()], { type: 'application/x-bittorrent' }), 'donor.torrent');
        added = true;
      } else if (res.ok) {
        form.set('torrents', new Blob([await res.arrayBuffer()], { type: 'application/x-bittorrent' }), 'donor.torrent');
        added = true;
      } else if (!magnetUrl) {
        throw new Error(t('qbit.torrentFetchFailed', { status: res.status }));
      }
    }
    if (!added && magnetUrl) form.set('urls', magnetUrl);
    if (!added && !magnetUrl) throw new Error(t('qbit.noLink'));
    const out = await this.req('torrents/add', { method: 'POST', form });
    if (String(out).trim() === 'Fails.') throw new Error(t('qbit.rejected'));
  }

  async byTag(tag) {
    const list = await this.req('torrents/info', { query: { tag } });
    return list?.[0] || null;
  }

  // Torrenty podle info hashů (malými i velkými písmeny)
  async byHashes(hashes) {
    if (!hashes.length) return [];
    return (await this.req('torrents/info', { query: { hashes: hashes.map((h) => String(h).toLowerCase()).join('|') } })) || [];
  }

  files(hash) { return this.req('torrents/files', { query: { hash } }); }

  setFilePriority(hash, ids, priority) {
    if (!ids.length) return null;
    return this.req('torrents/filePrio', { method: 'POST', form: new URLSearchParams({ hash, id: ids.join('|'), priority: String(priority) }) });
  }

  /**
   * Sekvenční stahování + priorita prvního/posledního kusu (začátek videa napřed); dnes jen vypnutí u starších úloh.
   * API je umí jen přepínat, takže podle stavu `t` z torrents/info (seq_dl, f_l_piece_prio).
   */
  async prioritizeStart(t, on) {
    const form = () => new URLSearchParams({ hashes: t.hash });
    if (Boolean(t.seq_dl) !== on) await this.req('torrents/toggleSequentialDownload', { method: 'POST', form: form() });
    if (Boolean(t.f_l_piece_prio) !== on) await this.req('torrents/toggleFirstLastPiecePrio', { method: 'POST', form: form() });
  }

  // qBittorrent 5: stop/start, qBittorrent 4: pause/resume
  async stop(hashes) { return this.v4Fallback('torrents/stop', 'torrents/pause', hashes); }
  async start(hashes) { return this.v4Fallback('torrents/start', 'torrents/resume', hashes); }

  async v4Fallback(path, old, hashes) {
    try {
      return await this.req(path, { method: 'POST', form: new URLSearchParams({ hashes }) });
    } catch (e) {
      if (!/HTTP 404/.test(e.message)) throw e;
      return this.req(old, { method: 'POST', form: new URLSearchParams({ hashes }) });
    }
  }

  addTags(hashes, tags) { return this.req('torrents/addTags', { method: 'POST', form: new URLSearchParams({ hashes, tags }) }); }
  removeTags(hashes, tags) { return this.req('torrents/removeTags', { method: 'POST', form: new URLSearchParams({ hashes, tags }) }); }
  // Smaže tagy úplně (ze seznamu tagů qBittorrentu), ne jen z torrentů; `tags` jsou oddělené čárkou
  deleteTags(tags) { return this.req('torrents/deleteTags', { method: 'POST', form: new URLSearchParams({ tags }) }); }

  delete(hash, deleteFiles = true) {
    return this.req('torrents/delete', { method: 'POST', form: new URLSearchParams({ hashes: hash, deleteFiles: String(deleteFiles) }) });
  }
}

module.exports = { QbitClient };
