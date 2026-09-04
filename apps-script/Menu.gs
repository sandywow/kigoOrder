/**
 * Kigo 共同菜單資料 — menuWeb / orderWeb 共用
 *
 * 這份檔案只負責「菜單資料」，完全不碰 Code.gs 裡的訂單邏輯。
 *
 * 安裝方式：
 * 1. 開啟同一個 Google Sheet → 擴充功能(Extensions) → Apps Script
 * 2. 左側「檔案」按 ＋ → 指令碼(Script) → 命名為 Menu（會產生 Menu.gs）
 * 3. 把這份檔案內容整份貼進去
 * 4. 在編輯器上方的函式選單選 setupMenuSheets → 執行（只需要做一次）
 *    → 會建立 Items / ItemCategories / Categories / Settings / Banners 五張工作表並寫入初始資料
 *    → 工作表已經有資料時不會覆寫，可以安全重複執行
 * 5. Code.gs 的 doGet 已經加了 action=menu / action=menuRaw 的路由
 * 6. 部署(Deploy) → 管理部署作業 → 編輯 → 版本選「新版本」→ 部署
 *    （/exec 服務的是版本快照，只按儲存不會生效）
 *
 * 支援的呼叫：
 *   GET ?action=menu&site=menuWeb    → 已組裝好的 { menuData, landingData, tabs, sectionTitles }
 *   GET ?action=menu&site=orderWeb   → 同上，但套用 orderWeb 的分站設定
 *   GET ?action=menuRaw              → 五張工作表的原始列（給後台編輯用）
 *
 * 資料模型的兩個重點：
 *   ① 同一個商品只在 Items 建一筆。它出現在哪些分類、在各分類排第幾，
 *      放在 ItemCategories（itemId × categoryKey × sortOrder）。
 *   ② 冰熱圓點欄由 Categories.showTemp 明確控制，不是靠前台猜。
 *      前台是用「這個分類有沒有任何品項帶 temp 欄位」來決定要不要顯示整欄，
 *      所以 showTemp=FALSE 的分類，輸出時要把 temp 欄位整個省略（不是給 null）。
 */

var MENU_CODE_VERSION = 1;

// 圖片統一放 menuWeb 的 GitHub Pages，兩個站讀到的都是同一份絕對網址。
// 工作表裡也可以只填檔名（例如 lemon cake-01.jpg），會自動補上這段前綴。
var MENU_IMAGE_BASE = 'https://sandywow.github.io/kigoMenu/src/';

var MENU_SHEET_ITEMS      = 'Items';
var MENU_SHEET_ITEM_CATS  = 'ItemCategories';
var MENU_SHEET_CATEGORIES = 'Categories';
var MENU_SHEET_SETTINGS   = 'Settings';
var MENU_SHEET_BANNERS    = 'Banners';

// 新欄位一律往後加，既有資料列的位置才不會跑掉（跟 Orders 表同一個規則）
var MENU_ITEMS_HEADERS     = ['id', 'name', 'subtitle', 'desc', 'price', 'priceText', 'image', 'tag', 'temp', 'soldOut', 'active', 'note', 'updatedAt'];
var MENU_ITEM_CATS_HEADERS = ['itemId', 'categoryKey', 'sortOrder', 'active'];
var MENU_CATEGORIES_HEADERS = ['key', 'label', 'titleEn', 'titleJp', 'sortOrder', 'showTemp', 'active', 'site'];
var MENU_SETTINGS_HEADERS  = ['key', 'value', 'scope', 'type', 'note'];
var MENU_BANNERS_HEADERS   = ['id', 'image', 'alt', 'sortOrder', 'active', 'site'];


/* ═════════════════════════════
   共用小工具
   ═════════════════════════════ */

function menuToBool(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  var s = String(value).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'y' || s === '1' || s === 'v';
}

function menuBlankToNull(value) {
  var s = String(value == null ? '' : value).trim();
  return s === '' ? null : s;
}

function menuNumber(value) {
  var n = Number(value);
  return isNaN(n) ? 0 : n;
}

