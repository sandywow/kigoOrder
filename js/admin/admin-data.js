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

  // 同步到 Sheets 是額外的一步：它自己處理所有錯誤，上面三行的行為完全不變
  pushMenuToSheets();
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

   ⚠ 寫回試算表在下面的「Google Sheets 寫入層」，
     它就是靠 state.raw 才知道要更新哪一列、以及哪些欄位要原封保留。
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

/* ── 海報圖片的路徑格式 ──

   後台的「輪播圖片網址」欄從以前就是填相對路徑（config.js 的預設值與
   admin.html 的 placeholder 都是 src/BANNER FISH-03.jpg），不是完整網址。

   但 Banners 工作表的儲存格存的是 Menu.gs 的 menuResolveImage 看得懂的值：
     · 完整網址（http / data:）→ 原樣輸出
     · 其他 → encodeURI(MENU_IMAGE_BASE + 值)

   ⚠ MENU_IMAGE_BASE 是 'https://sandywow.github.io/kigoMenu/src/' —— 它自己
     已經以 src/ 結尾。所以儲存格裡的相對寫法是「檔名」，不是「src/檔名」；
     把 src/ 也寫進去會變成 .../kigoMenu/src/src/xxx.jpg（兩個站都 404）。

   所以後台顯示與儲存格之間要換算：
     儲存格 'BANNER FISH-03.jpg'                     ↔ 後台 'src/BANNER FISH-03.jpg'
     儲存格 'https://…/kigoMenu/src/BANNER%20FISH-03.jpg' ↔ 後台 'src/BANNER FISH-03.jpg'
     儲存格 'https://其他網站/x.jpg'（不在 imageBase 底下）↔ 後台原樣顯示、原樣存回

   前台完全不受影響：它拿到的是 GAS 用 imageBase 組好的完整網址。 */

var BANNER_PATH_PREFIX = 'src/';

function isAbsoluteImagePath(value) {
  return /^(https?:)?\/\//i.test(value) || value.indexOf('data:') === 0;
}

