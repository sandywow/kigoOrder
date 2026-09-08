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
  let usedStored = false;
  if (stored) {
    try {
      const c = JSON.parse(stored);
      state = {
        menuData:      c.menuData      || defaults.menuData,
        landingData:   mergeLanding(defaults.landingData, c.landingData),
        tabs:          c.tabs          || defaults.tabs,
        sectionTitles: Object.assign({}, defaults.sectionTitles, c.sectionTitles || {})
      };
      usedStored = true;
    } catch (e) {
      console.warn('kigoMenuConfig parse error', e);
    }
  }
  if (!usedStored) state = defaults;

  // 本機資料先就位（畫面立刻可用），再背景去 Sheets 拿真正的原始列。
  // Apps Script 常要好幾秒，不能讓後台開著空白等它。
  refreshStateFromSheets();
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


/* ═══════════════════════════════════════════════════════════
   Google Sheets 讀取層（action=menuRaw）

   資料優先順序：Sheets > localStorage(kigoMenuConfig) > js/config.js

   為什麼讀 menuRaw 而不是 action=menu：
   menu 是「組裝好給前台渲染」的資料 —— 它會過濾掉下架與別站的列、
   把同一個商品在多個分類的位置攤平，也不會帶分類連結的排序資訊。
   後台要能寫回試算表，就必須知道「這個欄位來自哪一列」，所以要原始列。

   state.raw 是唯一的真相來源；顯示用的 state.menuData / tabs /
   sectionTitles / landingData 都是從它算出來的，不要反過來。

   ⚠ 這一步只改讀取。saveConfig() 仍然只寫 localStorage，
     完全沒有任何寫回 Sheets 的動作。
   ═══════════════════════════════════════════════════════════ */

var ADMIN_SITE = 'orderWeb';

// 遠端資料是背景載入的（Apps Script 常要好幾秒）。使用者可能在這段時間就開始改欄位，
// 這時候把 state 換掉等於默默吃掉他的編輯 —— 所以一律讓路，只在 console 說一聲。
var adminEdited = false;

document.addEventListener('input',  markAdminEdited, true);
document.addEventListener('change', markAdminEdited, true);

function markAdminEdited(e) {
  // 便籤與統計的輸入框不算菜單編輯，它們各自存自己的 localStorage
  var id = (e.target && e.target.id) || '';
  if (id === 'notepad-text' || id === 'stats-date' || id === 'stat-opening-cash') return;
  adminEdited = true;
}

/* ── 跟 GAS 對齊的小工具 ──
   同一個儲存格在 Menu.gs 和這裡必須被判成同一個值，否則後台顯示的
   會跟前台看到的不一樣。這幾支是 menuToBool / menuBlankToNull /
   menuNumber / menuSiteMatch / menuBySortOrder 的前端版本。 */
function sheetBool(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  var s = String(value).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'y' || s === '1' || s === 'v';
}

function sheetText(value) {
  var s = String(value == null ? '' : value).trim();
  return s === '' ? null : s;
}

function sheetNumber(value) {
  var n = Number(value);
  return isNaN(n) ? 0 : n;
}

// 空白 / both 一律視為兩站共用
function sheetSiteMatch(value) {
  var s = String(value == null ? '' : value).trim();
  return s === '' || s === 'both' || s === ADMIN_SITE;
}

function bySheetSortOrder(a, b) {
  return sheetNumber(a.sortOrder) - sheetNumber(b.sortOrder);
}

/* ── 讀取 ── */

// 菜單 API 與訂單 API 是同一個 Apps Script 部署（同一個 /exec 網址）。
// loadState() 已經把 localStorage 與 config.js 合併好了，直接讀 state 就好。
function adminMenuEndpoint() {
  var ld = state.landingData || {};
  return ld.menuEndpoint || ld.orderEndpoint || null;
}