// 空白 / both 一律視為兩站共用
function menuSiteMatch(value, site) {
  var s = String(value == null ? '' : value).trim();
  if (s === '' || s === 'both') return true;
  return s === site;
}

// 反斜線一律轉正斜線（舊 config.js 是 src\\photo.jpg 這種寫法）。
// 已經是完整網址就原樣送出，避免把 %20 再編碼一次變成 %2520。
function menuResolveImage(value) {
  var raw = String(value == null ? '' : value).trim().replace(/\\/g, '/');
  if (!raw) return null;
  if (/^(https?:)?\/\//i.test(raw) || raw.indexOf('data:') === 0) return raw;
  return encodeURI(MENU_IMAGE_BASE + raw.replace(/^\/+/, ''));
}

function menuBySortOrder(a, b) {
  return menuNumber(a.sortOrder) - menuNumber(b.sortOrder);
}

function menuReadSheet(name, headers) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var rows = [];
  values.forEach(function (row) {
    var obj = {};
    var hasContent = false;
    headers.forEach(function (h, i) {
      obj[h] = row[i];
      if (String(row[i] == null ? '' : row[i]).trim() !== '') hasContent = true;
    });
    // 試算表底部常留一堆空列，整列空白就跳過
    if (hasContent) rows.push(obj);
  });
  return rows;
}


/* ═════════════════════════════
   action=menu — 組裝成前台現有的格式
   ═════════════════════════════ */

function buildMenuPayload(siteParam) {
  var site = String(siteParam == null ? '' : siteParam).trim();

  var itemRows     = menuReadSheet(MENU_SHEET_ITEMS, MENU_ITEMS_HEADERS);
  var linkRows     = menuReadSheet(MENU_SHEET_ITEM_CATS, MENU_ITEM_CATS_HEADERS);
  var categoryRows = menuReadSheet(MENU_SHEET_CATEGORIES, MENU_CATEGORIES_HEADERS);
  var settingRows  = menuReadSheet(MENU_SHEET_SETTINGS, MENU_SETTINGS_HEADERS);
  var bannerRows   = menuReadSheet(MENU_SHEET_BANNERS, MENU_BANNERS_HEADERS);

  // 一張表都還沒建立時不要回傳空菜單 —— 前台會照樣套用，客人就看到空白菜單了。
  // 明確回 ok:false，前台會退回 config.js 的內容。
  if (!itemRows.length || !categoryRows.length) {
    return {
      ok: false,
      error: 'menu sheets not ready (Items / Categories is empty). 請先在 Apps Script 執行 setupMenuSheets()。'
    };
  }

  var itemsById = {};
  var latestUpdatedAt = null;
  itemRows.forEach(function (row) {
    var id = String(row.id == null ? '' : row.id).trim();
    if (!id || !menuToBool(row.active)) return;
    itemsById[id] = row;
    var when = row.updatedAt instanceof Date ? row.updatedAt : null;
    if (when && (!latestUpdatedAt || when > latestUpdatedAt)) latestUpdatedAt = when;
  });

  var categories = categoryRows.filter(function (row) {
    return menuBlankToNull(row.key) && menuToBool(row.active) && menuSiteMatch(row.site, site);
  }).sort(menuBySortOrder);

  var linksByCategory = {};
  linkRows.forEach(function (row) {
    if (!menuToBool(row.active)) return;
    var key = String(row.categoryKey == null ? '' : row.categoryKey).trim();
    var id  = String(row.itemId == null ? '' : row.itemId).trim();
    if (!key || !id || !itemsById[id]) return;   // 下架或不存在的商品直接略過
    if (!linksByCategory[key]) linksByCategory[key] = [];
    linksByCategory[key].push({ item: itemsById[id], sortOrder: menuNumber(row.sortOrder) });
  });

  var menuDataOut = {};
  var tabsOut = [];
  var sectionTitlesOut = {};

  categories.forEach(function (cat) {
    var key = String(cat.key).trim();
    var showTemp = menuToBool(cat.showTemp);
    var list = (linksByCategory[key] || []).slice().sort(function (a, b) {
      return a.sortOrder - b.sortOrder;
    });

    menuDataOut[key] = list.map(function (entry) {
      return shapeMenuItem(entry.item, showTemp);
    });
    tabsOut.push({ key: key, label: String(cat.label == null || String(cat.label).trim() === '' ? key : cat.label) });
    sectionTitlesOut[key] = { en: menuBlankToNull(cat.titleEn), jp: menuBlankToNull(cat.titleJp) };
  });

  return {
    ok: true,
    site: site,
    version: typeof CODE_VERSION === 'undefined' ? null : CODE_VERSION,
    menuVersion: MENU_CODE_VERSION,
    generatedAt: new Date().toISOString(),
    updatedAt: latestUpdatedAt ? latestUpdatedAt.toISOString() : null,
    menuData: menuDataOut,
    landingData: buildLandingData(settingRows, bannerRows, site),
    tabs: tabsOut,
    sectionTitles: sectionTitlesOut
  };
}