// 儲存格的值 → 後台欄位看到的相對路徑
function bannerDisplayPath(value) {
  var raw = String(value == null ? '' : value).trim().replace(/\\/g, '/');
  if (!raw) return '';

  var base = (state.raw && state.raw.imageBase) || '';
  if (base && raw.indexOf(base) === 0) {
    // imageBase 底下的圖 → 還原成 src/檔名（順便把 %20 解回空白）
    return BANNER_PATH_PREFIX + decodeImagePath(raw.substring(base.length));
  }
  // 別的網站的圖沒辦法縮短，原樣顯示
  if (isAbsoluteImagePath(raw)) return raw;

  raw = raw.replace(/^\/+/, '');
  return (/^src\//i.test(raw)) ? raw : BANNER_PATH_PREFIX + raw;
}

// 後台欄位的值 → 要寫進儲存格的值
function bannerSheetPath(display) {
  var raw = String(display == null ? '' : display).trim().replace(/\\/g, '/');
  if (!raw) return '';

  // 使用者自己貼的完整網址就原樣存，menuResolveImage 會原樣輸出
  if (isAbsoluteImagePath(raw)) return raw;

  raw = raw.replace(/^\/+/, '');
  // imageBase 已經以 src/ 結尾，儲存格只放檔名
  if (/^src\//i.test(raw)) raw = raw.substring(BANNER_PATH_PREFIX.length);
  return raw;
}

// 兩個值講的是不是同一張圖：都換算成儲存格的寫法再比
function bannerImageKey(value) {
  return bannerSheetPath(bannerDisplayPath(value));
}

// 舊資料是 encodeURI 過的（空白變 %20）。decodeURI 遇到壞字串會丟例外，
// 這種時候原樣用就好，不要讓後台整個炸掉。
function decodeImagePath(value) {
  try {
    return decodeURI(value);
  } catch (e) {
    return value;
  }
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
  // 完整的六個欄位留在 state.raw.banners，寫回 Sheets 時才有得對照。
  out.bannerImages = state.raw.banners.filter(function (row) {
    return sheetBool(row.active) && sheetSiteMatch(row.site) && sheetText(row.image);
  }).slice().sort(bySheetSortOrder).map(function (row) {
    // 後台欄位一律顯示「src/檔名」，不是儲存格裡那串完整網址
    return bannerDisplayPath(row.image);
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


/* ═══════════════════════════════════════════════════════════
   Google Sheets 寫入層（action=saveMenu）

   saveConfig() 寫完 localStorage 之後，額外把目前的菜單送回試算表。
   這一段的每一個錯誤都自己吞掉（toast + console），saveConfig() 原本的
   三行行為完全不受影響 —— 網路斷線、API 沒部署、資料有問題，
   後台都還是照舊存進 localStorage 並顯示「已儲存」。

   做法是「patch raw rows」而不是「從 UI 重建整張表」：
   state.raw 是 menuRaw 讀回來的原始列，UI 只顯示其中一部分欄位
   （note / active / showTemp / site / updatedAt 後台根本沒有欄位），
   從 UI 重建會把那些欄位洗成空白。所以一律複製 raw 那一列，
   只覆寫使用者真的能編輯的欄位。

   ⚠ 送出的是完整 snapshot：GAS 端「試算表有、payload 沒有的 key」
     會被刪除，所以每一張表都必須包含它全部的列。後台看不到的列
     （下架的商品、menuWeb 專屬的設定與海報）也一定要原封送回去。
   ═══════════════════════════════════════════════════════════ */

var MENU_PUSH_TABLES = ['items', 'itemCategories', 'categories', 'settings', 'banners'];

// GAS 的 Settings 黑名單（MENU_WRITE_SETTING_KEY_BLOCKLIST）。
// 前台送單／取菜單的網址留在各站的 config.js 管理，不可以寫進 Settings。
var MENU_PUSH_BLOCKED_SETTING_KEYS = ['orderEndpoint', 'menuEndpoint'];

// landingData 有、但不是 Settings 某一列的 key。
// bannerImages 是 Banners 整張表算出來的（見 landingFromSheets），
// 它寫回的對象是 Banners，不是 Settings（見 buildBannersTable）。
var MENU_PUSH_NON_SETTING_KEYS = ['bannerImages'];

// GAS 的 MENU_WRITE_ID_RE。新商品與新海報的 id 必須在這裡就合法，
// 不然整份 payload 會被退回。
var MENU_PUSH_ID_RE = /^[A-Za-z0-9_.\-]{1,40}$/;

// menuRaw 會一起回傳 headers，正常情況下用它的；
// 萬一舊版 GAS 沒帶，就退回這份寫死的（欄位順序與 Menu.gs 一致）。
var MENU_PUSH_HEADERS_FALLBACK = {
  items:          ['id', 'name', 'subtitle', 'desc', 'price', 'priceText',
                   'image', 'tag', 'temp', 'soldOut', 'active', 'note', 'updatedAt'],
  itemCategories: ['itemId', 'categoryKey', 'sortOrder', 'active'],
  categories:     ['key', 'label', 'titleEn', 'titleJp', 'sortOrder',
                   'showTemp', 'active', 'site'],
  settings:       ['key', 'value', 'scope', 'type', 'note']
};

function pushHeaders(name) {
  var h = state.raw && state.raw.headers && state.raw.headers[name];
  return (Array.isArray(h) && h.length) ? h : MENU_PUSH_HEADERS_FALLBACK[name];
}

function blankRow(headers) {
  var row = {};
  headers.forEach(function (h) { row[h] = ''; });
  return row;
}



/* ── 菜單寫入 Token ──

   GAS 那邊的 saveMenu 要求每一次請求都帶 token，對不上就在讀寫任何儲存格
   之前直接拒絕（menuWriteAuthorize）。這裡負責「這台裝置用哪一個 token」。

   ⚠ Token 絕對不寫進這份檔案、也不進 state / landingData ——
     這個 repo 是公開的，而 landingData 會被「複製 config.js」原樣匯出。
     它只存在這台電腦的 localStorage（自己一把 key），第一次儲存時用
     prompt 問一次，之後就不會再問。

   換裝置、換瀏覽器就再輸入一次。要手動設定或清掉，在後台的 Console：
     setMenuWriteToken('貼上 token')
     clearMenuWriteToken()                                             */

var MENU_WRITE_TOKEN_KEY = 'kigoMenuWriteToken';

function menuWriteTokenValue() {
  try {
    return String(localStorage.getItem(MENU_WRITE_TOKEN_KEY) || '').trim();
  } catch (e) {
    // 無痕模式之類的環境會直接丟例外
    return '';
  }
}

function setMenuWriteToken(token) {
  var value = String(token == null ? '' : token).trim();
  if (!value) return clearMenuWriteToken();
  try {
    localStorage.setItem(MENU_WRITE_TOKEN_KEY, value);
    showToast('菜單寫入 Token 已存在這台裝置');
  } catch (e) {
    console.error('[admin] 無法儲存 Token', e);
    showToast('這個瀏覽器不讓我儲存 Token');
  }
  return value;
}

function clearMenuWriteToken() {
  try {
    localStorage.removeItem(MENU_WRITE_TOKEN_KEY);
  } catch (e) { /* 沒存成功過就不用清 */ }
  return '';
}

// 只在還沒有 token 的時候問一次。按取消就回空字串，這一輪不送出。
function askMenuWriteToken() {
  if (typeof window === 'undefined' || typeof window.prompt !== 'function') return '';
  var entered = window.prompt(
    '請輸入菜單寫入 Token（Apps Script 專案屬性 MENU_WRITE_TOKEN 的值）。\n' +
    '只會問這一次，之後存在這台裝置的瀏覽器裡。');
  if (entered === null) return '';
  return setMenuWriteToken(entered);
}

/* ── 進入點 ── */

function pushMenuToSheets() {
  try {
    // state.raw 只有在 menuRaw 回來之後才存在（loadState 從 localStorage
    // 還原時刻意不還原它）。沒有它就沒有完整 snapshot，寧可不送。
    if (!state.raw || !Array.isArray(state.raw.items) || !Array.isArray(state.raw.categories)) {
      showToast('菜單資料尚未同步完成，請稍後再儲存');
      return;
    }

    var endpoint = adminMenuEndpoint();
    if (!endpoint) {
      showToast('找不到菜單 API 網址，這次沒有同步到 Sheets');
      return;
    }

    // Token 在 endpoint 之後、組 payload 之前就要拿到 ——
    // 拿不到就整段不做，連新商品的 id 都不會發（下次再一起處理）。
    var token = menuWriteTokenValue() || askMenuWriteToken();
    if (!token) {
      showToast('沒有菜單寫入 Token，這次沒有同步到 Sheets');
      return;
    }

    var built = buildMenuTablesFromState();

    built.warnings.forEach(function (w) { console.warn('[admin] ' + w); });

    if (built.errors.length) {
      console.error('[admin] 菜單無法送出：', built.errors);
      showToast('菜單無法送出：' + built.errors[0]);
      return;
    }

    // 新商品是在上面那一步才拿到 id 的。localStorage 已經在 saveConfig()
    // 寫過一次（那時候還沒有 id），這裡補寫一次 —— 否則重新整理之後
    // 這些商品又會變成「沒有 id」，下次儲存就會在試算表再新增一筆。
    if (built.newIds.length) {
      localStorage.setItem('kigoMenuConfig', JSON.stringify(state));
      console.log('[admin] 新商品取得 id：' + built.newIds.join('、'));
    }

    apiSaveMenu(endpoint, token, built.tables);
  } catch (err) {
    // 最後一道：絕對不讓例外往上丟回 saveConfig()
    console.error('[admin] pushMenuToSheets 發生例外', err);
    showToast('菜單同步失敗，詳見 Console');
  }
}

// 跟 apiPostOrder 一樣用 text/plain：Apps Script 沒有處理 CORS 預檢(OPTIONS)，
// 用 application/json 會觸發預檢而直接失敗。
function apiSaveMenu(endpoint, token, tables) {
  if (typeof fetch !== 'function') {
    showToast('這個瀏覽器不支援同步到 Sheets');
    return;
  }

  // 商品陣列包在 tables 裡面（不是頂層的 items）是 GAS 那邊刻意的設計：
  // 萬一 /exec 還是舊版、沒有 saveMenu 這條路由，請求會落到「建立訂單」的
  // fallback，而它讀的是 payload.items —— 包一層之後那裡永遠是 undefined，
  // 只會拿到「order has no items」，菜單資料不會被寫進 Orders。
  var body = { action: 'saveMenu', site: ADMIN_SITE, token: token, tables: tables };

  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body)
  })
    .then(function (res) { return res.json(); })
    .then(function (data) { reportSaveMenuResult(data); })
    .catch(function (err) {
      console.error('[admin] saveMenu 失敗', err);
      showToast('菜單同步失敗，詳見 Console');
    });
}

function reportSaveMenuResult(data) {
  if (!data || typeof data !== 'object') {
    console.error('[admin] saveMenu 回應格式不對', data);
    showToast('菜單同步失敗：回應格式不對');
    return;
  }

  if (data.ok === false) {
    var errors = data.errors || (data.error ? [String(data.error)] : []);
    console.error('[admin] saveMenu 被拒絕', data);
    // GAS 還沒重新部署時沒有 saveMenu 這條路由，請求會落到建立訂單的 fallback
    if (errors.join(' ').indexOf('order has no items') >= 0) {
      showToast('菜單 API 尚未部署新版（GAS 還是舊版），這次沒有寫入');
      return;
    }
    // Token 沒帶或不對。存在這台裝置的那一份已經沒用了，清掉讓下次儲存重問，
    // 免得一直用同一個錯的值重試。
    if (data.error === 'unauthorized') {
      clearMenuWriteToken();
      showToast('菜單寫入 Token 不正確，已清除；下次儲存會再問一次');
      return;
    }
    if (data.error === 'token not configured') {
      showToast('Apps Script 還沒設定菜單寫入 Token（詳見 Console）');
      return;
    }
    showToast('菜單同步失敗：' + (errors[0] || '未知錯誤'));
    return;
  }

  var sum = { updated: 0, added: 0, deleted: 0, skipped: 0, unchanged: 0 };
  Object.keys(data.written || {}).forEach(function (name) {
    Object.keys(sum).forEach(function (k) { sum[k] += (data.written[name][k] || 0); });
  });

  console.log('[admin] saveMenu 結果', data);
  (data.warnings || []).forEach(function (w) { console.warn('[admin] GAS：' + w); });
  (data.plan || []).forEach(function (e) {
    console.log('[admin] · ' + e.op + ' ' + e.table + ' [' + e.key + ']' +
      (e.row ? ' row=' + e.row : '') + (e.reason ? ' ← ' + e.reason : ''));
  });

  var counts = '更新 ' + sum.updated + '／新增 ' + sum.added + '／刪除 ' + sum.deleted +
    (sum.skipped ? '／略過 ' + sum.skipped : '');

  // GAS 端的 MENU_WRITE_ENABLED 還是 false 時只會算計畫、不寫任何 cell
  showToast(data.dryRun
    ? '菜單已送出（GAS 目前是預演模式，未實際寫入）：' + counts
    : '菜單已寫入 Sheets：' + counts);
}


/* ── 組 payload ── */

function buildMenuTablesFromState() {
  var out = { tables: {}, errors: [], warnings: [], newIds: [] };
  var raw = state.raw;

  var items = buildItemsTable(raw, out);
  var links = buildItemCategoriesTable(raw, items.byId, out);

  var tables = {
    items:          items.rows,
    itemCategories: links.rows,
    categories:     buildCategoriesTable(raw, out),
    settings:       buildSettingsTable(raw, out),
    banners:        buildBannersTable(raw, out)
  };

  // 後台的「移除」移除的是分類連結，Items 那一列會留著 ——
  // 它可能還掛在別的分類，而且 Items 表裡本來就可能有還沒上架的列。
  Object.keys(items.byId).forEach(function (id) {
    if (!links.linkedItemIds[id]) {
      out.warnings.push('商品 ' + id + ' 目前不在任何分類裡，前台不會顯示它，' +
        '但 Items 工作表仍會保留這一列');
    }
  });

  // Banners 整張表都空了：GAS 不接受空陣列，但為了這個極端狀況把整次儲存
  // 擋掉太超過（其他四張表是好的）。拿掉這個 key，那張工作表這一輪就完全不動。
  if (!tables.banners.length) {
    delete tables.banners;
    out.warnings.push('Banners 這一輪沒有任何列可以送（API 不接受清空整張表），' +
      'Banners 工作表維持原樣；真的要清空請直接在試算表操作');
  }

  // GAS 不接受空陣列（分不出「真的要清空整張表」還是「前端出 bug」），
  // 在這裡就擋下來，才不會送出一份注定被整批退回的 payload
  MENU_PUSH_TABLES.forEach(function (name) {
    if (name === 'banners') return;            // 上面已經處理過
    if (!tables[name] || !tables[name].length) {
      out.errors.push(name + ' 沒有任何資料，這次不送出');
    }
  });

  out.tables = tables;
  return out;
}

/* Items —— 複製 raw 那一列，只覆寫後台編輯得到的欄位。
   active / note / updatedAt 後台沒有欄位，一律沿用原值。 */
function buildItemsTable(raw, out) {
  var headers  = pushHeaders('items');
  var original = {};   // id → 試算表原值（判斷某一份 copy 有沒有被改過）
  var byId     = {};   // id → 要送出的列
  var order    = [];   // 維持試算表原本的列序
  var edited   = {};   // id → 已經套用過「被改過的那一份 copy」

  raw.items.forEach(function (row, i) {
    var id = sheetText(row.id);
    if (!id) {
      out.errors.push('Items 第 ' + (i + 1) + ' 筆沒有 id，請先到試算表補上再儲存');
      return;
    }
    if (byId[id]) {
      out.errors.push('Items 有重複的 id：' + id + '，請先到試算表處理');
      return;
    }
    original[id] = deepClone(row);
    byId[id]     = deepClone(row);
    order.push(id);
  });

  Object.keys(state.menuData || {}).forEach(function (catKey) {
    (state.menuData[catKey] || []).forEach(function (item) {
      var id = sheetText(item.id);

      // 「＋ 新增品項」加出來的沒有 id。發一個新的並寫回 state，
      // 下一次儲存才會認得它是同一筆、而不是再新增一個。
      if (!id) {
        id = nextItemId(byId);
        item.id      = id;
        byId[id]     = newItemRow(headers, id);
        original[id] = null;
        order.push(id);
        out.newIds.push(id);
      }

      if (!byId[id]) {
        // 畫面上這一筆帶著 Items 快照裡沒有的 id：多半是上一次儲存剛發出去的新商品
        // （state.raw 要重新整理才會更新），也可能是有人直接在試算表刪掉了那一列。
        // 兩種情況都當成「要有這一列」把它補回去 —— 絕對不能略過：
        // 略過等於 snapshot 少一列，GAS 會把試算表上的那一列刪掉。
        // GAS 是用 id 比對的，試算表已經有同一個 id 就會變成更新而不是新增。
        out.warnings.push('商品 ' + id + ' 不在 Items 快照裡（重新整理頁面就會同步），' +
          '這次以新增的一列送出');
        byId[id]     = newItemRow(headers, id);
        original[id] = null;
        order.push(id);
      }

      var patched = patchItemRow(byId[id], item);

      // 同一個商品掛在多個分類時，畫面上是各自獨立的多份 copy，
      // 改了其中一份不會同步到另一份。所以只讓「真的被改過的那一份」勝出，
      // 免得另一個分類的舊值把剛改好的內容蓋回去。
      var changed = original[id] ? !sameRow(headers, patched, original[id]) : true;
      if (changed && edited[id]) {
        out.warnings.push('商品 ' + id + ' 在多個分類裡都被修改過，以最後一個分類的內容為準');
      }
      if (changed || !edited[id]) byId[id] = patched;
      if (changed) edited[id] = true;
    });
  });

  return {
    byId: byId,
    rows: order.map(function (id) { return byId[id]; }).filter(Boolean)
  };
}

function newItemRow(headers, id) {
  var row = blankRow(headers);
  row.id      = id;
  row.active  = true;    // 新商品預設上架
  row.soldOut = false;
  return row;
}

// 後台編輯得到的欄位才覆寫，其他欄位保留 raw 原值
function patchItemRow(row, item) {
  var next  = deepClone(row);
  var price = splitPrice(item.price);

  next.name      = ve(item.name);
  next.subtitle  = ve(item.nameJp);     // 後台叫 nameJp，試算表的欄位是 subtitle
  next.desc      = ve(item.desc);
  next.price     = price.number;
  next.priceText = price.text;
  next.image     = ve(item.image);
  next.tag       = ve(item.tag);
  next.temp      = ve(item.temp);
  next.soldOut   = !!item.soldOut;
  return next;
}

// 後台的價格是一個純文字欄（displayItem 是 priceText || 'NT$' + price 組出來的），
// 寫回去要拆成 price(數字) + priceText(文字) 兩欄。
// 「NT$150」「150」→ price=150；「時價」「兩杯 NT$180」→ 整串放 priceText。
function splitPrice(display) {
  var s = String(display == null ? '' : display).trim();
  if (s === '') return { number: '', text: '' };

  var m = s.match(/^NT\$\s*(\d+(?:\.\d+)?)$/i) || s.match(/^(\d+(?:\.\d+)?)$/);
  if (m) return { number: Number(m[1]), text: '' };

  return { number: '', text: s };
}

// 兩列算不算同一份內容。判斷方式要跟 GAS 的 menuWriteCellEquals 一致 ——
// 勾選框的 true 與文字 "TRUE"、數字 150 與文字 "150" 都算相同。
function sameRow(headers, a, b) {
  for (var i = 0; i < headers.length; i++) {
    var h = headers[i];
    var x = a[h];
    var y = b[h];
    if (typeof x === 'boolean' || typeof y === 'boolean') {
      if (sheetBool(x) !== sheetBool(y)) return false;
      continue;
    }
    if (String(x == null ? '' : x).trim() !== String(y == null ? '' : y).trim()) return false;
  }
  return true;
}

// 新商品的 id。沿用試算表現有的 ITM-000 命名，並確認沒有撞號。
function nextItemId(byId) {
  var max = 0;
  Object.keys(byId).forEach(function (id) {
    var m = String(id).match(/^ITM-(\d+)$/i);
    if (m) {
      var n = parseInt(m[1], 10);
      if (!isNaN(n) && n > max) max = n;
    }
  });

  var id;
  do {
    max++;
    id = 'ITM-' + String(max + 1000).substring(1);   // 001 / 024 / 137
  } while (byId[id] || !MENU_PUSH_ID_RE.test(id));

  return id;
}

/* ItemCategories —— 這張表就是「畫面上的分類 × 排序」，所以照 state.menuData
   重新產生；但每一列仍然是從 raw 原列複製出來的，沒有被覆寫的欄位
   （目前是 active）維持原值。 */
function buildItemCategoriesTable(raw, itemsById, out) {
  var headers  = pushHeaders('itemCategories');
  var rawByKey = {};

  raw.itemCategories.forEach(function (row, i) {
    var itemId = sheetText(row.itemId);
    var catKey = sheetText(row.categoryKey);
    if (!itemId || !catKey) {
      out.warnings.push('ItemCategories 第 ' + (i + 1) + ' 筆的 itemId／categoryKey 是空的，' +
        '這次儲存會把它從試算表刪除');
      return;
    }
    rawByKey[itemId + '|' + catKey] = deepClone(row);
  });

  var rows          = [];
  var produced      = {};
  var linkedItemIds = {};

  Object.keys(state.menuData || {}).forEach(function (catKey) {
    var list = (state.menuData[catKey] || []).filter(function (item) {
      var id = sheetText(item.id);
      return id && itemsById[id];
    });

    // 排序沒被動過就沿用原本的 sortOrder（10 / 20 / 30 這種留白編號要留著），
    // 一旦順序變了就整個分類重新編 1..n
    var keepOrder = keepsExistingOrder(list);

    list.forEach(function (item, idx) {
      var id   = sheetText(item.id);
      var k    = id + '|' + catKey;
      var prev = rawByKey[k];
      var row  = prev ? deepClone(prev) : blankRow(headers);

      row.itemId      = id;
      row.categoryKey = catKey;
      row.sortOrder   = keepOrder ? sheetNumber(item.linkSortOrder) : (idx + 1);
      if (!prev) row.active = true;    // 新連結預設上架；既有的沿用原值

      rows.push(row);
      produced[k]       = true;
      linkedItemIds[id] = true;
    });
  });

  // 畫面上沒有的連結 = 這次會被刪掉。刪除是預期行為（後台的「移除」就是這樣），
  // 但要讓它看得見，不要默默發生。
  Object.keys(rawByKey).forEach(function (k) {
    if (!produced[k]) {
      out.warnings.push('分類連結 ' + k.split('|').join(' → ') +
        ' 不在目前畫面上，這次儲存會把它從試算表刪除');
    }
  });

  return { rows: rows, linkedItemIds: linkedItemIds };
}

// 每一筆都有 sortOrder 而且嚴格遞增 → 順序沒被動過
function keepsExistingOrder(list) {
  var last = null;
  for (var i = 0; i < list.length; i++) {
    var v = list[i].linkSortOrder;
    if (v === undefined || v === null || v === '' || isNaN(Number(v))) return false;
    var n = Number(v);
    if (last !== null && n <= last) return false;
    last = n;
  }
  return true;
}

/* Categories —— 後台只編輯得到 label（分頁編輯器）與 titleEn / titleJp
   （區塊標題編輯器）。key 是唯讀的，sortOrder / showTemp / active / site
   後台沒有欄位，一律沿用原值。 */
function buildCategoriesTable(raw, out) {
  var labelByKey = {};
  (state.tabs || []).forEach(function (tab) {
    var k = sheetText(tab.key);
    if (k) labelByKey[k] = tab.label;
  });

  var rows = [];
  raw.categories.forEach(function (row, i) {
    var key = sheetText(row.key);
    if (!key) {
      out.errors.push('Categories 第 ' + (i + 1) + ' 筆沒有 key，請先到試算表補上再儲存');
      return;
    }

    var next = deepClone(row);
    if (Object.prototype.hasOwnProperty.call(labelByKey, key)) {
      next.label = ve(labelByKey[key]);
    }
    var title = (state.sectionTitles || {})[key];
    if (title) {
      next.titleEn = ve(title.en);
      next.titleJp = ve(title.jp);
    }
    rows.push(next);
  });

  return rows;
}

/* Settings —— 整張表原封送回，只把後台真的編輯得到的那幾個 key
   寫回「原本那一列」。

   前台看到的值是 buildLandingData 的結果：scope=both 先套一輪，
   再讓 scope=orderWeb 覆蓋上去。所以要寫回的是 orderWeb 那一列；
   只有在沒有 orderWeb 那一列時才寫 both（那一列 menuWeb 也吃得到，
   等於兩站一起改）。scope=menuWeb 的列原封不動送回去 ——
   GAS 那邊也是唯讀，會回報 unchanged／skipped。 */
function buildSettingsTable(raw, out) {
  var rows      = [];
  var targetIdx = {};   // key → 要被覆寫的那一列在 rows 裡的位置

  raw.settings.forEach(function (row, i) {
    var key = sheetText(row.key);
    if (!key) {
      out.errors.push('Settings 第 ' + (i + 1) + ' 筆沒有 key，請先到試算表補上再儲存');
      return;
    }
    if (MENU_PUSH_BLOCKED_SETTING_KEYS.indexOf(key) >= 0) {
      // 這種列 GAS 一定會退回整份 payload。與其把它從 snapshot 拿掉
      // （那等於要求刪除它），不如直接中止並說清楚。
      out.errors.push('Settings 工作表裡有 ' + key + ' 這一列，API 不接受它' +
        '（送單／取菜單網址請留在 config.js），請先到試算表刪掉');
      return;
    }

    var scope = sheetText(row.scope) || 'both';
    rows.push(deepClone(row));

    if (scope === ADMIN_SITE) {
      targetIdx[key] = rows.length - 1;
    } else if (scope === 'both' && targetIdx[key] === undefined) {
      targetIdx[key] = rows.length - 1;
    }
    // scope === 'menuWeb' → 原封送回，不當作寫回目標
  });

  var landing = state.landingData || {};
  Object.keys(landing).forEach(function (key) {
    if (MENU_PUSH_BLOCKED_SETTING_KEYS.indexOf(key) >= 0) return;   // orderEndpoint 絕不送出
    if (MENU_PUSH_NON_SETTING_KEYS.indexOf(key) >= 0) return;       // bannerImages 屬於 Banners

    var idx = targetIdx[key];
    // Settings 沒有這一列就不新增 —— type 無從判斷，猜錯會讓前台讀到錯的型別。
    // 這種 key 目前只會出現在 config.js 的預設值裡（例如 bannerAlt）。
    if (idx === undefined) return;

    rows[idx].value = settingCellValue(rows[idx].type, landing[key]);
  });

  return rows;
}

// 依那一列的 type 把 landingData 的值轉回「儲存格該有的樣子」，
// 對應 Menu.gs 的 settingValue() 的反向操作。
function settingCellValue(type, value) {
  var t = String(type == null ? '' : type).trim().toLowerCase() || 'text';

  if (t === 'boolean') {
    return typeof value === 'boolean' ? value : sheetBool(value);
  }
  if (t === 'number') {
    if (value === null || value === undefined || String(value).trim() === '') return '';
    var n = Number(value);
    return isNaN(n) ? '' : n;
  }
  if (t === 'list') {
    // GAS 收到陣列會自己接成「一行一個」的多行字串
    if (Array.isArray(value)) {
      return value.map(function (v) { return String(v == null ? '' : v).trim(); })
        .filter(function (v) { return v !== ''; });
    }
    return String(value == null ? '' : value).split(/\r?\n/).map(function (s) {
      return s.trim();
    }).filter(function (s) { return s !== ''; });
  }
  // text：空白代表「這一項不顯示」，寫空字串回去（不能寫 null）
  return value === null || value === undefined ? '' : String(value);
}

/* Banners —— 後台只有「首頁海報圖片」一個多行文字欄（一行一張圖），
   對應的是 landingFromSheets() 算出來的 bannerImages：

     bannerImages = Banners 裡 active ✕ 這一站 ✕ image 不空白的列，
                    依 sortOrder 排序後取 image 儲存格的值，
                    再換算成後台慣用的「src/檔名」（見 bannerDisplayPath）

   所以寫回去時也用同一個條件把「清單代表的那幾列」挑出來，其餘的列
   （下架的、menuWeb 專屬的、image 空白的）在後台根本看不到，一律原封
   送回 —— 少送一列 GAS 就會刪掉它，看不到的東西不可以因此消失。

   清單的每一行怎麼對回原本那一列：
     ① 先用 image 字串完全相同配對（重新排序就是走這條，id / alt 都留著）
     ② 剩下的行與剩下的列依序配對，當成「這一列的圖片被換掉了」
        （改檔名時 id / alt / site / active 才不會跟著不見）
     ③ 還是沒配到的行 → 新增一列；沒配到的列 → 真的從清單移除了 → 刪除 */
function buildBannersTable(raw, out) {
  var headers = pushHeaders('banners');
  var kept    = [];   // 後台看不到、原封送回的列
  var visible = [];   // 首頁海報欄真正代表的那些列
  var byId    = {};
  var used    = {};   // 已經被占用的 sortOrder
  var maxSort = 0;

  raw.banners.forEach(function (row, i) {
    var id = sheetText(row.id);
    if (!id) {
      out.errors.push('Banners 第 ' + (i + 1) + ' 筆沒有 id，請先到試算表補上再儲存');
      return;
    }
    if (byId[id]) {
      out.errors.push('Banners 有重複的 id：' + id + '，請先到試算表處理');
      return;
    }

    var clone = deepClone(row);
    byId[id] = clone;

    var n = sheetNumber(row.sortOrder);
    if (n > maxSort) maxSort = n;

    // 條件跟 landingFromSheets() 一模一樣。menuWeb 專屬的列在這裡就被歸進
    // kept —— 它不在後台的清單裡，所以既不會被改、也不會被刪
    // （GAS 端的 locked 規則是第二道保險）。
    if (sheetBool(row.active) && sheetSiteMatch(row.site) && sheetText(row.image)) {
      visible.push(clone);
    } else {
      kept.push(clone);
      used[n] = true;
    }
  });

  visible.sort(bySheetSortOrder);

  var list = (state.landingData || {}).bannerImages;
  if (!Array.isArray(list)) {
    // 後台沒有這個欄位（理論上不會發生）→ 整張表原封送回，不增不刪
    return kept.concat(visible);
  }
  // 後台欄位裡是「src/檔名」，儲存格要的是「檔名」（imageBase 已經含 src/）。
  // 這裡先全部換算成儲存格的寫法，後面的比對、寫入就都是同一種格式。
  list = list.map(function (v) { return bannerSheetPath(v); })
    .filter(function (v) { return v !== ''; });

  /* ── ① image 完全相同 ── */
  var matched = new Array(list.length);
  var taken   = {};
  list.forEach(function (image, i) {
    for (var j = 0; j < visible.length; j++) {
      if (taken[j]) continue;
      // 比對前兩邊都換算成儲存格的寫法，完整網址與相對路徑才不會被當成不同張圖
      if (bannerImageKey(visible[j].image) === image) {
        matched[i] = visible[j];
        taken[j] = true;
        return;
      }
    }
  });

  /* ── ② 剩下的依序配對：當成「這一列的圖片被換掉了」 ── */
  var leftover = visible.filter(function (row, j) { return !taken[j]; });
  var next = 0;
  list.forEach(function (image, i) {
    if (matched[i] || next >= leftover.length) return;
    var row = leftover[next++];
    out.warnings.push('海報 ' + sheetText(row.id) + ' 的圖片從「' + bannerDisplayPath(row.image) +
      '」改成「' + bannerDisplayPath(image) + '」（沿用原本的 id / alt / active / site）');
    matched[i] = row;   // 實際的 image 在最後統一寫入
  });

  /* ── ③ 沒配到的列 = 真的從清單上被移除了 ── */
  for (var i = next; i < leftover.length; i++) {
    out.warnings.push('海報 ' + sheetText(leftover[i].id) + '（' +
      bannerDisplayPath(leftover[i].image) +
      '）已經不在首頁海報清單裡，這次儲存會把它從試算表刪除');
  }

  /* ── 決定 sortOrder ──
     Banners 的 sortOrder 是一條全域順序（共享列與各站專屬列排在同一個清單裡），
     所以重編號時要避開 kept 那些列已經用掉的號碼。
     順序沒被動過、而且新的海報都加在最後面時就完全不重編，避免無謂的更新。 */
  var keepNumbers = true;
  var last = null;
  var sawNew = false;
  for (var k = 0; k < list.length; k++) {
    if (!matched[k]) { sawNew = true; continue; }
    if (sawNew) { keepNumbers = false; break; }    // 新的插在既有的前面
    var n = sheetNumber(matched[k].sortOrder);
    if (last !== null && n <= last) { keepNumbers = false; break; }
    last = n;
  }

  if (keepNumbers) {
    // 既有的號碼原封不動，新的接在全表最大號之後
    matched.forEach(function (row) {
      if (row) used[sheetNumber(row.sortOrder)] = true;
    });
  }
  var cursor = keepNumbers ? maxSort : 0;

  var rows = kept;
  list.forEach(function (image, i) {
    var row = matched[i];
    if (row) {
      // 一律存成相對路徑。原本存完整網址的列會在這裡被正規化
      // （值指的是同一張圖，只是改用 imageBase 補前綴的寫法）。
      row.image = image;
      if (!keepNumbers) {
        cursor = nextFreeSortOrder(used, cursor + 10);
        row.sortOrder = cursor;
      }
      rows.push(row);
      return;
    }
    // 新增的海報。後台沒有 alt / active / site 的欄位，所以給預設值：
    // 上架、site=both（兩站共用，跟現有的共享海報一致）。
    // 只想在某一站出現的話，到試算表把那一列的 site 改成 orderWeb / menuWeb。
    cursor = nextFreeSortOrder(used, cursor + 10);
    var fresh = newBannerRow(headers, nextBannerId(byId), image, cursor);
    byId[fresh.id] = fresh;
    out.newIds.push(fresh.id);
    rows.push(fresh);
  });

  return rows;
}

function newBannerRow(headers, id, image, sortOrder) {
  var row = blankRow(headers);
  row.id        = id;
  row.image     = image;
  row.alt       = '';
  row.sortOrder = sortOrder;
  row.active    = true;
  row.site      = 'both';        // 兩站共用，跟現有的共享海報一致
  return row;
}

// 下一個沒被用掉的 sortOrder（10 的倍數，避開 used 裡已經有的號碼）
function nextFreeSortOrder(used, from) {
  var n = from;
  while (used[n]) n += 10;
  used[n] = true;
  return n;
}

// 新海報的 id。沿用試算表現有的 BNR-000 命名，並確認沒有撞號
// （BNR-003 是刻意留的空號，所以要從最大號往後找，不能數列數）。
function nextBannerId(byId) {
  var max = 0;
  Object.keys(byId).forEach(function (id) {
    var m = String(id).match(/^BNR-(\d+)$/i);
    if (m) {
      var n = parseInt(m[1], 10);
      if (!isNaN(n) && n > max) max = n;
    }
  });

  var id;
  do {
    max++;
    id = 'BNR-' + String(max + 1000).substring(1);   // 001 / 024 / 137
  } while (byId[id] || !MENU_PUSH_ID_RE.test(id));

  return id;
}