function refreshStateFromSheets() {
  if (typeof fetch !== 'function') return;

  var base = adminMenuEndpoint();
  if (!base) {
    console.warn('[admin] 找不到 API 網址，沿用 config.js / localStorage 的資料');
    return;
  }

  var url = base + (base.indexOf('?') >= 0 ? '&' : '?') + 'action=menuRaw';

  fetch(url, { cache: 'no-store' })
    .then(function (res) { return res.json(); })
    .then(function (raw) {
      // 工作表還沒建好、或 Apps Script 還沒重新部署時，?action=menuRaw 會落到
      // 預設的 "Kigo order API is running." 那則訊息 —— 那不是菜單資料，不能用。
      if (!raw || raw.ok === false || !Array.isArray(raw.items) || !Array.isArray(raw.categories)) {
        console.warn('[admin] menuRaw 沒有可用的菜單資料，沿用本機資料',
          (raw && (raw.error || raw.message)) || '');
        return;
      }

      if (adminEdited) {
        console.warn('[admin] 後台已有未儲存的編輯，這次不套用 Sheets 資料。' +
          '要載入最新內容請重新整理頁面。');
        return;
      }

      applyMenuRaw(raw);
      repaintAdminMenuUI();

      console.log('[admin] 已改用 Sheets 資料：商品 ' + state.raw.items.length +
        ' 筆 / 分類連結 ' + state.raw.itemCategories.length +
        ' 筆 / 分類 ' + state.raw.categories.length +
        ' 個 / 設定 ' + state.raw.settings.length +
        ' 筆 / Banner ' + state.raw.banners.length + ' 筆');
    })
    .catch(function (err) {
      console.warn('[admin] 讀取 menuRaw 失敗，沿用 config.js / localStorage 的資料', err);
    });
}

function applyMenuRaw(raw) {
  // ① 原始列整份留著 —— 之後寫回 Sheets 全靠這裡才知道要更新哪一列
  state.raw = {
    site:           ADMIN_SITE,
    generatedAt:    raw.generatedAt || null,
    imageBase:      raw.imageBase || '',
    headers:        raw.headers || {},
    items:          raw.items || [],
    itemCategories: raw.itemCategories || [],
    categories:     raw.categories || [],
    settings:       raw.settings || [],
    banners:        raw.banners || []
  };

  // ② 顯示用轉換
  var itemsById = {};
  state.raw.items.forEach(function (row) {
    var id = sheetText(row.id);
    if (id) itemsById[id] = row;
  });

  // 後台要看得到全部的列（含下架的），所以這裡不照 active / site 過濾 ——
  // 那是 action=menu 給前台用的規則。後台少顯示一列，之後寫回就會誤刪。
  var categories = state.raw.categories.filter(function (row) {
    return sheetText(row.key);
  }).slice().sort(bySheetSortOrder);

  var linksByCategory = {};
  state.raw.itemCategories.forEach(function (row) {
    var key = sheetText(row.categoryKey);
    var itemId = sheetText(row.itemId);
    // 指向不存在商品的連結列略過，否則畫面上會出現空白卡片
    if (!key || !itemId || !itemsById[itemId]) return;
    if (!linksByCategory[key]) linksByCategory[key] = [];
    linksByCategory[key].push(row);
  });

  var nextMenuData = {};
  var nextTabs = [];
  var nextSectionTitles = {};

  categories.forEach(function (cat) {
    var key = sheetText(cat.key);
    var links = (linksByCategory[key] || []).slice().sort(bySheetSortOrder);

    nextMenuData[key] = links.map(function (link) {
      return displayItem(itemsById[sheetText(link.itemId)], link);
    });
    nextTabs.push({ key: key, label: sheetText(cat.label) || key });
    nextSectionTitles[key] = { en: sheetText(cat.titleEn), jp: sheetText(cat.titleJp) };
  });

  state.menuData      = nextMenuData;
  state.tabs          = nextTabs;
  state.sectionTitles = nextSectionTitles;

  // ③ landingData 是「疊上去」而不是整份換掉。
  //    Settings 工作表刻意沒有 orderEndpoint 這一列，所以它不會出現在
  //    landingFromSheets() 的結果裡，訂單 API 網址因此不會被動到。
  //    只覆寫工作表真的有的 key —— 包含刻意留白的（null 代表「這一項不顯示」）。
  var fromSheets = landingFromSheets();
  Object.keys(fromSheets).forEach(function (k) {
    state.landingData[k] = fromSheets[k];
  });
}