function shapeMenuItem(row, showTemp) {
  var priceNumber = Number(row.price);
  if (isNaN(priceNumber)) priceNumber = null;
  var priceText = menuBlankToNull(row.priceText);

  var out = {
    id: String(row.id).trim(),
    name: menuBlankToNull(row.name),
    // 前台的欄位名還叫 nameJp，這裡沿用，前台渲染程式才完全不用改
    nameJp: menuBlankToNull(row.subtitle),
    desc: menuBlankToNull(row.desc),
    price: priceText || (priceNumber === null ? null : 'NT$' + priceNumber),
    priceValue: priceNumber,
    tag: menuBlankToNull(row.tag),
    image: menuResolveImage(row.image),
    emoji: null,
    soldOut: menuToBool(row.soldOut)
  };

  // showTemp=FALSE 時「不能」給 temp:null —— 前台判斷的是 item.temp !== undefined，
  // 只要欄位存在就會把整欄冰熱圓點畫出來。所以不顯示時要整個不設這個 key。
  if (showTemp) out.temp = menuBlankToNull(row.temp);

  return out;
}

// scope=both 先套一輪，再讓 scope=<自己站> 覆蓋上去。
// 只輸出工作表裡真的有列的 key —— 前台是「有這個 key 才覆寫」，
// 沒列到的（例如 orderEndpoint）就繼續沿用各站 config.js 的值，不會被清空。
function buildLandingData(settingRows, bannerRows, site) {
  var landing = {};

  ['both', site].forEach(function (wanted) {
    if (!wanted) return;
    settingRows.forEach(function (row) {
      var key = menuBlankToNull(row.key);
      if (!key) return;
      var scope = String(row.scope == null ? '' : row.scope).trim() || 'both';
      if (scope !== wanted) return;
      landing[key] = settingValue(row);
    });
  });

  landing.bannerImages = bannerRows.filter(function (row) {
    return menuToBool(row.active) && menuSiteMatch(row.site, site) && menuBlankToNull(row.image);
  }).sort(menuBySortOrder).map(function (row) {
    return menuResolveImage(row.image);
  });

  return landing;
}

function settingValue(row) {
  var type = String(row.type == null ? '' : row.type).trim().toLowerCase() || 'text';
  var raw = row.value;

  if (type === 'boolean') return menuToBool(raw);
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
  // 文字欄位空白 → null。兩邊前台都把 falsy 當作「這一項不顯示」。
  return menuBlankToNull(raw);
}


/* ═════════════════════════════
   action=menuRaw — 給後台編輯用的原始列
   ═════════════════════════════ */

