'use strict';
/* ==========================================================================
   Notifikační centrum – zvonek v horní liště
   Data: /api/notifications (src/inbox.js). Používá pomocné funkce a stav z app.js.
   ========================================================================== */
(() => {
  const NC = { list: [], unread: 0, filter: lsGet('nc.filter', 'all'), open: false, seen: null, json: '' };
  const KIND_ICON = { proposal: 'sparkles', download: 'download', merge: 'merge', syncfix: 'refresh', backup: 'archive', langcheck: 'headphones', error: 'alert' };
  const FILTERS = [['all', t('common.all')], ['unread', t('notif.filter.unread')], ['problems', t('notif.filter.problems')]];
  const btn = $('#nc-btn');
  const panel = $('#nc-panel');
  const baseTitle = document.title;

  const isProblem = (n) => n.level === 'warn' || n.level === 'error';
  const filtered = () => NC.list.filter((n) => (NC.filter === 'unread' ? !n.read : NC.filter === 'problems' ? isProblem(n) : true));

  function badge() {
    const el = $('#nc-count');
    el.hidden = !NC.unread;
    el.textContent = NC.unread > 99 ? '99+' : NC.unread;
    const label = NC.unread ? t('notif.titleUnread', { count: NC.unread }) : t('notif.title');
    btn.setAttribute('aria-label', label);
    btn.title = label;
    document.title = NC.unread ? `(${NC.unread}) ${baseTitle}` : baseTitle;
  }

  function itemHtml(n) {
    const meta = [
      `<time datetime="${esc(n.t)}" title="${esc(fullDate(n.t))}">${ago(n.t)}</time>`,
      n.count > 1 ? `<span title="${t('notif.repeatedTitle')}">${n.count}×</span>` : '',
      n.open ? `<span class="nc-open">${t('notif.awaiting')}</span>` : '',
    ].filter(Boolean).join('<span class="sep">·</span>');
    return `<li class="nc-item lv-${esc(n.level)} ${n.read ? '' : 'unread'}">
      <button class="nc-main" data-nc="go" data-id="${esc(n.id)}">
        <span class="nc-ic">${icon(KIND_ICON[n.kind] || 'bell')}</span>
        <span class="nc-body">
          <b class="nc-title">${esc(n.title)}</b>
          ${n.text ? `<span class="nc-text">${esc(n.text)}</span>` : ''}
          <span class="nc-meta">${meta}</span>
        </span>
        ${n.read ? '' : `<i class="nc-dot" aria-label="${t('notif.unread')}"></i>`}
      </button>
      <button class="icon-btn xs nc-del" data-nc="del" data-id="${esc(n.id)}" title="${t('notif.remove')}" aria-label="${t('notif.removeLabel')}">${icon('x')}</button>
    </li>`;
  }

  function render() {
    if (!NC.open) return;
    const list = filtered();
    const counts = { all: NC.list.length, unread: NC.unread, problems: NC.list.filter(isProblem).length };
    let html = '';
    let day = '';
    for (const n of list) {
      const d = dayLabel(n.t);
      if (d !== day) { html += `<li class="nc-day">${esc(d)}</li>`; day = d; }
      html += itemHtml(n);
    }
    const empty = NC.filter === 'unread' ? t('notif.empty.unread') : NC.filter === 'problems' ? t('notif.empty.problems') : t('notif.empty.all');
    const scroll = $('.nc-list', panel)?.scrollTop || 0;
    panel.innerHTML = `
      <div class="nc-head">
        <h2 id="nc-title">${t('notif.title')}</h2>
        <span class="spacer"></span>
        <button class="btn ghost sm" data-nc="readall" ${NC.unread ? '' : 'disabled'}>${icon('check')}<span>${t('notif.readAll')}</span></button>
        <button class="icon-btn sm" data-nc="close" aria-label="${t('common.close')}">${icon('x')}</button>
      </div>
      <div class="nc-tools">
        <div class="segmented" role="group" aria-label="${t('log.filter')}">
          ${FILTERS.map(([k, l]) => `<button data-nc="filter" data-f="${k}" aria-pressed="${NC.filter === k}">${l}${counts[k] ? ` <span class="muted">${counts[k]}</span>` : ''}</button>`).join('')}
        </div>
        <span class="spacer"></span>
        ${NC.list.some((n) => n.read) ? `<button class="btn ghost sm" data-nc="clear" title="${t('notif.clearTitle')}">${icon('trash')}<span>${t('notif.clear')}</span></button>` : ''}
      </div>
      ${list.length
        ? `<ul class="nc-list">${html}</ul>`
        : `<div class="nc-empty">${icon('bell', 'xl')}<p>${empty}</p></div>`}`;
    const ul = $('.nc-list', panel);
    if (ul) ul.scrollTop = scroll;
  }

  async function load() {
    try {
      const data = await api('GET', 'notifications');
      const json = JSON.stringify(data);
      if (json === NC.json) return;
      NC.json = json;
      // Nové nepřečtené od posledního načtení → krátký toast (ne při prvním načtení stránky)
      if (NC.seen) {
        const fresh = data.list.filter((n) => !n.read && NC.seen.get(n.id) !== n.t);
        if (fresh.length && !NC.open) {
          fresh.slice(0, 2).forEach((n) => toast(n.title, { error: n.level === 'error' }));
          if (fresh.length > 2) toast(t('notif.more', { count: fresh.length - 2 }));
        }
      }
      NC.seen = new Map(data.list.map((n) => [n.id, n.t]));
      NC.list = data.list;
      NC.unread = data.unread;
      badge();
      render();
    } catch { /* server nedostupný – ukáže stavový řádek */ }
  }

  function setOpen(open) {
    NC.open = open;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    btn.classList.toggle('on', open);
    if (open) {
      render();
      load();
      setTimeout(() => $('[data-nc="filter"][aria-pressed="true"]', panel)?.focus(), 30);
    }
  }

  async function markRead(ids) {
    NC.list.forEach((n) => { if (!ids || ids.includes(n.id)) n.read = true; });
    NC.unread = NC.list.filter((n) => !n.read).length;
    badge();
    render();
    try { NC.unread = (await api('POST', 'notifications/read', { ids })).unread; NC.json = ''; badge(); } catch (e) { toast(e.message, { error: true }); }
  }

  // Kam oznámení vede: čekající návrh → Návrhy, úloha → Aktivita, jinak detail položky nebo záložka
  async function go(n) {
    if (!n.read) markRead([n.id]);
    setOpen(false);
    btn.focus();
    const l = n.link || {};
    if (l.proposal && n.open) return openProposal(l.proposal);
    if (l.job) {
      const jobs = await api('GET', 'downloads').catch(() => []);
      const byId = new Map(jobs.map((j) => [j.id, j]));
      let root = byId.get(l.job);
      for (let i = 0; root?.retryOf && byId.has(root.retryOf) && i < 50; i++) root = byId.get(root.retryOf);
      if (root) {
        S.act.open.add(root.id);
        S.act.q = '';
        S.act.f = 'all';
        showTab('activity');
        for (let i = 0; i < 20; i++) {
          const el = $(`#view-activity .j-btn[data-id="${CSS.escape(root.id)}"]`);
          if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.focus({ preventScroll: true }); break; }
          await new Promise((r) => setTimeout(r, 100));
        }
        return undefined;
      }
    }
    if (l.item) {
      if (!S.items.some((i) => i.key === l.item)) S.items = await api('GET', 'items').catch(() => S.items);
      if (S.items.some((i) => i.key === l.item)) return openDrawer(l.item);
    }
    if (l.tab) return showTab(l.tab);
    return undefined;
  }

  btn.addEventListener('click', () => setOpen(!NC.open));

  panel.addEventListener('click', async (e) => {
    const tg = e.target.closest('[data-nc]');
    if (!tg) return;
    const n = NC.list.find((x) => x.id === tg.dataset.id);
    switch (tg.dataset.nc) {
      case 'close': setOpen(false); btn.focus(); break;
      case 'filter': NC.filter = tg.dataset.f; lsSet('nc.filter', NC.filter); render(); break;
      case 'readall': markRead(null); break;
      case 'go': if (n) go(n); break;
      case 'del':
        NC.list = NC.list.filter((x) => x.id !== tg.dataset.id);
        NC.unread = NC.list.filter((x) => !x.read).length;
        badge();
        render();
        try { await api('DELETE', `notifications/${encodeURIComponent(tg.dataset.id)}`); NC.json = ''; } catch (err) { toast(err.message, { error: true }); }
        break;
      case 'clear':
        try {
          NC.unread = (await api('POST', 'notifications/clear', { onlyRead: true })).unread;
          NC.list = NC.list.filter((x) => !x.read);
          NC.json = '';
          badge();
          render();
        } catch (err) { toast(err.message, { error: true }); }
        break;
      default:
    }
  });

  // Zavřít klikem mimo panel (pointerdown – dřív, než se panel po kliknutí překreslí)
  document.addEventListener('pointerdown', (e) => {
    if (NC.open && !panel.contains(e.target) && !btn.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && NC.open) { e.stopPropagation(); setOpen(false); btn.focus(); }
  }, true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

  load();
  setInterval(() => { if (!document.hidden) load(); }, 15_000);
})();
