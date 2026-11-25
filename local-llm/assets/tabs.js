// 上方的方案 tab：每個方案是一個 tabpanel，網址的 hash 決定顯示哪一個。
// 站內連結可能指到別的分頁裡的段落，瀏覽器不會捲到 hidden 的元素，所以這種連結要先切分頁再捲過去。
(function () {
  const tabs = Array.from(document.querySelectorAll('.tab-list [role="tab"]'));
  const panels = tabs.map((t) => document.getElementById(t.getAttribute('aria-controls')));
  const skip = document.querySelector('.skip');

  // artifact 在 sandbox 的 iframe 裡跑，pushState 可能被擋；擋掉就退回直接改 hash
  function push(hash) {
    try { history.pushState(null, '', hash); } catch (e) { try { location.hash = hash; } catch (e2) { /* 只是網址不跟著變 */ } }
  }

  const byHash = (hash) => document.getElementById(decodeURIComponent((hash || '').slice(1)));
  const panelOf = (el) => (el ? el.closest('[role="tabpanel"]') : null);

  function activate(panel) {
    if (!panel.hidden) return;
    panels.forEach((p, i) => {
      const on = p === panel;
      p.hidden = !on;
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
      tabs[i].tabIndex = on ? 0 : -1;
    });
    const main = panel.querySelector('main');
    if (skip && main) skip.setAttribute('href', '#' + main.id);
    // 隱藏時量不到寬度，切回來讓 app.js 重新判斷記憶體地圖裡的文字放不放得下
    window.dispatchEvent(new Event('resize'));
  }

  // 顯示 hash 所在的分頁；hash 是分頁本身（#mac、#duo）或空的就回到最上面
  function show(hash, scroll) {
    const target = byHash(hash);
    const panel = panelOf(target) || panels[0];
    activate(panel);
    if (!scroll) return;
    if (target && target !== panel) target.scrollIntoView();
    else window.scrollTo(0, 0);
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => {
      if (!panels[i].hidden) return;
      push('#' + panels[i].id);
      show('#' + panels[i].id, true);
    });
    tab.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = tabs[(i + d + tabs.length) % tabs.length];
      next.focus();
      next.click();
    });
  });

  // 目標在同一個分頁的連結交給瀏覽器，只攔指到別的分頁的
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const href = a.getAttribute('href');
    const panel = panelOf(byHash(href));
    if (!panel || !panel.hidden) return;
    e.preventDefault();
    push(href);
    show(href, true);
  });

  window.addEventListener('popstate', () => show(location.hash, true));
  // 外層（例如 artifact 的網址列）直接改 hash 時也要切分頁
  window.addEventListener('hashchange', () => show(location.hash, true));
  // 先切到對的分頁；等字型載完、版面不再變動才捲過去，不然會停在偏上的位置
  show(location.hash, false);
  if (location.hash.length > 1) window.addEventListener('load', () => show(location.hash, true), { once: true });
})();