function buildMenuRawPayload() {
  return {
    ok: true,
    menuVersion: MENU_CODE_VERSION,
    generatedAt: new Date().toISOString(),
    imageBase: MENU_IMAGE_BASE,
    headers: {
      items: MENU_ITEMS_HEADERS,
      itemCategories: MENU_ITEM_CATS_HEADERS,
      categories: MENU_CATEGORIES_HEADERS,
      settings: MENU_SETTINGS_HEADERS,
      banners: MENU_BANNERS_HEADERS
    },
    items: menuReadSheet(MENU_SHEET_ITEMS, MENU_ITEMS_HEADERS),
    itemCategories: menuReadSheet(MENU_SHEET_ITEM_CATS, MENU_ITEM_CATS_HEADERS),
    categories: menuReadSheet(MENU_SHEET_CATEGORIES, MENU_CATEGORIES_HEADERS),
    settings: menuReadSheet(MENU_SHEET_SETTINGS, MENU_SETTINGS_HEADERS),
    banners: menuReadSheet(MENU_SHEET_BANNERS, MENU_BANNERS_HEADERS)
  };
}


/* ═════════════════════════════
   建表 + 初始資料（在編輯器手動執行一次）
   ═════════════════════════════ */

function setupMenuSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var report = [];

  menuSheetDefs().forEach(function (def) {
    var sheet = ss.getSheetByName(def.name);
    var created = false;
    if (!sheet) {
      sheet = ss.insertSheet(def.name);
      created = true;
    }

    var maxColumns = sheet.getMaxColumns();
    if (maxColumns < def.headers.length) {
      sheet.insertColumnsAfter(maxColumns, def.headers.length - maxColumns);
    }
    sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
    sheet.setFrozenRows(1);

    var seeded = 0;
    // 已經有資料列就完全不動，這個函式可以安全重複執行
    if (sheet.getLastRow() < 2 && def.seed && def.seed.length) {
      sheet.getRange(2, 1, def.seed.length, def.headers.length).setValues(def.seed);
      seeded = def.seed.length;
    }

    report.push(def.name + '：' + (created ? '已建立' : '已存在') +
      '，標題列已寫入' +
      (seeded ? '，初始資料 ' + seeded + ' 列' : '（已有資料，未覆寫）'));
  });

  var msg = report.join('\n');
  Logger.log(msg);
  return msg;
}

function menuSheetDefs() {
  return [
    { name: MENU_SHEET_ITEMS,      headers: MENU_ITEMS_HEADERS,      seed: menuSeedItems() },
    { name: MENU_SHEET_ITEM_CATS,  headers: MENU_ITEM_CATS_HEADERS,  seed: menuSeedItemCategories() },
    { name: MENU_SHEET_CATEGORIES, headers: MENU_CATEGORIES_HEADERS, seed: menuSeedCategories() },
    { name: MENU_SHEET_SETTINGS,   headers: MENU_SETTINGS_HEADERS,   seed: menuSeedSettings() },
    { name: MENU_SHEET_BANNERS,    headers: MENU_BANNERS_HEADERS,    seed: menuSeedBanners() }
  ];
}

function menuSeedImage(file) {
  return file ? encodeURI(MENU_IMAGE_BASE + file) : '';
}

// 欄位順序：id, name, subtitle, desc, price, priceText, image, tag, temp, soldOut, active, note, updatedAt
function menuSeedItem(id, name, subtitle, desc, price, imageFile, tag, temp, soldOut) {
  return [id, name, subtitle, desc, price, '', menuSeedImage(imageFile), tag, temp, soldOut, true, '', ''];
}

