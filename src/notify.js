// Notifikace: Telegram (s tlačítky "Stáhnout" přímo ve zprávě) a/nebo ntfy.
const L = require('./lang');
const LANGS = require('./languages');
const { rejectProposal, candId, resolveCandidate } = require('./search');
const I18N = require('./i18n');

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const gb = (b) => `${(b / 1024 ** 3).toFixed(1)} GB`;
const flag = (c) => [c.pri && LANGS.flagOf(L.primary()), c.sec && LANGS.flagOf(L.secondary())].filter(Boolean).join('') || '❔';
const conf = (c) => (c === 'likely' ? I18N.t('notify.conf.likely') : c === 'guess' ? I18N.t('notify.conf.guess') : '');
// U smíšené série: " (1/6 ep. EN)" – série se hodnotí podle nejhorší epizody
const epsMixed = (cur) => {
  const n = cur?.tierCounts;
  if (!n) return '';
  const total = n.reduce((a, b) => a + b, 0);
  const better = [3, 2, 1].filter((t) => t > cur.tier && n[t]);
  return better.length ? ` (${better.map((t) => `${n[t]}/${total} ep. ${L.tierLabel(t)}`).join(', ')})` : '';
};

class Notifier {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.tgToken = env.TELEGRAM_BOT_TOKEN || '';
    this.tgChat = env.TELEGRAM_CHAT_ID || '';
    this.ntfyUrl = env.NTFY_URL || '';
    this.ntfyToken = env.NTFY_TOKEN || '';
    this.publicUrl = String(env.PUBLIC_URL || '').replace(/\/+$/, '');
    // S heslem k webu nedáváme do ntfy tlačítka "Stáhnout" (heslo by putovalo přes ntfy server ke všem odběratelům)
    this.ntfyActions = !env.AUTH_PASSWORD;
    this.tgOffset = 0;
  }

  get telegram() { return Boolean(this.tgToken && this.tgChat); }
  get ntfy() { return Boolean(this.ntfyUrl); }
  get enabled() { return this.telegram || this.ntfy; }

  async tg(method, body) {
    const res = await fetch(`https://api.telegram.org/bot${this.tgToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(method === 'getUpdates' ? 70_000 : 20_000),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
    return data.result;
  }

  async ntfySend({ title, message, tags, actions, priority }) {
    // JSON publish (hlavičky by neunesly diakritiku)
    const url = new URL(this.ntfyUrl);
    const topic = url.pathname.replace(/^\/+/, '');
    const body = { topic, title, message, tags, priority, actions };
    if (this.publicUrl) body.click = this.publicUrl;
    const res = await fetch(url.origin, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.ntfyToken ? { Authorization: `Bearer ${this.ntfyToken}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
  }

  candidateLine(c, i) {
    const what = c.kind === 'merge'
      ? I18N.t('notify.cand.merge', { lang: L.label(c.mergeLang), conf: conf(c.confidence) }) + (c.parts?.length > 1 ? I18N.t('notify.cand.mergeParts', { count: c.parts.length }) : '')
      : c.kind === 'cutmatch'
      ? I18N.t('notify.cand.cutmatch', { lang: L.label(c.donor.mergeLang), conf: conf(c.confidence), quality: c.quality, title: esc(c.donor.title) })
      : `${flag(c)} <b>${L.tierLabel(c.tier)}</b>${conf(c.confidence)} · ${c.quality}${c.vcodecName ? ` · ${c.kind === 'codec' ? `<b>${c.vcodecName}</b>` : c.vcodecName}` : ''}${c.parts?.length > 1 ? I18N.t('notify.cand.set', { count: c.parts.length }) : ''}`;
    return `${i + 1}. ${what} · ${c.seeders ?? '?'}↑ ${c.leechers ?? '?'}↓ · ${gb(c.size)} · ${esc(c.indexer)}\n   <code>${esc(c.title)}</code>` +
      (c.warnings.length ? `\n   ⚠️ ${esc(c.warnings.join(', '))}` : '');
  }

  proposalText(p, item) {
    const cur = p.current;
    const icon = item.app === 'radarr' ? '🎬' : '📺';
    return `${icon} <b>${esc(p.label)}</b>\n` +
      `${I18N.t('notify.now', { tier: L.tierLabel(cur.tier), mixed: epsMixed(cur), quality: esc(cur.quality) + (p.candidates.some((c) => c.kind === 'codec') ? ` · ${esc(cur.vcodecName || '?')}` : ''), audio: esc(cur.audio) })}

` +
      `${I18N.t('notify.canDownload')}
` +
      p.candidates.slice(0, 5).map((c, i) => this.candidateLine(c, i)).join('\n');
  }

  async proposal(p, item) {
    const c0 = p.candidates[0];
    this.ctx.inbox?.add({
      kind: 'proposal', level: 'info', key: `p:${p.id}`,
      title: I18N.t(c0?.kind === 'merge' ? 'notify.inbox.proposalMerge' : 'notify.inbox.proposal', { label: p.label }),
      text: c0 ? I18N.t('notify.inbox.proposalText', {
        tier: L.tierLabel(p.current.tier), quality: p.current.quality,
        target: c0.kind === 'merge' ? I18N.t('notify.inbox.addAudio', { lang: L.label(c0.mergeLang) }) : `${L.tierLabel(c0.tier)} · ${c0.quality}`,
        more: p.candidates.length > 1 ? I18N.t('notify.inbox.moreCandidates', { n: p.candidates.length - 1 }) : '',
      }) : '',
      link: { proposal: p.id, item: p.itemKey },
    });
    const tg = async () => {
      const n = Math.min(5, p.candidates.length);
      const keyboard = [
        p.candidates.slice(0, n).map((c, i) => ({ text: `${c.kind === 'merge' ? '🔀' : '⬇️'} ${i + 1}`, callback_data: `g|${p.id}|${candId(c)}` })),
        [{ text: I18N.t('notify.btn.no'), callback_data: `x|${p.id}` }, { text: I18N.t('notify.btn.month'), callback_data: `m|${p.id}` }],
      ];
      if (/^https?:\/\//.test(this.publicUrl)) keyboard[1].push({ text: I18N.t('notify.btn.open'), url: `${this.publicUrl}/#p=${p.id}` });
      const msg = await this.tg('sendMessage', {
        chat_id: this.tgChat, text: this.proposalText(p, item), parse_mode: 'HTML',
        disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard },
      });
      p.tgMessageId = msg.message_id;
      this.ctx.store.save();
    };
    const ntfy = async () => {
      const c = p.candidates[0];
      const actions = [];
      if (this.publicUrl) {
        if (this.ntfyActions) {
          p.candidates.slice(0, 2).forEach((x, i) => actions.push({
            action: 'http', label: I18N.t(x.kind === 'merge' ? 'notify.btn.addAudio' : 'notify.btn.download', { n: i + 1 }),
            url: `${this.publicUrl}/api/proposals/${p.id}/grab/${candId(x)}`, method: 'POST', clear: true,
          }));
        }
        actions.push({ action: 'view', label: I18N.t('notify.btn.view'), url: `${this.publicUrl}/#p=${p.id}` });
      }
      await this.ntfySend({
        title: I18N.t('notify.ntfy.title', { label: p.label }),
        message: `${I18N.t('notify.ntfy.now', { tier: L.tierLabel(p.current.tier), quality: p.current.quality })}\n` +
          p.candidates.slice(0, 3).map((x, i) => `${i + 1}. ${L.tierLabel(x.tier)} · ${x.quality} · ${I18N.t('notify.seeders', { n: x.seeders ?? '?' })} · ${gb(x.size)}\n   ${x.title}`).join('\n'),
        tags: [c.tier === 3 ? `flag-${(LANGS.get(L.primary())?.country || 'white').toLowerCase()}` : 'arrow_up'],
        actions,
      });
    };
    await this.all([this.telegram && tg, this.ntfy && ntfy]);
  }

  // Notifikační centrum ve webu – ukládá se vždy, i bez Telegramu/ntfy
  inboxDownload(d, event) {
    if (!this.ctx.inbox) return;
    const what = I18N.t(d.type === 'merge' ? 'notify.inbox.what.merge' : d.type === 'syncfix' ? 'notify.inbox.what.syncfix' : 'notify.inbox.what.download');
    const ev = {
      grabbed: { level: 'info', title: `${I18N.t(d.type === 'merge' ? 'notify.grabbed.audio' : d.first ? 'notify.grabbed.new' : 'notify.grabbed.file')}${d.auto && !d.first ? I18N.t('notify.tag.auto') : ''}${d.retryOf ? I18N.t('notify.inbox.retry', { attempt: d.attempt }) : ''}`, text: d.title },
      done: d.type === 'syncfix' ? { level: 'ok', title: I18N.t('notify.inbox.syncFixed'), text: d.message }
        : d.warning ? { level: 'warn', title: I18N.t('notify.inbox.doneWarn'), text: d.warning }
        : d.first ? { level: 'ok', title: I18N.t('notify.inbox.downloaded'), text: `${L.tierLabel(d.result?.tier)}${d.result?.audio ? ` (${d.result.audio}, ${d.result.quality})` : ''}` }
        : { level: 'ok', title: I18N.t(d.type === 'merge' ? 'notify.inbox.audioAdded' : 'notify.inbox.upgradeDone'), text: `${L.tierLabel(d.prev?.tier)} → ${L.tierLabel(d.result?.tier)}${d.result?.audio ? ` (${d.result.audio}, ${d.result.quality})` : ''}` },
      failed: { level: 'error', title: I18N.t('notify.inbox.failed', { what }), text: d.message },
      blocked: { level: 'error', title: I18N.t('notify.inbox.blocked'), text: d.message },
      lost: { level: 'warn', title: I18N.t('notify.inbox.lost', { what }), text: d.message },
    }[event];
    if (!ev) return;
    this.ctx.inbox.add({
      kind: d.type === 'merge' || d.type === 'syncfix' ? d.type : 'download', ...ev,
      title: `${ev.title}: ${d.label}`, text: String(ev.text || ''),
      key: `j:${d.id}:${event}`, link: { item: d.itemKey || d.itemKeys?.[0], job: d.id },
    });
  }

  async download(d, event) {
    this.inboxDownload(d, event);
    const st = this.ctx.store.settings;
    if (!this.enabled || !st.notifyDownloads) return;
    const texts = {
      grabbed: I18N.t('notify.grabbed', {
        what: I18N.t(d.type === 'merge' ? 'notify.grabbed.audio' : d.first ? 'notify.grabbed.new' : 'notify.grabbed.file'),
        auto: d.auto && !d.first ? I18N.t('notify.tag.auto') : '', retry: d.retryOf ? I18N.t('notify.tag.retry', { attempt: d.attempt }) : '',
        label: esc(d.label), title: esc(d.title),
      }),
      done: d.type === 'syncfix'
        ? `✅ <b>${esc(d.label)}</b>: ${esc(d.message)}`
        : d.warning
        ? I18N.t('notify.doneWarn', { label: esc(d.label), warning: esc(d.warning) })
        : d.first
        ? I18N.t('notify.doneFirst', { label: esc(d.label), tier: L.tierLabel(d.result?.tier), audio: esc(d.result?.audio), quality: esc(d.result?.quality) })
        : `✅ <b>${esc(d.label)}</b>: ${L.tierLabel(d.prev.tier)} → <b>${L.tierLabel(d.result?.tier)}</b> (${esc(d.result?.audio)}, ${esc(d.result?.quality)})`,
      failed: `❌ <b>${esc(d.label)}</b>: ${esc(d.message)}`,
      blocked: I18N.t('notify.blocked', { label: esc(d.label), message: esc(d.message) }),
      lost: `❔ <b>${esc(d.label)}</b>: ${esc(d.message)}`,
    };
    const html = texts[event];
    if (html) await this.send(html);
  }

  // Sloučení / oprava synchronizace s odchylkou: záloha originálu zůstává, ať se to zkontroluje (backups.js)
  async backupReview(j) {
    const issues = j.backupCheck?.issues || [];
    this.ctx.inbox?.add({
      kind: 'backup', level: 'warn', key: `b:${j.id}`,
      title: I18N.t('notify.inbox.review', { label: j.label }),
      text: I18N.t(j.type === 'syncfix' ? 'notify.inbox.reviewText.syncfix' : 'notify.inbox.reviewText.merge', {
        issues: issues.slice(0, 3).map((i) => `${i.file ? `${i.file}: ` : ''}${i.msg}`).join('; '),
        more: issues.length > 3 ? ` ${I18N.t('notify.more', { n: issues.length - 3 })}` : '',
      }),
      link: { tab: 'backups' },
    });
    if (!this.enabled || !this.ctx.store.settings.notifyDownloads) return;
    const lines = issues.slice(0, 6).map((i) => `• ${i.file ? `${esc(i.file)}: ` : ''}${esc(i.msg)}`);
    if (issues.length > 6) lines.push(I18N.t('notify.more', { n: issues.length - 6 }));
    const link = /^https?:\/\//.test(this.publicUrl) ? `\n<a href="${esc(this.publicUrl)}/#backups">${I18N.t('notify.review.open')}</a>` : '';
    await this.send(I18N.t(j.type === 'syncfix' ? 'notify.review.syncfix' : 'notify.review.merge', { label: esc(j.label), lines: lines.join('\n'), link }));
  }

  // Kanály se posílají souběžně a nezávisle: výpadek Telegramu nesmí zastavit ntfy (a naopak).
  // Chyby se nakonec ohlásí všechny najednou.
  async all(senders) {
    const names = [];
    const tasks = [];
    senders.forEach((fn, i) => { if (fn) { names.push(i === 0 ? 'Telegram' : 'ntfy'); tasks.push(fn()); } });
    const res = await Promise.allSettled(tasks);
    const errors = res.map((r, i) => (r.status === 'rejected' ? `${names[i]}: ${r.reason?.message || r.reason}` : null)).filter(Boolean);
    if (errors.length) throw new Error(errors.join('; '));
  }

  async send(html) {
    await this.all([
      this.telegram && (() => this.tg('sendMessage', { chat_id: this.tgChat, text: html, parse_mode: 'HTML', disable_web_page_preview: true })),
      this.ntfy && (() => this.ntfySend({ title: 'Updaterr', message: html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') })),
    ]);
  }

  async test() {
    if (!this.enabled) throw new Error(I18N.t('err.noNotify'));
    await this.all([
      this.telegram && (() => this.tg('sendMessage', { chat_id: this.tgChat, text: I18N.t('notify.test.telegram') })),
      this.ntfy && (() => this.ntfySend({ title: 'Updaterr', message: I18N.t('notify.test.ntfy') })),
    ]);
  }

  // --- Telegram: příjem kliknutí na tlačítka (long polling, nepotřebuje veřejnou URL) ---
  async pollTelegram() {
    if (!this.telegram) return;
    for (;;) {
      try {
        const updates = await this.tg('getUpdates', { offset: this.tgOffset, timeout: 50, allowed_updates: ['callback_query'] });
        for (const u of updates) {
          this.tgOffset = u.update_id + 1;
          // Bez čekání: stahování (ověření seedů) trvá i minuty a další kliknutí by mezitím Telegramu vypršela
          if (u.callback_query) this.onCallback(u.callback_query).catch((e) => this.ctx.store.log('warn', `Telegram: ${e.message}`));
        }
      } catch (e) {
        this.ctx.store.log('warn', `Telegram polling: ${e.message}`);
        await new Promise((r) => setTimeout(r, 30_000));
      }
    }
  }

  async onCallback(cb) {
    const { store } = this.ctx;
    const chatId = String(cb.message?.chat?.id);
    if (chatId !== String(this.tgChat)) {
      await this.tg('answerCallbackQuery', { callback_query_id: cb.id, text: I18N.t('notify.cb.denied') });
      return;
    }
    const [action, pid, ref] = String(cb.data || '').split('|');
    const p = store.s.proposals[pid];
    let answer = '';
    let footer = '';
    let failed = false;
    try {
      if (!p) throw new Error(I18N.t('err.proposalGone'));
      if (action === 'g') {
        // Telegram čeká na odpověď max. pár sekund – potvrdíme hned, stahování (s ověřením seedů) poběží dál
        await this.tg('answerCallbackQuery', { callback_query_id: cb.id, text: I18N.t('notify.cb.grabbing') }).catch(() => {});
        // Starší zprávy mají v tlačítku pořadí, novější ID kandidáta
        const idx = /^\d$/.test(ref) ? Number(ref) : resolveCandidate(p, ref);
        const d = await this.ctx.grab(pid, idx);
        footer = `\n\n${I18N.t(d.type === 'merge' ? 'notify.cb.adding' : 'notify.cb.downloading', { n: idx + 1, title: esc(d.title) })}`;
      } else if (action === 'x' || action === 'm') {
        rejectProposal(this.ctx, p, action === 'x' ? 3650 : 30);
        answer = I18N.t(action === 'x' ? 'notify.cb.ignore' : 'notify.cb.remind');
        footer = `\n\n${I18N.t(action === 'x' ? 'notify.cb.ignored' : 'notify.cb.snoozed')}`;
      }
    } catch (e) {
      answer = e.message.slice(0, 190);
      footer = `\n\n❌ ${esc(e.message)}`;
      failed = true;
    }
    if (answer) await this.tg('answerCallbackQuery', { callback_query_id: cb.id, text: answer, show_alert: failed }).catch(() => {});
    if (cb.message && footer) {
      const keepButtons = failed;
      await this.tg('editMessageText', {
        chat_id: this.tgChat, message_id: cb.message.message_id,
        text: (p ? this.proposalText(p, store.s.items[p.itemKey] || { app: 'radarr' }) : esc(cb.message.text || '')) + footer,
        parse_mode: 'HTML', disable_web_page_preview: true,
        ...(keepButtons ? { reply_markup: cb.message.reply_markup } : {}),
      }).catch(() => {});
    }
  }
}

module.exports = { Notifier };
