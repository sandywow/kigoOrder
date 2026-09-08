/* ═══════════════════════════════════════════════════════════
   共同菜單資料（Google Sheets → Apps Script API）

   資料優先順序：
     遠端 API  >  localStorage 快取  >  js/config.js

   js/config.js 永遠保留為 fallback ——
   API 掛掉或網路不通時，菜單照樣顯示，客人還是點得到餐。

   載入順序（index.html）：js/config.js → js/menu-api.js → js/menu.js

   ⚠ 為什麼要擋著不即時重畫：
   購物車存的是 { cat, idx } —— 分類名稱 + 陣列索引。菜單資料一換，
   索引就會指到別的商品，客人送出的單就錯了。所以只有在
   「購物車是空的」而且「客人還在首頁」時才會真的重畫；
   其他時候只把新資料存進快取，下次載入頁面才生效。
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var SITE = 'orderWeb';

  // 訂單 API 與菜單 API 是同一個 Apps Script 部署（同一個 /exec 網址）
  var DEFAULT_ENDPOINT = 'https://script.google.com/macros/s/AKfycby4GAEoCpwSKlcLXg-wYLo7EfZOKVX0vV6FnexownNbZKD2MR0k0nN0zvd7Hmjog0t2/exec';

  // 刻意跟後台的 kigoMenuConfig 分開，避免兩者互相覆蓋
  var CACHE_KEY = 'kigoMenuRemoteCache';
  var CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // 7 天

  var appliedSignature = null;
  var pendingPayload = null;   // 有東西在購物車時先擱著，等結完單再套

  /* ── 遠端已經給過哪些資料 ──
     js/menu.js 的「LOAD ADMIN OVERRIDES」在本檔之後才執行，會把
     localStorage 的 kigoMenuConfig 無條件寫回這幾個全域結構。
     沒有這份名單的話，下面①剛套好的遠端資料會被後台舊值原封蓋回去
     （首頁 banner 就是這樣一直停在 config.js 的圖），
     而②的 signature 早退又讓遠端資料不會再被套第二次。
     這個物件的參考會傳給 window.KigoMenuApi.remote，menu.js 讀它來讓路。 */
  var remote = {
    menuData: false,
    tabs: false,
    sectionTitles: false,
    landingKeys: {}            // { bannerImages: true, cafeName: true, ... }
  };

  // 這支檔案在 menu.js 之前執行，所以此時 landingData 還沒被後台的
  // localStorage 覆蓋過。後台若改過 API 網址，要自己去讀一次才拿得到。
  function storedEndpoint() {
    try {
      var c = JSON.parse(localStorage.getItem('kigoMenuConfig'));
      var ld = c && c.landingData;
      if (!ld) return null;
      return ld.menuEndpoint || ld.orderEndpoint || null;
    } catch (e) {
      return null;
    }
  }

  function endpoint() {
    var ld = (typeof landingData === 'object' && landingData) || {};
    return storedEndpoint() || ld.menuEndpoint || ld.orderEndpoint || DEFAULT_ENDPOINT;
  }

  /* ── 把 payload 套進 config.js 的四個全域結構 ──
     它們是 const 宣告的物件／陣列，只能就地改內容，不能重新指派。 */
  function applyPayload(payload) {
    if (!payload || payload.ok === false) return false;
    // 沒有 menuData 就不是菜單回應 —— 例如 Apps Script 還沒重新部署，
    // ?action=menu 會落到預設的 "Kigo order API is running." 那則訊息。
    // 這種回應不能拿來當菜單，也不該寫進快取。
    if (!payload.menuData || typeof payload.menuData !== 'object') return false;

    if (payload.menuData && typeof payload.menuData === 'object') {
      Object.keys(menuData).forEach(function (k) { delete menuData[k]; });
      Object.keys(payload.menuData).forEach(function (k) { menuData[k] = payload.menuData[k]; });
      remote.menuData = true;
    }

    if (Array.isArray(payload.tabs) && payload.tabs.length) {
      tabs.length = 0;
      payload.tabs.forEach(function (t) { tabs.push(t); });
      remote.tabs = true;
    }

    if (payload.sectionTitles && typeof payload.sectionTitles === 'object') {
      Object.keys(sectionTitles).forEach(function (k) { delete sectionTitles[k]; });
      Object.keys(payload.sectionTitles).forEach(function (k) { sectionTitles[k] = payload.sectionTitles[k]; });
      remote.sectionTitles = true;
    }

    // 只覆寫 payload 真的有帶的 key。
    // Settings 工作表刻意沒有 orderEndpoint 這一列，所以送單網址不會被清空。
    if (payload.landingData && typeof payload.landingData === 'object') {
      Object.keys(payload.landingData).forEach(function (k) {
        // bannerImages 跟其他欄位不一樣：它不是 Settings 的某一列，
        // 而是 Banners 整張工作表算出來的，所以「payload 一定會有這個 key」。
        // 空陣列代表 Banners 沒有這一站的啟用列 —— 那是「還沒設定」，
        // 不是「刻意清空」，要留給 config.js 的 fallback。
        // 真的想關掉整個海報區請用 Settings 的 hideBanner。
        if (k === 'bannerImages' && Array.isArray(payload.landingData[k]) && !payload.landingData[k].length) return;

        landingData[k] = payload.landingData[k];
        remote.landingKeys[k] = true;
      });
    }

    return true;
  }

  function signatureOf(payload) {
    try {
      return JSON.stringify([payload.menuData, payload.landingData, payload.tabs, payload.sectionTitles]);
    } catch (e) {
      return null;
    }
  }

  // 只有「購物車空的」＋「客人還在首頁」才可以動菜單資料
  function safeToApplyNow() {
    // cart 宣告在 menu.js（本檔之後才載入）。這裡都是在 DOMContentLoaded 之後才呼叫，
    // 正常不會讀不到，但萬一讀不到就當作「不安全」，寧可不動資料。
    try {
      if (cart && cart.length) return false;
    } catch (e) {
      return false;
    }

    var menuPage = document.getElementById('menu-page');
    if (menuPage && menuPage.classList.contains('visible')) return false;

    var successPage = document.getElementById('order-success-page');
    if (successPage && successPage.classList.contains('visible')) return false;

    return true;
  }

  function repaint() {
    if (typeof initLanding === 'function') initLanding();
  }

  function whenReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  /* ── ① 先套快取（同步，在 menu.js 首次渲染之前） ── */
  (function applyCache() {
    var raw;
    try {
      raw = localStorage.getItem(CACHE_KEY);
    } catch (e) {
      return;
    }
    if (!raw) return;
    try {
      var cached = JSON.parse(raw);
      if (!cached || cached.site !== SITE || !cached.payload) return;
      if (!cached.savedAt || Date.now() - cached.savedAt > CACHE_MAX_AGE_MS) return;
      if (applyPayload(cached.payload)) appliedSignature = signatureOf(cached.payload);
    } catch (e) {}
  })();

  /* ── ② 背景抓最新資料 ── */
  function refresh() {
    var url = endpoint();
    if (!url) return;
    url += (url.indexOf('?') >= 0 ? '&' : '?') + 'action=menu&site=' + encodeURIComponent(SITE);

    fetch(url, { cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (payload) {
        if (!payload || payload.ok === false || !payload.menuData) {
          // 工作表還沒建好、或 Apps Script 還沒重新部署：
          // 安靜地沿用快取／config.js，客人照樣點得到餐，也不要污染快取
          console.warn('[menu-api] 遠端還沒有菜單資料，沿用本機資料',
            (payload && payload.error) || (payload && payload.message) || '');
          return;
        }

        var signature = signatureOf(payload);

        // 不管現在能不能套用，都先存快取 —— 下次載入頁面就是最新的
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify({
            site: SITE, savedAt: Date.now(), payload: payload
          }));
        } catch (e) {}

        if (signature && signature === appliedSignature) return;

        whenReady(function () {
          if (!safeToApplyNow()) {
            // 客人正在點餐，先擱著，等回到首頁（結完單／清空購物車）再套
            pendingPayload = payload;
            return;
          }
          if (applyPayload(payload)) {
            appliedSignature = signature;
            repaint();
          }
        });
      })
      .catch(function (err) {
        console.warn('[menu-api] 讀取遠端菜單失敗，沿用本機資料', err);
      });
  }

  // 客人回到首頁時，把剛才擱著的新菜單補套上去
  function flushPending() {
    if (!pendingPayload || !safeToApplyNow()) return;
    var payload = pendingPayload;
    pendingPayload = null;
    if (applyPayload(payload)) {
      appliedSignature = signatureOf(payload);
      repaint();
    }
  }

  whenReady(function () {
    var landing = document.getElementById('landing');
    if (!landing || typeof MutationObserver !== 'function') return;
    // 首頁重新變成 visible 的那一刻就是安全的套用時機
    new MutationObserver(function () {
      if (landing.classList.contains('visible')) flushPending();
    }).observe(landing, { attributes: true, attributeFilter: ['class'] });
  });

  if (typeof fetch === 'function') refresh();

  // 除錯用：Console 打 KigoMenuApi.refresh()
  // remote 給 js/menu.js 判斷「哪些欄位不要再被後台舊值蓋掉」，
  // 順便也方便在 Console 確認遠端到底套進了什麼。
  window.KigoMenuApi = { refresh: refresh, cacheKey: CACHE_KEY, site: SITE, remote: remote };
})();