// 以 menuWeb 目前的 config.js 為基準，去重後共 23 筆商品。
// 去重的 4 筆（浮生花事／潮汐花事／享・阿芙加朵／莊園蘋果冰茶）在 menuWeb 兩個分類裡
// 的欄位內容完全相同，所以合併不會遺失任何內容。
function menuSeedItems() {
  return [
    menuSeedItem('ITM-001', '莊園蘋果冰茶', '', '接骨木白花香揉合蘋果茶韻\n搭配特製果汁冰塊\n冰塊融化後風味更飽滿，微甜不膩 🌿.ᐟ.ᐟ', 150, 'apple iced tea PICTURE-05.jpg', '🍎新品嚐鮮🍎', 'iced', false),
    menuSeedItem('ITM-002', '享・ 阿芙加朵', 'ESPRESSO AFFOGATO', '寫給盛夏的冰與火之歌：\n\n讓熱咖啡\n緩緩落進冰淇淋\n\n把最後一刻\n留給最剛好的相遇', 150, 'AFFOGATO PICTURE-04.jpg', '新品嚐鮮.ᐟ.ᐟ', '', false),
    menuSeedItem('ITM-003', '潮汐花事', '鮪魚．鮭魚卵．薯泥．蛋．沙拉', '生活的起落，一如潮汐往返\n在海洋與薯泥的包容中，找回自己的節奏', 100, 'FISH PICTURE-03.jpg', '', '', false),
    menuSeedItem('ITM-004', '浮生花事', '薯泥．蛋．沙拉', '一天的忙碌過後，來口清爽無負擔的薯泥\n卸下防備，偷得浮生半日閒', 80, 'POTATO PICTURE-02.jpg', '蛋奶素', '', false),

    menuSeedItem('ITM-005', '香橙巴斯克蛋糕', '', '綿密乳酪融入橙香果蜜\n清爽不膩，每一口都是乳酪控的天堂', 80, '', '', '', true),
    menuSeedItem('ITM-006', '莓果巴斯克蛋糕', '', '酸度喚醒味覺，甜味輕輕把你抱住\n酸甜交織，這就是莓果的專屬小悸動吧！', 100, '', '', '', false),
    menuSeedItem('ITM-007', '午後檸檬', '青檸磅蛋糕', '微酸剛好', 60, 'lemon cake-01.jpg', '', '', false),
    menuSeedItem('ITM-008', '布朗尼想怎樣', '', '是雙層布朗尼！\n我都兩種口感讓尼一次滿足了\n尼還想怎樣啦(…>_<…)', 120, '', '', '', true),
    menuSeedItem('ITM-009', '淡烏龍芝士蛋糕', '', '輕盈茶香，回甘柔和\n適合想慢下來的時候～', 180, '', '', '', true),
    menuSeedItem('ITM-010', '重烏龍芝士蛋糕', '', '像山風一樣，茶香迎面而來\n茶韻厚實，濃中帶清\n喜歡茶的你一定要試試！', 160, '', '', '', true),

    menuSeedItem('ITM-011', '享．咖啡', '', '', 100, '', '', 'both', false),
    menuSeedItem('ITM-012', '享．拿鐵', '', '', 150, '', '', 'both', false),
    menuSeedItem('ITM-013', '冰釀咖啡', '', '哥倫比亞｜薇拉莊園  微量批次\n產自中南美洲，慢火烘焙技術，使咖啡獨有堅果可可風味別明亮而乾淨，尾韻代微微橙皮酸。', 200, '', '每日限量', 'iced', true),
    menuSeedItem('ITM-014', '享．手沖', '', '👑經典款  瓜地馬拉｜甜果微醺\n🎁驚喜款  店長嚴選', 180, '', '', 'both', false),
    menuSeedItem('ITM-015', '沁涼青檸咖啡', '', '', 150, '', '', 'iced', false),
    menuSeedItem('ITM-016', '夢迴泡泡', '', '', 150, '', '', 'iced', false),
    menuSeedItem('ITM-017', '焦糖瑪奇朵', '', '', 180, '', '', 'iced', false),

    menuSeedItem('ITM-018', '香蘋肉桂茶', '', '經典組合！以紅茶為基底，融合蘋果與肉桂香氣\n口感溫潤豐富，猶如一杯能喝的甜點', 150, '', '暖心推薦', 'hot', false),
    menuSeedItem('ITM-019', '享．紅茶', '', '', 100, '', '', 'iced', true),

    menuSeedItem('ITM-020', '可可榛果奶霧', '', '', 180, '', '', 'hot', false),
    menuSeedItem('ITM-021', '晨露玫香花醋飲', '', '', 180, '', '', 'iced', false),
    menuSeedItem('ITM-022', '接骨木檸檬泡泡', '氣泡飲', '', 150, '', '', 'iced', false),
    menuSeedItem('ITM-023', '夜色星河', '乳酸飲\n※本飲品含蝶豆花，孕婦、先天凝血功能不佳、服用抗凝血藥物或糖尿病患者，不宜飲用。', '', 150, '', '', 'iced', false)
  ];
}