// 欄位名沿用後台既有的（name / nameJp / desc / price / tag / image / temp / soldOut），
// admin-menu.js 因此完全不用改。id 與原始列的對照資訊掛在後面 ——
// 現有 UI 不會顯示它們，匯出 config.js 也不會帶到（renderItem 只挑固定幾個 key）。
function displayItem(itemRow, linkRow) {
  var priceNumber = Number(itemRow.price);
  if (isNaN(priceNumber)) priceNumber = null;
  var priceText = sheetText(itemRow.priceText);

  return {
    name:    sheetText(itemRow.name),
    // 試算表的欄位叫 subtitle，後台既有的欄位名是 nameJp，這裡沿用後台的
    nameJp:  sheetText(itemRow.subtitle),
    desc:    sheetText(itemRow.desc),
    // 後台的價格欄是純文字，對應 Items 的 price(數字) + priceText 兩欄
    price:   priceText || (priceNumber === null ? null : 'NT$' + priceNumber),
    tag:     sheetText(itemRow.tag),
    // 顯示儲存格的原始值（可能只是檔名）。補上 imageBase 前綴是 GAS 給前台做的事，
    // 後台要編輯的是儲存格內容本身。
    image:   sheetText(itemRow.image),
    emoji:   null,
    temp:    sheetText(itemRow.temp),
    soldOut: sheetBool(itemRow.soldOut),

    /* ── 以下為 raw 對照用，現有 UI 都還沒有對應欄位 ── */
    id:              sheetText(itemRow.id),
    itemActive:      sheetBool(itemRow.active),
    priceValue:      priceNumber,
    priceTextRaw:    priceText,
    linkCategoryKey: sheetText(linkRow.categoryKey),
    linkSortOrder:   sheetNumber(linkRow.sortOrder),
    linkActive:      sheetBool(linkRow.active)
  };
}

// 跟 Menu.gs 的 buildLandingData() 同一套規則：
// scope=both 先套一輪，再讓 scope=orderWeb 覆蓋上去。
// scope=menuWeb 的列完全不碰 —— 那是 menuWeb 專屬設定，orderWeb 後台唯讀。
function landingFromSheets() {
  var out = {};

  ['both', ADMIN_SITE].forEach(function (wanted) {
    state.raw.settings.forEach(function (row) {
      var key = sheetText(row.key);
      if (!key) return;
      var scope = sheetText(row.scope) || 'both';
      if (scope !== wanted) return;
      out[key] = settingValueOf(row);
    });
  });

  // bannerImages 不是 Settings 的某一列，是 Banners 整張表算出來的。
  // 這裡照前台的規則過濾（active + 這一站），後台的輪播欄才會跟首頁一致；
  // 完整的六個欄位留在 state.raw.banners，等第 03 步做 Banner 編輯 UI 才用得到。
  out.bannerImages = state.raw.banners.filter(function (row) {
    return sheetBool(row.active) && sheetSiteMatch(row.site) && sheetText(row.image);
  }).slice().sort(bySheetSortOrder).map(function (row) {
    return sheetText(row.image);
  });

  return out;
}

// 對應 Menu.gs 的 settingValue()
function settingValueOf(row) {
  var type = String(row.type == null ? '' : row.type).trim().toLowerCase() || 'text';
  var raw = row.value;

  if (type === 'boolean') return sheetBool(raw);
  if (type === 'number') {
    var n = Number(raw);
    return isNaN(n) ? null : n;
  }
  if (type === 'list') {
    return String(raw == null ? '' : raw).split(/\r?\n/).map(function (s) {
      return String(s).trim();
    }).filter(function (s) {
      return s !== '';
    });
  }
  return sheetText(raw);
}

// 遠端資料到了之後把菜單相關的 UI 重畫一次。
// 訂單與統計那兩塊刻意不動 —— 它們不吃 state.menuData，
// 重畫只會打斷訂單輪詢，而且那是這一步明確不該碰的範圍。
function repaintAdminMenuUI() {
  if (typeof populateLanding === 'function')          populateLanding();
  if (typeof buildCatTabs === 'function')             buildCatTabs();
  if (typeof buildTabsEditor === 'function')          buildTabsEditor();
  if (typeof buildSectionTitlesEditor === 'function') buildSectionTitlesEditor();
}
