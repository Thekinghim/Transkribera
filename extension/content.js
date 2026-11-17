// Innehållsskript: letar efter <video>/<audio>/<source> med vanliga (icke-blob) adresser.
(() => {
  if (window.__transkriberaContent) return;
  window.__transkriberaContent = true;
  const sent = new Set();

  function collect() {
    const urls = [];
    for (const el of document.querySelectorAll('video, audio, source')) {
      for (const u of [el.currentSrc, el.src, el.getAttribute('src')]) {
        if (!u) continue;
        let abs;
        try { abs = new URL(u, document.baseURI).href; } catch { continue; }
        if (!/^https?:/i.test(abs) || sent.has(abs)) continue;
        sent.add(abs);
        urls.push(abs);
      }
    }
    if (urls.length) {
      try { chrome.runtime.sendMessage({ type: 'dom-media', urls }).catch(() => {}); } catch {}
    }
  }

  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(collect, 300); };
  collect();
  new MutationObserver(schedule).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['src'],
  });
  document.addEventListener('loadstart', schedule, true);
})();