// 27 列 = menuWeb 目前的 27 個「商品 × 分類」位置。
// sortOrder 用 10 的間隔，中間要插新品項不用重編整排。
function menuSeedItemCategories() {
  var rows = [];
  var add = function (categoryKey, ids) {
    ids.forEach(function (id, i) {
      rows.push([id, categoryKey, (i + 1) * 10, true]);
    });
  };

  add('seasonal', ['ITM-001', 'ITM-002', 'ITM-003', 'ITM-004']);
  add('dessert',  ['ITM-005', 'ITM-006', 'ITM-007', 'ITM-004', 'ITM-003', 'ITM-002', 'ITM-008', 'ITM-009', 'ITM-010']);
  add('coffee',   ['ITM-011', 'ITM-012', 'ITM-013', 'ITM-014', 'ITM-015', 'ITM-016', 'ITM-017']);
  add('tea',      ['ITM-018', 'ITM-001', 'ITM-019']);
  add('noncafe',  ['ITM-020', 'ITM-021', 'ITM-022', 'ITM-023']);

  return rows;
}

// 取代原本的 tabs（順序 + 顯示名）和 sectionTitles（英文大標 + 中文副標）。
// showTemp 依 menuWeb 現況：seasonal / dessert 目前沒有任何品項帶 temp，所以不顯示冰熱欄。
// 欄位順序：key, label, titleEn, titleJp, sortOrder, showTemp, active, site
function menuSeedCategories() {
  return [
    ['seasonal', '當季',     'Seasonal Selections', '季節推薦',     10, false, true, 'both'],
    ['coffee',   '咖啡',     'Coffee',              '咖啡',         20, true,  true, 'both'],
    ['tea',      '茶飲',     'Tea',                 '茶飲',         30, true,  true, 'both'],
    ['noncafe',  '無咖啡因', 'Non-Caffeinated',     '無咖啡因飲品', 40, true,  true, 'both'],
    ['dessert',  '甜點',     'Pâtisserie',          '手作．甜點',   50, false, true, 'both']
  ];
}

