let state = {};

function deepClone(o) { return JSON.parse(JSON.stringify(o)); }
function ve(v)        { return v == null ? '' : v; }
function ne(v)        { const s = String(v).trim(); return s === '' ? null : s; }

// 後台存進 localStorage 的空欄位會是 null。直接 Object.assign 的話，
// 這個 null 會蓋掉 config.js 寫死的預設值（訂單 API 網址就是這樣被清成空的）。
// 跟前台 menu.js 的處理一致：null 代表「沒設定」，交還給 config.js 的預設值。
function mergeLanding(defaults, stored) {
  const merged = Object.assign({}, defaults);
  Object.keys(stored || {}).forEach(k => {
    if (stored[k] !== null) merged[k] = stored[k];
  });
  return merged;
}

function loadState() {
  const defaults = {
    menuData:      deepClone(menuData),
    landingData:   deepClone(landingData),
    tabs:          deepClone(tabs),
    sectionTitles: deepClone(sectionTitles)
  };
  const stored = localStorage.getItem('kigoMenuConfig');
  if (stored) {
    try {
      const c = JSON.parse(stored);
      state = {
        menuData:      c.menuData      || defaults.menuData,
        landingData:   mergeLanding(defaults.landingData, c.landingData),
        tabs:          c.tabs          || defaults.tabs,
        sectionTitles: Object.assign({}, defaults.sectionTitles, c.sectionTitles || {})
      };
      return;
    } catch (e) {
      console.warn('kigoMenuConfig parse error', e);
    }
  }
  state = defaults;
}

function saveConfig() {
  state.landingData = readLanding();
  localStorage.setItem('kigoMenuConfig', JSON.stringify(state));
  showToast('已儲存！重新整理首頁即可看到更新');
}

function resetConfig() {
  if (!confirm('確定要清除所有後台設定，恢復 config.js 預設值嗎？')) return;
  localStorage.removeItem('kigoMenuConfig');
  location.reload();
}