// 取代 landingData。scope=both 兩站共用；scope=menuWeb / orderWeb 只套用在該站。
// 刻意「不放」orderEndpoint —— 那是 orderWeb 送單用的網址，留在它自己的 config.js
// 由後台管理，這裡不列到就不會被覆寫，訂單功能不受影響。
// 欄位順序：key, value, scope, type, note
function menuSeedSettings() {
  return [
    ['cafeName',          'EnjoyKigo',                              'both', 'text',    '店名（英文）'],
    ['cafeSub',           '享 · 奇果',                              'both', 'text',    '店名（中文）'],
    ['showDate',          false,                                    'both', 'boolean', '首頁是否顯示今天日期'],
    ['dateSeasonLabel',   'Spring Menu',                            'both', 'text',    '日期旁邊的季節字樣（showDate 打開才會顯示）'],
    ['tagline',           '˚₊‧꒰ა 享受生活應該是進行式 ໒꒱ ‧₊˚',      'both', 'text',    '首頁標語'],
    ['taglineJp',         '𝐿𝑖𝑓𝑒 𝑖𝑠 𝑎𝑙𝑙 𝑎𝑏𝑜𝑢𝑡 ℎ𝑎𝑣𝑖𝑛𝑔 𝑎 𝑔𝑜𝑜𝑑 𝑡𝑖𝑚𝑒.', 'both', 'text', '首頁標語（英文）'],

    ['heroImage',         '',                                       'both', 'text',    '首頁主視覺圖片（空白 = 用內建插畫）'],
    ['heroBadge',         '',                                       'both', 'text',    '主視覺角標（目前兩站都不顯示）'],
    ['heroTitle',         '',                                       'both', 'text',    '主視覺標題（目前兩站都不顯示）'],
    ['heroSubtitle',      '',                                       'both', 'text',    '主視覺副標（目前兩站都不顯示）'],

    ['bannerLabel',       '',                                       'both', 'text',    '海報區小標'],
    ['bannerAlt',         '當季推薦海報',                            'both', 'text',    '海報圖片替代文字'],
    ['bannerPlaceholder', false,                                    'both', 'boolean', '沒有海報時是否顯示佔位圖'],
    ['hideBanner',        false,                                    'both', 'boolean', '隱藏整個海報區'],
    ['hideCard',          true,                                     'both', 'boolean', '隱藏首頁推薦卡'],

    ['ctaButton',         '今日菜單',                                'both', 'text',    '進菜單按鈕文字'],
    ['ctaHint',           '瀏覽全品項⤴︎',                            'both', 'text',    '按鈕下方提示'],
    ['footerLeft',        '— since 2023 —',                         'both', 'text',    '頁尾左側'],
    ['footerRight',       '',                                       'both', 'text',    '頁尾右側'],
    ['menuTitle',         '今日菜單',                                'both', 'text',    '菜單頁標題'],
    ['menuSubtitle',      'Summer 2026',                            'both', 'text',    '菜單頁副標'],

    // ── 兩站不同的設定 ──
    ['hideHero',          false,                                    'menuWeb',  'boolean', 'menuWeb 顯示內建插畫'],
    ['hideHero',          true,                                     'orderWeb', 'boolean', 'orderWeb 不顯示主視覺'],

    ['cardLabel',         '夏日飲品新選擇🌿',                        'menuWeb',  'text', '推薦卡小標（目前被 hideCard 隱藏）'],
    ['cardName',          '莊園接骨木蘋果冰茶',                       'menuWeb',  'text', '推薦卡品名'],
    ['cardNameJp',        '',                                       'menuWeb',  'text', '推薦卡副標'],
    ['cardDesc',          '接骨木白花香揉合蘋果茶韻\n搭配特製果汁冰塊，微甜不膩🌿.ᐟ.ᐟ', 'menuWeb', 'text', '推薦卡描述'],
    ['cardPrice',         'NT$150',                                 'menuWeb',  'text', '推薦卡價格（純顯示文字）'],
    ['cardTag',           '',                                       'menuWeb',  'text', '推薦卡標籤'],

    ['cardLabel',         '',                                       'orderWeb', 'text', '推薦卡小標（目前被 hideCard 隱藏）'],
    ['cardName',          '午後檸檬',                                'orderWeb', 'text', '推薦卡品名'],
    ['cardNameJp',        '',                                       'orderWeb', 'text', '推薦卡副標'],
    ['cardDesc',          '微酸剛好(⸝⸝¯ᵕ¯⸝⸝)🍋',                    'orderWeb', 'text', '推薦卡描述'],
    ['cardPrice',         'NT$100',                                 'orderWeb', 'text', '推薦卡價格（純顯示文字）'],
    ['cardTag',           '限定',                                    'orderWeb', 'text', '推薦卡標籤'],

    ['tableNumbers',      '1\n2\n3\n4\n吧檯',                        'orderWeb', 'list', '點餐桌號清單，一行一個']
  ];
}

// bannerImages 是有順序的清單，所以獨立一張表。
// menuWeb / orderWeb 目前的輪播內容不同，用 site 欄位分開。
// 欄位順序：id, image, alt, sortOrder, active, site
function menuSeedBanners() {
  return [
    ['BNR-001', menuSeedImage('BANNER apple iced tea-05.jpg'), '莊園蘋果冰茶', 10, true, 'menuWeb'],
    ['BNR-002', menuSeedImage('BANNER AFFOGATO-04.jpg'),       '享・阿芙加朵', 20, true, 'menuWeb'],
    ['BNR-003', menuSeedImage('BANNER AFFOGATO-04.jpg'),       '享・阿芙加朵', 10, true, 'orderWeb'],
    ['BNR-004', menuSeedImage('BANNER FISH-03.jpg'),           '潮汐花事',     20, true, 'orderWeb'],
    ['BNR-005', menuSeedImage('BANNER POTATO-02.jpg'),         '浮生花事',     30, true, 'orderWeb']
  ];
}
