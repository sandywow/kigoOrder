/**
 * Kigo 菜單寫入 API — action=saveMenu
 *
 * 這份檔案只負責「把後台送來的菜單 snapshot 寫回五張菜單工作表」。
 * 它完全不碰 Code.gs 的訂單邏輯，也不碰 Menu.gs 的讀取邏輯
 * （只借用 Menu.gs 已經定義好的表名、表頭與 menuToBool 等小工具）。
 *
 * ⚠⚠ 寫入能力已經完成，但預設是關的 ⚠⚠
 *   MENU_WRITE_ENABLED = false → 只讀取試算表、算出「將會新增／修改／刪除什麼」
 *   然後把計畫回傳，一個 cell 都不會被寫入（回應帶 dryRun: true）。
 *   改成 true 之後才會真的照那份計畫寫入（回應帶 dryRun: false）。
 *   兩道獨立的檢查：saveMenuLocked() 的 if，以及 menuWriteApplyTable() 開頭
 *   自己再檢查一次並 throw —— 任何繞過前者的呼叫路徑都寫不進去。
 *
 * 安裝方式：
 * 1. 開啟同一個 Google Sheet → 擴充功能(Extensions) → Apps Script
 * 2. 左側「檔案」按 ＋ → 指令碼(Script) → 命名為 MenuWrite（會產生 MenuWrite.gs）
 * 3. 把這份檔案內容整份貼進去
 * 4. Code.gs 的 doPost 已經加了 action=saveMenu 的路由
 * 5. 部署(Deploy) → 管理部署作業 → 編輯 → 版本選「新版本」→ 部署
 *    （/exec 服務的是版本快照，只按儲存不會生效）
 *
 * 不必部署也能測：在編輯器的函式選單選 menuWriteSelfTest → 執行，
 * 它會拿現在試算表的真實資料當 payload 跑 19 組情境（原封送回、改一筆、
 * 新增、刪除、menuWeb 保護、各種該被拒絕的壞資料），逐項自我檢查並印出結果。
 * 一樣不寫入任何 cell。
 *
 * 支援的呼叫：
 *   POST { action:'saveMenu', site:'orderWeb', tables:{ items:[...], ... } }
 *
 * body 的形狀有一個刻意的設計：商品陣列放在 tables.items，
 * 「不是」放在最上層的 items。因為 Code.gs 的 doPost 是
 * 「前面的 action 都沒命中 → 當成建立訂單」，而 handleCreateOrder 讀的正是
 * payload.items。包一層之後 payload.items 永遠是 undefined，
 * 所以就算哪天忘記重新部署、或 action 名字打錯，菜單資料也只會得到
 * 「order has no items」而不會被寫進 Orders。
 *
 * 寫入策略：完整 snapshot + GAS 端依 stable key 差異比對。
 *   前端不算 diff，只要把畫面上的完整狀態送出來；列號、新增／刪除的判斷
 *   全部由 GAS 當場讀取試算表決定（Menu.gs 的 menuReadSheet 會跳過空白列
 *   且不回傳列號，前端根本無法知道某筆資料在第幾列）。
 *
 * saveMenu 需要 token：值存在這個專案的指令碼屬性 MENU_WRITE_TOKEN，
 * 不在這份檔案裡（見下面的「Token 驗證」）。訂單 API 不受影響。
 */

var MENU_WRITE_VERSION = 2;   // v2: saveMenu 需要 token（值存在指令碼屬性）

// ⚠ 寫入的總開關。false = 只算計畫不寫入（menuWriteApplyTable 連第一格都不會碰）。
//   要真的開始寫入時只改這一行；寫入邏輯本身已經完成，不需要再補程式碼。
var MENU_WRITE_ENABLED = true;

// 目前只有 orderWeb 有後台。這個值只用於回報與紀錄，不用來決定權限 ——
// 權限一律看試算表上該列現在的 scope / site 值，不看 payload 說自己是誰。
var MENU_WRITE_SITE = 'orderWeb';

// menuWeb 專屬的列：orderWeb 後台唯讀，不覆蓋、不刪除
var MENU_WRITE_LOCKED_SITE = 'menuWeb';

// orderWeb 後台可以寫入的 scope / site 值（空白 = both）
var MENU_WRITE_ALLOWED_SITES = ['both', 'orderWeb'];

// 這兩個 key 刻意不存在於 Settings 工作表 —— 它們是前台送單／取菜單的網址，
// 留在各站自己的 config.js 由後台管理。一旦被寫成 Settings 的某一列，
// 前台的送單網址就會改由 Sheets 決定，網址一有問題整家店就送不出單。
var MENU_WRITE_SETTING_KEY_BLOCKLIST = ['orderEndpoint', 'menuEndpoint'];

// 純防呆。目前實際資料量是 Items 23 / ItemCategories 27 / Categories 5 /
// Settings 36 / Banners 4，離上限很遠。
var MENU_WRITE_MAX_ROWS = 500;

// plan 是給人看的，太長反而看不懂；超過就只回數量
var MENU_WRITE_MAX_PLAN = 200;

// id 允許的字元。刻意「不」寫成 ^ITM-\d{3}$ —— Banners 已經刻意留了 BNR-003
// 這個空號，店長哪天手動加一筆 id 也不該被 API 鎖死。
var MENU_WRITE_ID_RE  = /^[A-Za-z0-9_.\-]{1,40}$/;
// Categories.key 會變成 menuData 的物件 key 與前台 tab 的 key，收得嚴一點
var MENU_WRITE_CATKEY_RE = /^[a-z][a-z0-9_]{0,30}$/;
// Settings.key 是 landingData 的欄位名（cafeName / hideHero / tableNumbers …）
var MENU_WRITE_SETKEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

var MENU_WRITE_TEMP_VALUES     = ['', 'hot', 'iced', 'both'];
var MENU_WRITE_SETTING_TYPES   = ['text', 'number', 'boolean', 'list'];

// 寫入順序刻意排成「任何中斷點都留下一個可讀的狀態」：
//   Items 先寫，連結才有東西可指；
//   ItemCategories 比 Categories 先寫，因為「指向不存在分類的連結」會被
//   buildMenuPayload 直接忽略（無害），反過來「分類已存在但連結還沒寫」
//   會在前台生出一個空的 tab（客人看得到）。
//   Settings / Banners 互相獨立，放最後。
var MENU_WRITE_ORDER = ['items', 'itemCategories', 'categories', 'settings', 'banners'];


/* ═════════════════════════════
   每張表的規格

   headers 一律引用 Menu.gs 已經存在的 MENU_*_HEADERS —— 欄位順序永遠由這裡
   決定，絕不採用 payload 的 key 順序，也不採用當場讀到的標題列。
   這樣 payload 就沒有任何辦法把值寫錯格子，也沒辦法因為漏一個欄位
   讓整列往左位移。
   ═════════════════════════════ */

function menuWriteSpecs() {
  return {
    items: {
      sheetName: MENU_SHEET_ITEMS,
      headers:   MENU_ITEMS_HEADERS,
      // stable key：id
      keyFields: ['id'],
      // 這些欄位是身分本身，既有列的這幾格永遠不會被改寫
      identity:  ['id'],
      // GAS 自己管的欄位：payload 可以帶（menuRaw 原封送回時就會帶），但值一律忽略
      managed:   ['updatedAt'],
      required:  ['name'],
      // Items 沒有 site 欄 —— 代表它是「兩站共用同一筆」，不是「屬於 orderWeb」。
      // 所以沒有 locked 的概念，每一列 orderWeb 後台都可以改，
      // 但改動會同時反映到 menuWeb 的菜單上。
      guard: null,
      // 有任何欄位真的變更時才更新這個欄位（沒變更就不要動它 ——
      // buildMenuPayload 用 max(Items.updatedAt) 當整份菜單的 updatedAt）
      touchOnChange: 'updatedAt',
      fields: {
        id: 'idText', name: 'text', subtitle: 'text', desc: 'text',
        price: 'numberOrBlank', priceText: 'text', image: 'text', tag: 'text',
        temp: 'temp', soldOut: 'bool', active: 'bool', note: 'text',
        updatedAt: 'managed'
      }
    },

    itemCategories: {
      sheetName: MENU_SHEET_ITEM_CATS,
      headers:   MENU_ITEM_CATS_HEADERS,
      // stable key：itemId + categoryKey（這張表沒有 id 欄，是複合鍵）
      keyFields: ['itemId', 'categoryKey'],
      identity:  ['itemId', 'categoryKey'],
      managed:   [],
      required:  [],
      // 這張表也沒有 site 欄，它的有效 site 是「繼承自 categoryKey 對應的分類」。
      // 所以某一列連結能不能改，要看它的分類能不能改（見 menuWriteResolveGuards）。
      guard: 'inheritCategory',
      touchOnChange: null,
      fields: {
        itemId: 'idText', categoryKey: 'catKeyText',
        sortOrder: 'sortOrder', active: 'bool'
      }
    },

    categories: {
      sheetName: MENU_SHEET_CATEGORIES,
      headers:   MENU_CATEGORIES_HEADERS,
      // stable key：key（同時也是 ItemCategories 的外鍵，所以不可改）
      keyFields: ['key'],
      identity:  ['key'],
      managed:   [],
      required:  [],
      guard: { field: 'site', label: 'site' },
      touchOnChange: null,
      fields: {
        key: 'catKeyText', label: 'text', titleEn: 'text', titleJp: 'text',
        sortOrder: 'sortOrder', showTemp: 'bool', active: 'bool', site: 'site'
      }
    },

    settings: {
      sheetName: MENU_SHEET_SETTINGS,
      headers:   MENU_SETTINGS_HEADERS,
      // stable key：key + scope（複合鍵！）
      //
      // ⚠ 這是整個寫入層最重要的一行。Settings 的 key 是會重複的 ——
      //   hideHero / cardLabel / cardName / cardNameJp / cardDesc / cardPrice /
      //   cardTag 在 menuWeb 與 orderWeb 各有一列。只用 key 當主鍵的話，
      //   第一次儲存就會把 menuWeb 那一組覆蓋成 orderWeb 的值，
      //   而且完全沒有錯誤訊息，等到有人打開 menuWeb 才會發現。
      keyFields: ['key', 'scope'],
      identity:  ['key', 'scope'],
      managed:   [],
      required:  [],
      guard: { field: 'scope', label: 'scope' },
      touchOnChange: null,
      fields: {
        key: 'setKeyText', value: 'settingValue', scope: 'site',
        type: 'settingType', note: 'text'
      }
    },

    banners: {
      sheetName: MENU_SHEET_BANNERS,
      headers:   MENU_BANNERS_HEADERS,
      // stable key：id
      keyFields: ['id'],
      identity:  ['id'],
      managed:   [],
      required:  [],
      guard: { field: 'site', label: 'site' },
      touchOnChange: null,
      fields: {
        id: 'idText', image: 'text', alt: 'text',
        sortOrder: 'sortOrder', active: 'bool', site: 'site'
      }
    }
  };
}


/* ═════════════════════════════
   進入點
   ═════════════════════════════ */

// Code.gs 的 doPost 只呼叫這一支（在訂單 fallback 之前）
function handleSaveMenu(payload) {
  return jsonResponse(saveMenuResult(payload));
}

// 回傳純物件，方便編輯器裡的 menuWriteSelfTest() 直接檢查
function saveMenuResult(payload) {
  // Token 驗證：在 LockService、讀取工作表、任何寫入之前就決定放不放行
  var denied = menuWriteAuthorize(payload);
  if (denied) return denied;

  // 讀取也放在鎖裡面：跟訂單共用同一把 script lock，菜單儲存與建立訂單
  // 永遠不會交錯。dryRun 只讀不寫，本來不需要鎖，但這樣第二階段要真的寫入時
  // 這裡的結構完全不用改（也才不會讀到寫了一半的資料）。
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return saveMenuLocked(payload);
  } finally {
    lock.releaseLock();
  }
}

/* ═════════════════════════════
   Token 驗證

   saveMenu 每一次請求都要帶 token。比對在 saveMenuResult() 的第一行做完，
   位置在 LockService、在讀取工作表、在算計畫、在任何寫入之前 ——
   沒過就直接回傳，整條路徑連一次 getRange 都不會發生。

   ⚠ 真正的 token「不在這份檔案裡」。這份檔案會進公開 repo，所以值存在
     這個 Apps Script 專案的指令碼屬性（Script Properties）：
       專案設定(Project Settings) → 指令碼屬性 → 新增
         屬性：MENU_WRITE_TOKEN
         值  ：一串夠長的隨機字串
     不想自己想一串就在編輯器執行 menuWriteGenerateToken()，它會產生、存好，
     並在執行紀錄印出來一次（之後就只看得到指紋）。

   ⚠ 這個 token 只管 saveMenu。訂單 API（doPost 的其他 action 與建立訂單的
     fallback）完全不經過這裡，點餐前台不受任何影響。
   ═════════════════════════════ */

var MENU_WRITE_TOKEN_PROPERTY = 'MENU_WRITE_TOKEN';

// 回傳 null = 通過；回傳物件 = 直接當成回應送出（呼叫端不會再往下走）。
function menuWriteAuthorize(payload) {
  var expected = menuWriteStoredToken();

  // 還沒設定就一律拒絕（fail closed）。設定漏掉時寧可存不了，
  // 也不要退回成「誰都可以寫」。
  if (!expected) {
    return menuWriteFailure('token not configured', [
      '這個 Apps Script 專案還沒有設定 ' + MENU_WRITE_TOKEN_PROPERTY +
      '（專案設定 → 指令碼屬性），saveMenu 一律拒絕'
    ]);
  }

  if (!menuWriteSecretEquals(payload && payload.token, expected)) {
    // 錯誤訊息不要透露任何線索（長度、對到第幾個字都不講）
    return menuWriteFailure('unauthorized', ['saveMenu 的 token 不正確或沒有帶']);
  }

  return null;
}

function menuWriteStoredToken() {
  try {
    var value = PropertiesService.getScriptProperties().getProperty(MENU_WRITE_TOKEN_PROPERTY);
    return String(value == null ? '' : value).trim();
  } catch (err) {
    // 讀不到屬性就當作沒設定 —— 一樣是拒絕，不會變成放行
    return '';
  }
}

// 比對 SHA-256 之後的位元組，而且一定跑完全部 32 個位元組。
// 不用 a === b 是因為字串比對會在第一個不同的字元就回來，
// 回應時間會洩漏「猜對了前幾個字」；改比雜湊也讓長度不會外流。
function menuWriteSecretEquals(given, expected) {
  var a = menuWriteDigest(String(given == null ? '' : given));
  var b = menuWriteDigest(String(expected == null ? '' : expected));

  var diff = a.length ^ b.length;
  for (var i = 0; i < a.length && i < b.length; i++) {
    diff |= (a[i] ^ b[i]);
  }
  return diff === 0;
}

function menuWriteDigest(value) {
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8);
}

// 指紋：可以拿來對照「後台輸入的那一串跟這裡存的是不是同一個」，
// 但看不出原本的值。
function menuWriteTokenFingerprint(value) {
  var bytes = menuWriteDigest(String(value == null ? '' : value));
  var hex = '';
  for (var i = 0; i < 4; i++) {
    hex += ('0' + (bytes[i] & 0xff).toString(16)).slice(-2);
  }
  return hex;
}

/* ── 編輯器用的兩支小工具（不經過 doPost，不用部署也能跑）── */

// 產生一組 token 存進指令碼屬性，並印出來一次。
// 已經有設定就不覆蓋 —— 蓋掉會讓所有後台立刻存不了東西。
function menuWriteGenerateToken() {
  var props = PropertiesService.getScriptProperties();
  var current = menuWriteStoredToken();
  if (current) {
    var msg = MENU_WRITE_TOKEN_PROPERTY + ' 已經設定過了（指紋 ' +
      menuWriteTokenFingerprint(current) + '）。\n' +
      '要換一組請先到「專案設定 → 指令碼屬性」把它刪掉再執行這一支。';
    Logger.log(msg);
    return msg;
  }

  var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  props.setProperty(MENU_WRITE_TOKEN_PROPERTY, token);

  var out = '已產生並儲存 ' + MENU_WRITE_TOKEN_PROPERTY + '：\n\n' + token + '\n\n' +
    '（指紋 ' + menuWriteTokenFingerprint(token) + '）\n' +
    '把上面那一串貼到後台第一次儲存時跳出來的視窗。\n' +
    '⚠ 這是唯一一次看得到完整內容，之後只查得到指紋。';
  Logger.log(out);
  return out;
}

// 只回報有沒有設定與指紋，不會印出 token 本身
function menuWriteTokenStatus() {
  var token = menuWriteStoredToken();
  var msg = token
    ? MENU_WRITE_TOKEN_PROPERTY + ' 已設定（長度 ' + token.length +
      '，指紋 ' + menuWriteTokenFingerprint(token) + '）'
    : MENU_WRITE_TOKEN_PROPERTY + ' 尚未設定 —— saveMenu 目前一律拒絕';
  Logger.log(msg);
  return msg;
}

function saveMenuLocked(payload) {
  var specs  = menuWriteSpecs();
  var errors = [];
  var warnings = [];

  /* ── ① payload 結構 ── */
  var tables = payload && payload.tables;
  if (!tables || typeof tables !== 'object' || Array.isArray(tables)) {
    return menuWriteFailure('tables must be an object', ['payload.tables 缺少或格式不對']);
  }

  var requested = [];
  Object.keys(tables).forEach(function (name) {
    // 未知的表名一律拒絕，不是忽略 —— 忽略會讓前端以為存成功了。
    // 同時這也是「payload 不允許指定任意工作表名稱」的第一道關：
    // 表名只能是這五個字串，實際的工作表名稱來自 spec，不是 payload。
    if (!specs[name]) {
      errors.push('未知的表：' + name + '（只接受 ' + MENU_WRITE_ORDER.join(' / ') + '）');
      return;
    }
    requested.push(name);
  });

  if (!requested.length && !errors.length) {
    errors.push('tables 沒有任何一張已知的表，沒有東西可以儲存');
  }
  if (errors.length) return menuWriteFailure('invalid payload', errors);

  // 依寫入順序處理，錯誤訊息的順序才跟實際動作一致
  var order = MENU_WRITE_ORDER.filter(function (name) {
    return requested.indexOf(name) >= 0;
  });

  /* ── ② 讀取試算表（含實際列號） ── */
  var sheets = {};
  order.forEach(function (name) {
    var spec = specs[name];
    var read = menuWriteReadSheet(spec);
    if (read.error) {
      errors.push(read.error);
      return;
    }
    sheets[name] = read;
    if (read.duplicates.length) {
      // 試算表本身就有重複的 key → 無法安全決定要更新哪一列，直接中止
      errors.push(spec.sheetName + ' 工作表本身有重複的 key：' +
        read.duplicates.join('、') + '（請先在試算表上處理掉重複列）');
    }
    if (read.blankRows.length) {
      warnings.push(spec.sheetName + ' 有 ' + read.blankRows.length +
        ' 列整列空白（列號 ' + read.blankRows.join('、') + '），會被忽略、不會被刪除' +
        '（刪除只發生在「試算表有這個 key、payload 沒有」的列）');
    }
  });
  if (errors.length) return menuWriteFailure('sheet not ready', errors);

  /* ── ③ 逐表驗證 payload（還不算 diff） ── */
  var parsed = {};
  order.forEach(function (name) {
    parsed[name] = menuWriteParseTable(name, specs[name], tables[name], sheets[name], errors);
  });
  if (errors.length) return menuWriteFailure('validation failed', errors);

  /* ── ④ 決定每一列能不能寫（scope / site 防守） ── */
  menuWriteResolveGuards(order, specs, parsed, sheets, errors);
  if (errors.length) return menuWriteFailure('validation failed', errors);

  /* ── ⑤ 跨表參照 ── */
  menuWriteCheckReferences(specs, parsed, sheets, errors);
  if (errors.length) return menuWriteFailure('validation failed', errors);

  /* ── ⑥ 算出每一張表的變更計畫 ── */
  var plans = {};
  order.forEach(function (name) {
    plans[name] = menuWritePlanTable(specs[name], parsed[name], sheets[name]);
  });

  /* ── ⑦ 執行（MENU_WRITE_ENABLED=false 時整段不動任何 cell） ── */
  var written      = {};
  var completed    = [];
  var failed       = [];
  var notAttempted = [];
  var plan         = [];

  for (var i = 0; i < order.length; i++) {
    var name = order[i];
    var spec = specs[name];
    var tablePlan = plans[name];

    // 每一張表動手之前再確認一次基本資料 —— 前面的表寫完之後才發現
    // 後面的表有問題，是最糟的情況
    var assertErrors = menuWriteAssertPlan(spec, tablePlan);
    if (assertErrors.length) {
      failed.push({ table: name, error: assertErrors.join('；') });
      notAttempted = order.slice(i + 1);
      break;
    }

    if (MENU_WRITE_ENABLED) {
      try {
        menuWriteApplyTable(spec, tablePlan, sheets[name]);
        completed.push(name);
      } catch (err) {
        // GAS / Sheets 沒有跨工作表 transaction，所以這裡不做 rollback。
        // 前面已經寫完的表留在 completed，還沒動的表留在 notAttempted，
        // 呼叫端看得出來停在哪裡。策略是 idempotent 的 ——
        // 修好問題後把同一份 snapshot 再送一次就會補齊。
        failed.push({ table: name, error: menuWriteErrorText(err) });
        notAttempted = order.slice(i + 1);
        break;
      }
    }

    written[name] = tablePlan.counts;
    tablePlan.entries.forEach(function (entry) {
      if (plan.length < MENU_WRITE_MAX_PLAN) plan.push(entry);
    });
    tablePlan.warnings.forEach(function (w) { warnings.push(w); });
  }

  var totalPlanned = 0;
  order.forEach(function (name) {
    var c = plans[name].counts;
    totalPlanned += c.updated + c.added + c.deleted;
  });

  return {
    ok: failed.length === 0,
    dryRun: !MENU_WRITE_ENABLED,
    version: typeof CODE_VERSION === 'undefined' ? null : CODE_VERSION,
    menuWriteVersion: MENU_WRITE_VERSION,
    site: MENU_WRITE_SITE,
    requestedSite: menuWriteText(payload && payload.site) || null,
    tables: order,
    written: written,
    totalPlanned: totalPlanned,
    completed: completed,
    failed: failed,
    notAttempted: notAttempted,
    planTruncated: plan.length >= MENU_WRITE_MAX_PLAN,
    plan: plan,
    warnings: warnings,
    generatedAt: new Date().toISOString()
  };
}

function menuWriteFailure(error, errors) {
  return {
    ok: false,
    dryRun: !MENU_WRITE_ENABLED,
    error: error,
    errors: errors,
    menuWriteVersion: MENU_WRITE_VERSION,
    completed: [],
    failed: [],
    notAttempted: [],
    generatedAt: new Date().toISOString()
  };
}


/* ═════════════════════════════
   讀取工作表（保留實際列號）
   ═════════════════════════════ */

// 只能取這五張表。工作表名稱來自 spec，payload 沒有任何欄位可以指定它；
// 這裡再加一道硬斷言，確保未來重構也不可能把 Orders 交出去。
function menuWriteGetSheet(sheetName) {
  var allowed = [
    MENU_SHEET_ITEMS, MENU_SHEET_ITEM_CATS, MENU_SHEET_CATEGORIES,
    MENU_SHEET_SETTINGS, MENU_SHEET_BANNERS
  ];
  if (allowed.indexOf(sheetName) < 0) {
    throw new Error('refuse to touch sheet: ' + sheetName);
  }
  // 保險：不管上面的名單怎麼改，訂單表永遠不會從這裡出去
  if (typeof SHEET_NAME !== 'undefined' && sheetName === SHEET_NAME) {
    throw new Error('refuse to write Orders');
  }
  if (sheetName === 'Orders') {
    throw new Error('refuse to write Orders');
  }
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
}

function menuWriteReadSheet(spec) {
  var sheet = menuWriteGetSheet(spec.sheetName);
  if (!sheet) {
    return { error: '找不到工作表：' + spec.sheetName + '（請先執行 setupMenuSheets()）' };
  }

  var out = {
    sheet: sheet,
    rows: [],          // { rowNumber, values, key }
    byKey: {},
    blankRows: [],
    duplicates: []
  };

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return out;

  var values = sheet.getRange(2, 1, lastRow - 1, spec.headers.length).getValues();

  values.forEach(function (arr, i) {
    var rowNumber = i + 2;

    var blank = true;
    for (var c = 0; c < spec.headers.length; c++) {
      if (menuWriteText(arr[c]) !== '') { blank = false; break; }
    }
    // 試算表底部常留一堆空列（Menu.gs 的 menuReadSheet 也是跳過它們）
    if (blank) {
      out.blankRows.push(rowNumber);
      return;
    }

    var key = menuWriteKeyFromCells(spec, arr);
    var row = { rowNumber: rowNumber, values: arr, key: key };
    out.rows.push(row);

    if (out.byKey[key]) {
      if (out.duplicates.indexOf(key) < 0) out.duplicates.push(key);
    } else {
      out.byKey[key] = row;
    }
  });

  return out;
}

// 複合鍵的分隔符。用 "|" 是安全的：所有 key 欄位都被上面的 regex 限制成
// 英數字與 _ . -（scope / site 更只允許 both / orderWeb / menuWeb），
// 值本身永遠不含 "|"，所以不可能讓兩組不同的複合鍵撞成同一個字串。
var MENU_WRITE_KEY_SEP = '|';

function menuWriteKeyFromCells(spec, cells) {
  return spec.keyFields.map(function (field) {
    var idx = spec.headers.indexOf(field);
    var raw = menuWriteText(cells[idx]);
    // Settings 的 scope 空白 = both（跟 Menu.gs 的 buildLandingData 同一個規則）
    if ((field === 'scope' || field === 'site') && raw === '') raw = 'both';
    return raw;
  }).join(MENU_WRITE_KEY_SEP);
}

function menuWriteKeyLabel(key) {
  return String(key).split(MENU_WRITE_KEY_SEP).join(' / ');
}


/* ═════════════════════════════
   驗證 + 正規化 payload
   ═════════════════════════════ */

// 這一列（試算表上的既有列）是不是 menuWeb 專屬 = orderWeb 後台唯讀。
// 一律看試算表現值，不看 payload 說自己是誰。
// ItemCategories 沒有自己的 site 欄，它的 locked 是繼承分類的，
// 在 menuWriteResolveGuards 才算得出來，所以這裡回 false。
function menuWriteIsLockedRow(spec, sheetRow) {
  if (!sheetRow) return false;                       // 新增的列沒有「原值」可保留
  if (!spec.guard || spec.guard === 'inheritCategory') return false;
  var idx = spec.headers.indexOf(spec.guard.field);
  return (menuWriteText(sheetRow.values[idx]) || 'both') === MENU_WRITE_LOCKED_SITE;
}

function menuWriteParseTable(name, spec, rawRows, sheetData, errors) {
  var out = { name: name, rows: [], byKey: {} };

  if (!Array.isArray(rawRows)) {
    errors.push('tables.' + name + ' 必須是陣列');
    return out;
  }
  // 本輪空陣列一律拒絕。空陣列有兩種可能意思（真的要刪掉全部 / 前端出 bug），
  // 分不出來就不要動資料。
  if (!rawRows.length) {
    errors.push('tables.' + name + ' 是空陣列。本輪不接受清空整張表，' +
      '如果只是不想動這張表，請不要帶這個 key');
    return out;
  }
  if (rawRows.length > MENU_WRITE_MAX_ROWS) {
    errors.push('tables.' + name + ' 有 ' + rawRows.length + ' 列，超過上限 ' + MENU_WRITE_MAX_ROWS);
    return out;
  }

  rawRows.forEach(function (raw, i) {
    var at = name + '[' + i + ']';

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(at + ' 必須是物件（欄位名 → 值），不是陣列或純值');
      return;
    }

    // 不接受未知欄位。欄名只能出現在該表的 MENU_*_HEADERS 裡。
    Object.keys(raw).forEach(function (field) {
      if (!spec.fields[field]) {
        errors.push(at + ' 有未知欄位 "' + field + '"（' + spec.sheetName +
          ' 只有 ' + spec.headers.join(', ') + '）');
      }
    });

    // 先把 key 欄位挑出來驗證，後面的錯誤訊息才有東西可以指
    var keyParts = [];
    var keyOk = true;
    spec.keyFields.forEach(function (field) {
      var value = menuWriteText(raw[field]);
      if ((field === 'scope' || field === 'site') && value === '') value = 'both';
      if (value === '') {
        errors.push(at + ' 的 ' + field + ' 不可空白（這是 stable key）');
        keyOk = false;
      }
      keyParts.push(value);
    });
    if (!keyOk) return;

    var key = keyParts.join(MENU_WRITE_KEY_SEP);
    if (out.byKey[key]) {
      errors.push(at + ' 的 key 重複：' + menuWriteKeyLabel(key) +
        '（' + spec.keyFields.join(' + ') + ' 必須唯一）');
      return;
    }

    // 逐欄正規化成「準備寫進儲存格的值」
    var row = {
      index: i,
      key: key,
      at: at,
      raw: raw,
      values: {},        // field → 要寫入的值
      isNew: !sheetData.byKey[key]
    };

    // menuWeb 專屬的既有列（locked）：內容一律保留試算表原值，
    // 所以連驗證都不做。這一點很重要 —— 後台的 snapshot 本來就會包含這些列，
    // 如果連它們的內容也一起驗證，menuWeb 那邊某個欄位的值只要不符合
    // orderWeb 這邊的型別規則，每一次儲存都會整批失敗。
    row.locked = menuWriteIsLockedRow(spec, sheetData.byKey[key]);
    if (row.locked) {
      out.rows.push(row);
      out.byKey[key] = row;
      return;
    }

    spec.headers.forEach(function (field) {
      var kind = spec.fields[field];
      if (kind === 'managed') {
        // payload 可以帶（menuRaw 原封送回時就會帶 updatedAt），但值一律忽略
        return;
      }
      var result = menuWriteNormalize(kind, raw[field], row, spec);
      if (result.error) {
        errors.push(at + '.' + field + ' ' + result.error);
        return;
      }
      row.values[field] = result.value;
    });

    // 必填
    spec.required.forEach(function (field) {
      var v = row.values[field];
      if (v === null || v === undefined || menuWriteText(v) === '') {
        errors.push(at + '.' + field + ' 不可空白');
      }
    });

    // Settings 的 value 要跟 type 相符（type 已經在上面驗過合法值）
    if (name === 'settings') {
      var typeErr = menuWriteCheckSettingValue(row);
      if (typeErr) errors.push(at + '.value ' + typeErr);

      if (MENU_WRITE_SETTING_KEY_BLOCKLIST.indexOf(row.values.key) >= 0) {
        errors.push(at + '.key 不允許寫入 Settings：' + row.values.key +
          '（前台送單／取菜單的網址留在各站的 config.js 管理，' +
          '寫成 Settings 會讓網址改由 Sheets 決定）');
      }
    }

    out.rows.push(row);
    out.byKey[key] = row;
  });

  return out;
}

function menuWriteNormalize(kind, raw, row, spec) {
  switch (kind) {
    case 'text':
      return { value: menuWriteText(raw) };

    case 'idText': {
      var id = menuWriteText(raw);
      if (id === '') return { value: '' };
      if (!MENU_WRITE_ID_RE.test(id)) {
        return { error: '格式不合：「' + id + '」（只允許英數字與 _ . -，最長 40 字）' };
      }
      return { value: id };
    }

    case 'catKeyText': {
      var ck = menuWriteText(raw);
      if (ck === '') return { value: '' };
      if (!MENU_WRITE_CATKEY_RE.test(ck)) {
        return { error: '格式不合：「' + ck + '」（小寫字母開頭，只允許小寫英數字與 _）' };
      }
      return { value: ck };
    }

    case 'setKeyText': {
      var sk = menuWriteText(raw);
      if (sk === '') return { value: '' };
      if (!MENU_WRITE_SETKEY_RE.test(sk)) {
        return { error: '格式不合：「' + sk + '」（英文字母開頭，只允許英數字與 _）' };
      }
      return { value: sk };
    }

    case 'numberOrBlank': {
      var s = menuWriteText(raw);
      if (s === '') return { value: null };
      var n = Number(s);
      if (!isFinite(n)) return { error: '不是數字：「' + s + '」' };
      if (n < 0) return { error: '不可為負數：' + n };
      return { value: n };
    }

    case 'sortOrder': {
      var ss = menuWriteText(raw);
      // 空白 → 0（跟 Menu.gs 的 menuNumber 同一個結果）
      if (ss === '') return { value: 0 };
      var sn = Number(ss);
      if (!isFinite(sn)) return { error: '不是數字：「' + ss + '」' };
      return { value: sn };
    }

    case 'bool': {
      var b = menuWriteBool(raw);
      if (b === null) {
        return { error: '必須是 boolean（true / false），收到：' + JSON.stringify(raw) };
      }
      return { value: b };
    }

    case 'temp': {
      var t = menuWriteText(raw);
      if (MENU_WRITE_TEMP_VALUES.indexOf(t) < 0) {
        return { error: '只允許 ' + MENU_WRITE_TEMP_VALUES.map(function (v) {
          return v === '' ? '(空白)' : v;
        }).join(' / ') + '，收到：「' + t + '」' };
      }
      return { value: t };
    }

    case 'site': {
      var st = menuWriteText(raw);
      if (st === '') st = 'both';
      if (st === MENU_WRITE_LOCKED_SITE) {
        // 既有的 menuWeb 列會在 guard 那一關被判成 locked 並保留原值；
        // 這裡擋的是「新增一列 menuWeb」與「把既有列改成 menuWeb」。
        // 真正的判斷需要知道這一列是新的還是舊的，所以標記起來交給 guard。
        return { value: st };
      }
      if (MENU_WRITE_ALLOWED_SITES.indexOf(st) < 0) {
        return { error: '只允許 ' + MENU_WRITE_ALLOWED_SITES.join(' / ') +
          '（空白視為 both），收到：「' + st + '」' };
      }
      return { value: st };
    }

    case 'settingType': {
      var ty = menuWriteText(raw).toLowerCase();
      if (ty === '') ty = 'text';
      if (MENU_WRITE_SETTING_TYPES.indexOf(ty) < 0) {
        return { error: '只允許 ' + MENU_WRITE_SETTING_TYPES.join(' / ') + '，收到：「' + ty + '」' };
      }
      return { value: ty };
    }

    case 'settingValue': {
      // type=list 的儲存格是「一行一個」的多行字串。
      // 為了讓後台可以直接送陣列（tableNumbers 在 landingData 裡就是陣列），
      // 這裡接受陣列並接回多行字串。
      if (Array.isArray(raw)) {
        return { value: raw.map(function (v) { return menuWriteText(v); })
          .filter(function (v) { return v !== ''; }).join('\n') };
      }
      if (typeof raw === 'boolean') return { value: raw };
      if (typeof raw === 'number') {
        if (!isFinite(raw)) return { error: '不是有效數字' };
        return { value: raw };
      }
      var sv = String(raw == null ? '' : raw);
      // 前後空白拿掉，但中間的換行要留著（list 與多行 desc 都靠它）
      return { value: sv.replace(/^[ \t]+|[ \t]+$/g, '') };
    }

    default:
      return { error: '（內部錯誤：未知的欄位型別 ' + kind + '）' };
  }
}

// Settings.value 與 type 的相符檢查
function menuWriteCheckSettingValue(row) {
  var type  = row.values.type;
  var value = row.values.value;

  if (type === 'boolean') {
    if (menuWriteBool(value) === null) {
      return '在 type=boolean 之下必須是 true / false，收到：' + JSON.stringify(value);
    }
    return null;
  }
  if (type === 'number') {
    var s = menuWriteText(value);
    if (s === '') return null;   // 空白 = 沒設定，settingValue() 會回 null
    if (!isFinite(Number(s))) return '在 type=number 之下不是數字：「' + s + '」';
    return null;
  }
  // text / list 什麼字串都可以
  return null;
}

// 只接受真正的 boolean，以及「Menu.gs 的 menuToBool 讀得懂的儲存格字面值」。
// 後者是必要的：menuRaw 會把試算表現值原封回傳，如果某個 cell 是文字 "TRUE"
// 而不是勾選框，前端把它原封送回來時不該被判成非法。
// 其他任何值（數字、物件、'yes maybe'…）一律拒絕。
function menuWriteBool(raw) {
  if (raw === true)  return true;
  if (raw === false) return false;
  var s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (s === '') return false;
  if (s === 'true'  || s === 'yes' || s === 'y' || s === '1' || s === 'v') return true;
  if (s === 'false' || s === 'no'  || s === 'n' || s === '0') return false;
  return null;
}

function menuWriteText(raw) {
  return String(raw == null ? '' : raw).trim();
}

// 錯誤物件轉可讀文字。不要只用 String(err) —— 有些執行環境會給出
// 「[object Error]」，真正的原因就看不到了。
function menuWriteErrorText(err) {
  if (!err) return 'unknown error';
  if (err.message) return String(err.message);
  return String(err);
}


/* ═════════════════════════════
   scope / site 防守

   規則一律看「試算表上這一列現在的值」，不看 payload 說自己是誰：
     ① 既有列的 scope/site 是 menuWeb → locked：不覆蓋、不刪除
     ② 新增列的 scope/site 是 menuWeb → 拒絕（不允許新增 menuWeb 專屬資料）
     ③ 既有列現在不是 menuWeb，但 payload 想改成 menuWeb → 拒絕
        （那等於把資料藏起來，同時讓自己以後改不到它，一按就回不去）
   ═════════════════════════════ */

function menuWriteResolveGuards(order, specs, parsed, sheets, errors) {
  order.forEach(function (name) {
    var spec = specs[name];
    if (!spec.guard || spec.guard === 'inheritCategory') return;

    var field = spec.guard.field;
    var idx   = spec.headers.indexOf(field);

    // 既有列：試算表現值決定 locked
    sheets[name].rows.forEach(function (sheetRow) {
      var current = menuWriteText(sheetRow.values[idx]) || 'both';
      sheetRow.locked = (current === MENU_WRITE_LOCKED_SITE);
    });

    // payload 的列
    parsed[name].rows.forEach(function (row) {
      // locked 的列在 parse 階段就已經標記好了，內容一律保留原值 ——
      // 「不允許改成 menuWeb」對它沒有意義（它本來就是 menuWeb）
      if (row.locked) return;

      var wanted = row.values[field];
      var sheetRow = sheets[name].byKey[row.key];

      if (!sheetRow) {
        // ② 新增
        if (wanted === MENU_WRITE_LOCKED_SITE) {
          errors.push(row.at + '.' + field + ' 不允許新增 ' + MENU_WRITE_LOCKED_SITE +
            ' 專屬的列（' + menuWriteKeyLabel(row.key) + '）');
        }
        return;
      }

      row.locked = !!sheetRow.locked;

      // ③ 既有列想改成 menuWeb
      if (!sheetRow.locked && wanted === MENU_WRITE_LOCKED_SITE) {
        errors.push(row.at + '.' + field + ' 不允許把既有的列改成 ' + MENU_WRITE_LOCKED_SITE +
          '（' + menuWriteKeyLabel(row.key) + '，目前是 ' +
          (menuWriteText(sheetRow.values[idx]) || 'both') + '）');
      }
    });
  });

  // ItemCategories 沒有自己的 site 欄，它繼承分類的。
  // 分類是 menuWeb 專屬時，連到它的連結列也不該被 orderWeb 後台動到 ——
  // 否則等於可以改 menuWeb 的排版。
  if (order.indexOf('itemCategories') >= 0) {
    var lockedCats = menuWriteLockedCategoryKeys(specs, parsed, sheets);

    sheets.itemCategories.rows.forEach(function (sheetRow) {
      var catIdx = specs.itemCategories.headers.indexOf('categoryKey');
      sheetRow.locked = !!lockedCats[menuWriteText(sheetRow.values[catIdx])];
    });

    parsed.itemCategories.rows.forEach(function (row) {
      if (lockedCats[row.values.categoryKey]) {
        row.locked = true;
      }
    });
  }
}

// 目前的分類（寫入後的狀態）裡，哪些是 menuWeb 專屬的。
// 現況五個分類全部是 site=both，所以這個結果目前是空的 —— 但規則要先在。
function menuWriteLockedCategoryKeys(specs, parsed, sheets) {
  var locked = {};
  var spec   = specs.categories;
  var siteIdx = spec.headers.indexOf('site');
  var keyIdx  = spec.headers.indexOf('key');

  var sheetCats = sheets.categories;
  if (sheetCats) {
    sheetCats.rows.forEach(function (sheetRow) {
      var site = menuWriteText(sheetRow.values[siteIdx]) || 'both';
      if (site === MENU_WRITE_LOCKED_SITE) locked[menuWriteText(sheetRow.values[keyIdx])] = true;
    });
  } else {
    // payload 沒有帶 categories 這張表 → 讀一次試算表來判斷
    var read = menuWriteReadSheet(spec);
    if (!read.error) {
      read.rows.forEach(function (sheetRow) {
        var site = menuWriteText(sheetRow.values[siteIdx]) || 'both';
        if (site === MENU_WRITE_LOCKED_SITE) locked[menuWriteText(sheetRow.values[keyIdx])] = true;
      });
    }
  }
  return locked;
}


/* ═════════════════════════════
   跨表參照

   比對的基準是「寫入後的狀態」：payload 有帶的表用 payload 的內容，
   沒帶的表用試算表現值。只看 payload 會誤判，只看試算表也會誤判。
   ═════════════════════════════ */

function menuWriteCheckReferences(specs, parsed, sheets, errors) {
  if (!parsed.itemCategories) return;

  var itemIds = menuWritePostWriteKeys('items', specs, parsed, sheets, 'id');
  var catKeys = menuWritePostWriteKeys('categories', specs, parsed, sheets, 'key');

  parsed.itemCategories.rows.forEach(function (row) {
    if (!itemIds[row.values.itemId]) {
      errors.push(row.at + '.itemId 指向不存在的商品：' + row.values.itemId +
        '（寫入後的 Items 裡沒有這個 id，這一列連結會被前台直接忽略）');
    }
    if (!catKeys[row.values.categoryKey]) {
      errors.push(row.at + '.categoryKey 指向不存在的分類：' + row.values.categoryKey);
    }
  });
}

// 某張表在「寫入後」會有哪些 key。
//   payload 有帶這張表 → payload 的 key（＋ locked 的既有列，它們不會被刪掉）
//   payload 沒帶       → 試算表現有的 key（整張表不會被動到）
function menuWritePostWriteKeys(name, specs, parsed, sheets, field) {
  var spec = specs[name];
  var idx  = spec.headers.indexOf(field);
  var out  = {};

  if (parsed[name]) {
    parsed[name].rows.forEach(function (row) {
      out[row.values[field]] = true;
    });
    sheets[name].rows.forEach(function (sheetRow) {
      if (sheetRow.locked) out[menuWriteText(sheetRow.values[idx])] = true;
    });
    return out;
  }

  var read = menuWriteReadSheet(spec);
  if (!read.error) {
    read.rows.forEach(function (sheetRow) {
      out[menuWriteText(sheetRow.values[idx])] = true;
    });
  }
  return out;
}


/* ═════════════════════════════
   差異比對（算出計畫，不執行）
   ═════════════════════════════ */

function menuWritePlanTable(spec, parsedTable, sheetData) {
  var plan = {
    sheetName: spec.sheetName,
    counts: { updated: 0, added: 0, deleted: 0, skipped: 0, unchanged: 0 },
    updates: [],     // { rowNumber, key, fields:[{field, from, to}], values }
    adds: [],        // { key, values }
    deletes: [],     // { rowNumber, key }
    entries: [],     // 給人看的摘要
    warnings: []
  };

  var seen = {};

  /* ── payload 有的列：更新或新增 ── */
  parsedTable.rows.forEach(function (row) {
    seen[row.key] = true;
    var sheetRow = sheetData.byKey[row.key];

    if (!sheetRow) {
      plan.counts.added++;
      plan.adds.push({ key: row.key, values: row.values });
      plan.entries.push({
        table: parsedTable.name, op: 'add', key: menuWriteKeyLabel(row.key)
      });
      return;
    }

    // locked 的列永遠不寫。內容一樣就當成 unchanged（不必吵），
    // 內容不一樣才回報 skipped —— 讓後台知道「你的這個修改沒有生效」。
    // 比對用的是 payload 的原始值：locked 的列在 parse 階段刻意沒有做正規化。
    if (row.locked) {
      var attempted = menuWriteRawDiffRow(spec, row, sheetRow);
      if (attempted.length) {
        plan.counts.skipped++;
        plan.entries.push({
          table: parsedTable.name, op: 'skip', key: menuWriteKeyLabel(row.key),
          row: sheetRow.rowNumber,
          reason: 'locked: ' + MENU_WRITE_LOCKED_SITE + ' 專屬，保留原值',
          fields: attempted
        });
      } else {
        plan.counts.unchanged++;
      }
      return;
    }

    var changed = menuWriteDiffRow(spec, row, sheetRow);

    if (!changed.length) {
      plan.counts.unchanged++;
      return;
    }

    plan.counts.updated++;
    plan.updates.push({
      rowNumber: sheetRow.rowNumber, key: row.key,
      fields: changed, values: row.values,
      // 讀取當時的儲存格原值。寫入時是「從原值出發、只覆蓋有差異的欄位」，
      // 這樣沒被編輯到的欄位（含 identity）保證原封不動。
      sheetValues: sheetRow.values
    });
    plan.entries.push({
      table: parsedTable.name, op: 'update', key: menuWriteKeyLabel(row.key),
      row: sheetRow.rowNumber,
      fields: changed.map(function (c) {
        return { field: c.field, from: menuWriteBrief(c.from), to: menuWriteBrief(c.to) };
      })
    });
  });

  /* ── 試算表有、payload 沒有的列：刪除（locked 例外） ── */
  sheetData.rows.forEach(function (sheetRow) {
    if (seen[sheetRow.key]) return;

    if (sheetRow.locked) {
      plan.counts.skipped++;
      plan.entries.push({
        table: parsedTable.name, op: 'skip', key: menuWriteKeyLabel(sheetRow.key),
        row: sheetRow.rowNumber,
        reason: 'locked: ' + MENU_WRITE_LOCKED_SITE + ' 專屬，不隨 payload 刪除'
      });
      return;
    }

    plan.counts.deleted++;
    plan.deletes.push({ rowNumber: sheetRow.rowNumber, key: sheetRow.key });
    plan.entries.push({
      table: parsedTable.name, op: 'delete', key: menuWriteKeyLabel(sheetRow.key),
      row: sheetRow.rowNumber
    });
  });

  /* ── Banners 的 sortOrder 是一條全域順序，撞號時排序只能退回列序 ── */
  if (spec.sheetName === MENU_SHEET_BANNERS || spec.sheetName === MENU_SHEET_CATEGORIES) {
    var used = {};
    parsedTable.rows.forEach(function (row) {
      var n = row.values.sortOrder;
      if (used[n]) {
        // 既有資料本來就可能撞號，硬擋會讓人存不了 → 只警告
        plan.warnings.push(spec.sheetName + ' 的 sortOrder ' + n + ' 重複，排序結果會退回列序');
      }
      used[n] = true;
    });
  }

  return plan;
}

// 回傳真的有變化的欄位。identity 與 managed 欄位不參與（前者相等是 key 的定義，
// 後者由 GAS 自己管），所以既有列的 id / key / scope 這幾格永遠不會被改寫。
function menuWriteDiffRow(spec, row, sheetRow) {
  var changed = [];

  spec.headers.forEach(function (field) {
    if (spec.identity.indexOf(field) >= 0) return;
    if (spec.managed.indexOf(field) >= 0) return;
    if (!(field in row.values)) return;

    var idx = spec.headers.indexOf(field);
    var to   = row.values[field];
    var from = sheetRow.values[idx];

    if (!menuWriteCellEquals(to, from)) {
      changed.push({ field: field, from: from, to: to });
    }
  });

  return changed;
}

// locked 的列用這一支：直接拿 payload 的原始值跟儲存格比，
// 只是為了回報「你這個修改沒有生效」，所以不需要正規化，
// 也不需要在意型別（那些值永遠不會被寫進去）。
function menuWriteRawDiffRow(spec, row, sheetRow) {
  var fields = [];

  spec.headers.forEach(function (field) {
    if (spec.identity.indexOf(field) >= 0) return;
    if (spec.managed.indexOf(field) >= 0) return;
    if (!(field in row.raw)) return;

    var idx = spec.headers.indexOf(field);
    if (!menuWriteCellEquals(row.raw[field], sheetRow.values[idx])) fields.push(field);
  });

  return fields;
}

// 「準備寫入的值」跟「儲存格現值」算不算同一個值。
// 刻意寬鬆：勾選框的 true 與文字 "TRUE"、數字 150 與文字 "150" 都算相同，
// 否則每次儲存都會產生一堆沒有意義的更新。
function menuWriteCellEquals(writeValue, sheetValue) {
  if (typeof writeValue === 'boolean') {
    return menuToBool(sheetValue) === writeValue;
  }
  if (typeof writeValue === 'number') {
    var s = menuWriteText(sheetValue);
    if (s === '') return false;
    return Number(s) === writeValue;
  }
  if (writeValue === null || writeValue === undefined) {
    return menuWriteText(sheetValue) === '';
  }
  // 多行字串的換行要保留，只比對去掉頭尾空白後的內容
  var a = String(writeValue).replace(/^\s+|\s+$/g, '');
  var b = String(sheetValue == null ? '' : sheetValue).replace(/^\s+|\s+$/g, '');
  return a === b;
}

function menuWriteBrief(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (value instanceof Date) return value.toISOString();
  var s = String(value).replace(/\r?\n/g, '⏎');
  return s.length > 60 ? s.substring(0, 60) + '…' : s;
}


/* ═════════════════════════════
   寫入前的最後一道確認

   第二階段真的寫入時這一關最重要 —— 前面的表寫完之後才發現後面的表有問題，
   是最糟的情況。所以每一張表動手之前都再確認一次。
   ═════════════════════════════ */

function menuWriteAssertPlan(spec, plan) {
  var errors = [];

  // 動手的對象只能是這五張表（再確認一次，不信任呼叫端）
  try {
    var sheet = menuWriteGetSheet(spec.sheetName);
    if (!sheet) errors.push('找不到工作表：' + spec.sheetName);
  } catch (err) {
    errors.push(String(err));
  }

  // 要更新的列一定要有列號，而且不可以指到標題列
  plan.updates.forEach(function (u) {
    if (!(u.rowNumber >= 2)) {
      errors.push(spec.sheetName + ' 的更新目標列號不合法：' + u.rowNumber);
    }
    // 更新是「原值 + 覆蓋有差異的欄位」，所以一定要有讀取當時的原值，
    // 而且長度必須剛好等於表頭 —— 少一格就會讓整列往左位移
    if (!u.sheetValues || u.sheetValues.length !== spec.headers.length) {
      errors.push(spec.sheetName + ' 第 ' + u.rowNumber + ' 列缺少原值或欄數不符（預期 ' +
        spec.headers.length + '，實際 ' + (u.sheetValues ? u.sheetValues.length : 'none') + '）');
    }
    if (!u.fields || !u.fields.length) {
      errors.push(spec.sheetName + ' 第 ' + u.rowNumber + ' 列被列為更新，但沒有任何有差異的欄位');
      return;
    }
    // identity 欄位不該出現在要寫入的欄位裡
    u.fields.forEach(function (c) {
      if (spec.identity.indexOf(c.field) >= 0) {
        errors.push(spec.sheetName + ' 想改寫 stable key 欄位 ' + c.field + '，已中止');
      }
      if (spec.managed.indexOf(c.field) >= 0) {
        errors.push(spec.sheetName + ' 想改寫 GAS 自管欄位 ' + c.field + '，已中止');
      }
      if (spec.headers.indexOf(c.field) < 0) {
        errors.push(spec.sheetName + ' 想寫入不存在的欄位 ' + c.field + '，已中止');
      }
    });
  });

  // 新增的列：每一個 identity 欄位都要有值，否則會寫出一列沒有身分的資料
  plan.adds.forEach(function (a) {
    spec.identity.forEach(function (field) {
      if (menuWriteText(a.values[field]) === '') {
        errors.push(spec.sheetName + ' 要新增的列缺少 ' + field + '（key=' +
          menuWriteKeyLabel(a.key) + '），已中止');
      }
    });
  });

  plan.deletes.forEach(function (d) {
    if (!(d.rowNumber >= 2)) {
      errors.push(spec.sheetName + ' 的刪除目標列號不合法：' + d.rowNumber);
    }
  });

  return errors;
}


/* ═════════════════════════════
   真正寫入一張表

   完全照 menuWritePlanTable() 算出來的計畫走，不做任何額外判斷 ——
   計畫裡沒有的列，這裡不會碰到。所以「locked 的列」「payload 沒帶的表」
   「內容完全相同的列」一律不會產生任何寫入。

   ⚠ 絕對不整張表清空重寫。整張重寫會弄掉 menuWeb 專屬的列、表頭右邊的
     額外欄位、以及手寫的 note —— 這正是當初否決「每次整張表重寫」的原因。

   三個動作的順序是有理由的：
     ① 先 update：用的是「讀取當時的原始列號」，這時候還沒有任何列被刪掉，
        列號才是對的。
     ② 再 delete：由下往上刪，還沒處理的列號才不會位移；連續的列合併成
        一次呼叫（跟 Code.gs 的 handleClearToday 同一個做法）。用 deleteRows
        而不是清空內容，整列一起搬移，表頭右邊的額外欄位與格式才不會錯位。
     ③ 最後 append：刪完之後才取 getLastRow()，新列才會接在正確的位置。
   ═════════════════════════════ */

function menuWriteApplyTable(spec, plan, sheetData) {
  // 第二道獨立的保險。saveMenuLocked() 已經檢查過一次 MENU_WRITE_ENABLED，
  // 這裡再檢查一次 —— 任何繞過那個 if 的呼叫路徑（包含日後手動在編輯器裡
  // 直接呼叫這一支）都會在寫任何 cell 之前就中止。
  if (!MENU_WRITE_ENABLED) {
    throw new Error('MENU_WRITE_ENABLED is false — refusing to write ' + spec.sheetName);
  }

  // 工作表名稱只能是那五張。這一步已經在 assert 過一次，這裡是最後一道。
  var sheet = menuWriteGetSheet(spec.sheetName);
  if (!sheet) throw new Error('找不到工作表：' + spec.sheetName);

  // 欄數不夠的話先補欄，否則 getRange 會直接報錯（跟 Code.gs 的 getOrCreateSheet 同一個處理）
  var maxColumns = sheet.getMaxColumns();
  if (maxColumns < spec.headers.length) {
    sheet.insertColumnsAfter(maxColumns, spec.headers.length - maxColumns);
  }

  var stamp = new Date();

  menuWriteApplyUpdates(sheet, spec, plan, stamp);
  menuWriteApplyDeletes(sheet, spec, plan);
  menuWriteApplyAdds(sheet, spec, plan, stamp);

  // 把這一張表的變更真的送出去，不要留在 GAS 的批次佇列裡。
  // 中途失敗時 completed[] 回報的內容才跟試算表的實際狀態一致。
  SpreadsheetApp.flush();
}

/* ── ① 更新 ──
   每一列都從「讀取當時的儲存格原值」開始，只覆蓋計畫裡列出有差異的欄位。
   沒有差異的欄位是原值寫回原值，identity 欄位（id / key / scope）也因此
   永遠保持原樣 —— 這是「不允許修改 stable identity」在寫入層的落實。 */
function menuWriteApplyUpdates(sheet, spec, plan, stamp) {
  if (!plan.updates.length) return;

  var width = spec.headers.length;
  var touchIdx = spec.touchOnChange ? spec.headers.indexOf(spec.touchOnChange) : -1;

  var rows = plan.updates.map(function (update) {
    var values = update.sheetValues.slice();      // 原值
    update.fields.forEach(function (change) {
      values[spec.headers.indexOf(change.field)] = menuWriteCellValue(change.to);
    });
    // Items 的 updatedAt：只有這一列真的有欄位變更時才更新（有變更才會走到這裡）
    if (touchIdx >= 0) values[touchIdx] = stamp;
    return { rowNumber: update.rowNumber, values: values };
  }).sort(function (a, b) { return a.rowNumber - b.rowNumber; });

  // 連續的列合併成一次 setValues。整批改 23 個商品時是 1 次呼叫而不是 23 次。
  var i = 0;
  while (i < rows.length) {
    var j = i;
    while (j + 1 < rows.length && rows[j + 1].rowNumber === rows[j].rowNumber + 1) j++;
    var block = rows.slice(i, j + 1).map(function (r) { return r.values; });
    sheet.getRange(rows[i].rowNumber, 1, block.length, width).setValues(block);
    i = j + 1;
  }
}

/* ── ② 刪除 ──
   由下往上，連續的列合併成一次 deleteRows。 */
function menuWriteApplyDeletes(sheet, spec, plan) {
  if (!plan.deletes.length) return;

  var targets = plan.deletes.map(function (d) { return d.rowNumber; })
    .sort(function (a, b) { return a - b; });

  var end = targets.length - 1;
  while (end >= 0) {
    var start = end;
    while (start > 0 && targets[start - 1] === targets[start] - 1) start--;
    sheet.deleteRows(targets[start], end - start + 1);
    end = start - 1;
  }
}

/* ── ③ 新增 ──
   接在最後一列之後，一次寫完。 */
function menuWriteApplyAdds(sheet, spec, plan, stamp) {
  if (!plan.adds.length) return;

  var width = spec.headers.length;
  var touchIdx = spec.touchOnChange ? spec.headers.indexOf(spec.touchOnChange) : -1;

  var rows = plan.adds.map(function (add) {
    var values = spec.headers.map(function (field) {
      return menuWriteCellValue(add.values[field]);
    });
    if (touchIdx >= 0) values[touchIdx] = stamp;
    return values;
  });

  // 刪除已經做完了，這時候的 getLastRow() 才是正確的接續位置
  var startRow = sheet.getLastRow() + 1;

  // 列數不夠就先補列，否則 getRange 會超出範圍
  var needed = startRow + rows.length - 1;
  var maxRows = sheet.getMaxRows();
  if (maxRows < needed) sheet.insertRowsAfter(maxRows, needed - maxRows);

  sheet.getRange(startRow, 1, rows.length, width).setValues(rows);
}

// 把正規化後的值轉成「可以直接放進儲存格」的形式。
// null（例如空白的 price）要寫成空字串 —— 寫 null 進 setValues 會被當成
// 「不要動這一格」，那樣就清不掉舊值了。
function menuWriteCellValue(value) {
  if (value === null || value === undefined) return '';
  return value;
}


/* ═════════════════════════════
   在編輯器裡直接跑的 dryRun 測試（不必部署、不會寫入）

   函式選單選 menuWriteSelfTest → 執行 → 看「執行紀錄」。
   它拿現在試算表的真實資料當 payload，跑完下面每一組情境並自我檢查。
   ═════════════════════════════ */

function menuWriteSelfTest() {
  var raw = buildMenuRawPayload();
  var lines = [];
  var fails = 0;

  function say(s) { lines.push(s); }

  // 每次都從試算表的原始資料複製一份新的，情境之間不會互相污染
  function snap() {
    return JSON.parse(JSON.stringify({
      items:          raw.items,
      itemCategories: raw.itemCategories,
      categories:     raw.categories,
      settings:       raw.settings,
      banners:        raw.banners
    }));
  }

  function check(label, cond, detail) {
    if (cond) {
      say('   ✓ ' + label);
    } else {
      fails++;
      say('   ✗ FAIL ' + label + (detail ? ' —— ' + detail : ''));
    }
  }

  function run(label, tables) {
    say('');
    say('───── ' + label + ' ─────');
    var r;
    try {
      r = saveMenuResult({ action: 'saveMenu', site: 'orderWeb',
        token: menuWriteStoredToken(), tables: tables });
    } catch (err) {
      r = { ok: false, error: 'THREW: ' + err, errors: [String(err)] };
    }
    say('ok=' + r.ok + '  dryRun=' + r.dryRun);
    Object.keys(r.written || {}).forEach(function (t) {
      var c = r.written[t];
      say('  ' + t + '：updated=' + c.updated + ' added=' + c.added +
        ' deleted=' + c.deleted + ' skipped=' + c.skipped + ' unchanged=' + c.unchanged);
    });
    (r.plan || []).forEach(function (e) {
      say('  · ' + e.op + ' ' + e.table + ' [' + e.key + ']' +
        (e.row ? ' row=' + e.row : '') +
        (e.reason ? ' ← ' + e.reason : '') +
        (e.fields ? ' ' + JSON.stringify(e.fields) : ''));
    });
    (r.errors   || []).forEach(function (x) { say('  ✗ ' + x); });
    (r.warnings || []).forEach(function (w) { say('  ⚠ ' + w); });
    return r;
  }

  function counts(r, table) {
    if (r.written && r.written[table]) return r.written[table];
    return { updated: -1, added: -1, deleted: -1, skipped: -1, unchanged: -1 };
  }
  function total(r, field) {
    var n = 0;
    Object.keys(r.written || {}).forEach(function (t) { n += r.written[t][field]; });
    return n;
  }
  // 找出符合條件的第一列，找不到就回 null（試算表資料被改過時測試才不會誤判）
  function findSetting(key, scope) {
    var found = null;
    raw.settings.forEach(function (row) {
      if (found) return;
      var s = String(row.scope == null ? '' : row.scope).trim() || 'both';
      if (String(row.key).trim() === key && s === scope) found = row;
    });
    return found;
  }

  say('試算表現況：items=' + raw.items.length +
    ' itemCategories=' + raw.itemCategories.length +
    ' categories=' + raw.categories.length +
    ' settings=' + raw.settings.length +
    ' banners=' + raw.banners.length);

  /* A. menuRaw 原封不動送回去 */
  var A = run('A｜menuRaw 原封送回', snap());
  check('A 通過驗證', A.ok === true);
  check('A updated=0', total(A, 'updated') === 0, '實際 ' + total(A, 'updated'));
  check('A added=0',   total(A, 'added')   === 0, '實際 ' + total(A, 'added'));
  check('A deleted=0', total(A, 'deleted') === 0, '實際 ' + total(A, 'deleted'));
  check('A 五張表都有回報', Object.keys(A.written).length === 5);

  /* B. 改一個 Banner 的 alt */
  var b = snap();
  b.banners[0].alt = String(b.banners[0].alt || '') + '（測試）';
  var B = run('B｜改 Banner 的 alt', b);
  check('B 通過驗證', B.ok === true);
  check('B banners updated=1', counts(B, 'banners').updated === 1);
  check('B 只有這一筆變更', total(B, 'updated') === 1, '實際 ' + total(B, 'updated'));

  /* C. 改一個商品的 price */
  var c = snap();
  c.items[0].price = Number(c.items[0].price || 0) + 1;
  var C = run('C｜改商品 price', c);
  check('C 通過驗證', C.ok === true);
  check('C items updated=1', counts(C, 'items').updated === 1);
  check('C 只有這一筆變更', total(C, 'updated') === 1, '實際 ' + total(C, 'updated'));

  /* D. 新增一個測試 Banner */
  var d = snap();
  d.banners.push({
    id: 'BNR-TEST', image: 'BANNER FISH-03.jpg', alt: '測試海報',
    sortOrder: 999, active: false, site: 'orderWeb'
  });
  var D = run('D｜新增 Banner', d);
  check('D 通過驗證', D.ok === true);
  check('D banners added=1', counts(D, 'banners').added === 1);
  check('D 沒有任何刪除', total(D, 'deleted') === 0);

  /* E. 故意改 scope=menuWeb 的 Settings（文字欄位） */
  var eRow = findSetting('cardName', 'menuWeb');
  if (!eRow) {
    say('');
    say('───── E｜跳過：Settings 沒有 cardName / menuWeb 這一列 ─────');
  } else {
    var e = snap();
    e.settings.forEach(function (row) {
      var s = String(row.scope == null ? '' : row.scope).trim() || 'both';
      if (String(row.key).trim() === 'cardName' && s === 'menuWeb') row.value = '（不該被寫進去）';
    });
    var E = run('E｜改 menuWeb 的 cardName', e);
    check('E 不整批拒絕', E.ok === true);
    check('E settings updated=0', counts(E, 'settings').updated === 0);
    check('E settings skipped=1', counts(E, 'settings').skipped === 1,
      '實際 ' + counts(E, 'settings').skipped);
  }

  /* E2. menuWeb 的列被塞不合法的值 —— 也要是 skipped，不是整批拒絕 */
  var e2Row = findSetting('hideHero', 'menuWeb');
  if (!e2Row) {
    say('');
    say('───── E2｜跳過：Settings 沒有 hideHero / menuWeb 這一列 ─────');
  } else {
    var e2 = snap();
    e2.settings.forEach(function (row) {
      var s = String(row.scope == null ? '' : row.scope).trim() || 'both';
      if (String(row.key).trim() === 'hideHero' && s === 'menuWeb') {
        row.value = '不是 boolean';
        row.type  = 'nonsense';
      }
    });
    var E2 = run('E2｜menuWeb 的列塞不合法的值', e2);
    check('E2 不整批拒絕（locked 的列不驗證內容）', E2.ok === true);
    check('E2 settings updated=0', counts(E2, 'settings').updated === 0);
    check('E2 settings skipped=1', counts(E2, 'settings').skipped === 1,
      '實際 ' + counts(E2, 'settings').skipped);
  }

  /* F. 未知欄位 */
  var f = snap();
  f.items[0].colour = 'red';
  check('F 未知欄位被拒絕', run('F｜未知欄位', f).ok === false);

  /* G. ItemCategories 指向不存在的 itemId */
  var g = snap();
  g.itemCategories[0].itemId = 'ITM-999';
  check('G 連結指向不存在的商品被拒絕', run('G｜itemId 不存在', g).ok === false);

  /* H. 空陣列 */
  var h = snap();
  h.banners = [];
  check('H 空陣列被拒絕', run('H｜空陣列', h).ok === false);

  /* I. 只帶一張表 */
  var I = run('I｜只帶 banners', { banners: snap().banners });
  check('I 通過驗證', I.ok === true);
  check('I 只處理 banners，其他四張表完全不碰',
    Object.keys(I.written).length === 1 && !!I.written.banners);

  /* J. Settings 複合鍵：只改 orderWeb 那一半 */
  var jRow = findSetting('cardName', 'orderWeb');
  if (!jRow) {
    say('');
    say('───── J｜跳過：Settings 沒有 cardName / orderWeb 這一列 ─────');
  } else {
    var j = snap();
    j.settings.forEach(function (row) {
      var s = String(row.scope == null ? '' : row.scope).trim() || 'both';
      if (String(row.key).trim() === 'cardName' && s === 'orderWeb') row.value = '（測試）';
    });
    var J = run('J｜只改 orderWeb 的 cardName', j);
    check('J 通過驗證', J.ok === true);
    check('J settings updated=1（menuWeb 的同名列沒被動到）',
      counts(J, 'settings').updated === 1, '實際 ' + counts(J, 'settings').updated);
    check('J settings skipped=0', counts(J, 'settings').skipped === 0);
  }

  /* K. 把既有分類改成 site=menuWeb */
  var k = snap();
  k.categories[0].site = 'menuWeb';
  check('K 既有分類改成 menuWeb 被拒絕', run('K｜分類改成 menuWeb', k).ok === false);

  /* L. 新增 scope=menuWeb 的 Settings */
  var l = snap();
  l.settings.push({ key: 'newMenuWebOnly', value: 'x', scope: 'menuWeb', type: 'text', note: '' });
  check('L 新增 menuWeb 的設定被拒絕', run('L｜新增 menuWeb 設定', l).ok === false);

  /* M. 想把 orderEndpoint 寫進 Settings */
  var m = snap();
  m.settings.push({ key: 'orderEndpoint', value: 'https://example/exec', scope: 'both', type: 'text', note: '' });
  check('M orderEndpoint 被拒絕', run('M｜寫入 orderEndpoint', m).ok === false);

  /* N. 少送一列 = 刪除 */
  var n = snap();
  var removed = n.banners.pop();
  var N = run('N｜payload 少一個 Banner（' + (removed && removed.id) + '）', n);
  check('N 通過驗證', N.ok === true);
  check('N banners deleted=1', counts(N, 'banners').deleted === 1);

  /* O. boolean 給非法值 */
  var o = snap();
  o.items[0].active = 'maybe';
  check('O active=maybe 被拒絕', run('O｜active=maybe', o).ok === false);

  /* P. price 給非數字 */
  var p = snap();
  p.items[0].price = 'abc';
  check('P price=abc 被拒絕', run('P｜price=abc', p).ok === false);

  /* Q. 未知表名 */
  check('Q 未知表名被拒絕', run('Q｜未知表名 orders', { orders: [{ a: 1 }] }).ok === false);

  /* R. ItemCategories 重複 */
  var r2 = snap();
  r2.itemCategories.push({
    itemId:      r2.itemCategories[0].itemId,
    categoryKey: r2.itemCategories[0].categoryKey,
    sortOrder:   5,
    active:      true
  });
  check('R 重複的連結被拒絕', run('R｜連結重複', r2).ok === false);

  /* S. Items.name 空白 */
  var s2 = snap();
  s2.items[0].name = '   ';
  check('S name 空白被拒絕', run('S｜name 空白', s2).ok === false);

  say('');
  say(fails === 0
    ? '══ 全部檢查通過（dryRun，未寫入任何 cell）══'
    : '══ 有 ' + fails + ' 項檢查未通過 ══');
  say('MENU_WRITE_ENABLED = ' + MENU_WRITE_ENABLED + '（false = 只算計畫，不寫入）');

  var msg = lines.join('\n');
  Logger.log(msg);
  return msg;
}


/* ═════════════════════════════
   一次性的實機寫入測試（會真的改動 Google Sheets）

   在編輯器的函式選單選 menuWriteLiveWriteTest → 執行 → 看「執行紀錄」。

   它做什麼：
     ① 讀 Banners，挑一個 active 且不是 menuWeb 專屬的既有列
     ② 把那一列的 alt 暫時改成「原值 + WRITE_TEST」，真的寫進試算表
     ③ 再用原本的 alt 寫第二次，把它還原
     ④ 重新讀一次，確認 alt 真的回到原值

   它不做什麼：
     不新增、不刪除任何 Banner；完全不碰 Items / ItemCategories /
     Categories / Settings / Orders。只驗證「既有列的 UPDATE」這一條路徑。

   兩道保險：
     ⓐ 每次真的寫入之前，先在 MENU_WRITE_ENABLED=false 之下跑一次同樣的
        payload，確認計畫「只有 banners、而且 updated=1 / added=0 /
        deleted=0 / skipped=0」。不符就直接中止，一個 cell 都不會被寫。
     ⓑ MENU_WRITE_ENABLED 只在真正呼叫的那一瞬間被設成 true，
        內層 finally 立刻還原；外層 finally 再還原一次。
        檔案裡的值永遠是 false，這支函式不會留下任何開著的開關。

   出錯時：盡力還原原始 alt、把開關還原成 false、然後把錯誤重新丟出來
   （不吞掉，你才看得到原因）。

   ⚠ 這是一次性的驗證工具，確認過之後可以整段刪掉，
     刪掉不影響 saveMenu 的任何功能。
   ═════════════════════════════ */

function menuWriteLiveWriteTest() {
  var lines = [];
  // 每一行都立刻寫進執行紀錄 —— 萬一中途丟錯誤，前面的紀錄也已經在了
  function say(s) {
    lines.push(s);
    Logger.log(s);
  }

  var spec      = menuWriteSpecs().banners;
  var idIdx     = spec.headers.indexOf('id');
  var altIdx    = spec.headers.indexOf('alt');
  var siteIdx   = spec.headers.indexOf('site');
  var activeIdx = spec.headers.indexOf('active');

  function readBanners() {
    var read = menuWriteReadSheet(spec);
    if (read.error) throw new Error(read.error);
    return read;
  }

  // Banners 的完整 snapshot。一定要送整張表 ——
  // 少送一列就等於告訴 GAS「請刪掉那一列」。
  function snapshotOf(read) {
    return read.rows.map(function (row) {
      var obj = {};
      spec.headers.forEach(function (h, i) { obj[h] = row.values[i]; });
      return obj;
    });
  }

  function altOnSheet(id) {
    var read = readBanners();
    for (var i = 0; i < read.rows.length; i++) {
      if (menuWriteText(read.rows[i].values[idIdx]) === id) {
        return menuWriteText(read.rows[i].values[altIdx]);
      }
    }
    return null;
  }

  // 計畫必須「只有 Banners 的一筆更新」，否則中止
  function assertPlanIsOneBannerUpdate(label, result, allowNoop) {
    if (!result.ok) {
      // 驗證沒過 → errors；寫入途中爆掉 → failed。兩者要分清楚，
      // 而且要把底層的真正原因原封帶出來，不要只說「失敗了」。
      var why;
      if (result.failed && result.failed.length) {
        why = '寫入失敗 → ' + result.failed.map(function (f) {
          return f.table + '：' + f.error;
        }).join('；');
      } else {
        why = '驗證沒過 → ' + (result.errors || []).join('；');
      }
      throw new Error(label + '：' + why);
    }
    var tables = Object.keys(result.written || {});
    if (tables.length !== 1 || tables[0] !== 'banners') {
      throw new Error(label + '：計畫動到了 Banners 以外的表 → ' + tables.join(', '));
    }
    var c = result.written.banners;
    if (c.added !== 0 || c.deleted !== 0 || c.skipped !== 0) {
      throw new Error(label + '：計畫含有新增／刪除／跳過 → ' + JSON.stringify(c));
    }
    var okUpdated = allowNoop ? (c.updated === 0 || c.updated === 1) : (c.updated === 1);
    if (!okUpdated) {
      throw new Error(label + '：預期 updated=' + (allowNoop ? '0 或 1' : '1') +
        '，實際 ' + c.updated);
    }
    return c;
  }

  // 先預演、確認無誤才真的寫。allowNoop=true 時容許「已經是這個值、不需要改」
  function writeBanners(label, rows, allowNoop) {
    var payload = { action: 'saveMenu', site: 'orderWeb', tables: { banners: rows } };

    // ⓐ 預演：此時 MENU_WRITE_ENABLED 還是 false，saveMenuLocked 只會算計畫
    var preview = saveMenuLocked(payload);
    if (preview.dryRun !== true) {
      throw new Error(label + '：預演階段的 MENU_WRITE_ENABLED 竟然不是 false，已中止');
    }
    var previewCounts = assertPlanIsOneBannerUpdate(label + ' 預演', preview, allowNoop);
    say('  預演：banners updated=' + previewCounts.updated +
      ' added=' + previewCounts.added +
      ' deleted=' + previewCounts.deleted +
      ' skipped=' + previewCounts.skipped +
      ' unchanged=' + previewCounts.unchanged);
    (preview.plan || []).forEach(function (e) {
      say('    · ' + e.op + ' ' + e.table + ' [' + e.key + ']' +
        (e.row ? ' row=' + e.row : '') +
        (e.fields ? ' ' + JSON.stringify(e.fields) : ''));
    });

    if (previewCounts.updated === 0) {
      say('  → 已經是這個值，不需要寫入');
      return preview;
    }

    // ⓑ 只在這一瞬間打開開關，內層 finally 立刻關回去
    var result;
    MENU_WRITE_ENABLED = true;
    try {
      result = saveMenuLocked(payload);
    } finally {
      MENU_WRITE_ENABLED = false;
    }

    if (result.dryRun !== false) {
      throw new Error(label + '：實際寫入時 dryRun 竟然是 ' + result.dryRun);
    }
    assertPlanIsOneBannerUpdate(label + ' 寫入', result, allowNoop);
    if (result.completed.join(',') !== 'banners') {
      throw new Error(label + '：completed 不是只有 banners → ' + result.completed.join(', '));
    }
    if (result.failed.length) {
      throw new Error(label + '：failed → ' + JSON.stringify(result.failed));
    }
    say('  寫入：ok=' + result.ok + ' dryRun=' + result.dryRun +
      ' completed=[' + result.completed.join(',') + ']' +
      ' updated=' + result.written.banners.updated);
    return result;
  }

  var targetId    = null;
  var originalAlt = null;
  var succeeded   = false;

  // 跟正式流程一樣拿 script lock：整個測試期間不會跟建立訂單交錯，
  // 也不會有人在「改掉」跟「還原」之間讀到 WRITE_TEST 之外的怪狀態。
  // saveMenuLocked 本身不拿鎖（拿鎖的是 saveMenuResult），所以這裡不會死鎖。
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);

  try {
    say('══ menuWriteLiveWriteTest 開始 ══');
    say('這支測試會真的寫入 Google Sheets（只改一個既有 Banner 的 alt，之後還原）');
    say('進入時 MENU_WRITE_ENABLED = ' + MENU_WRITE_ENABLED);
    if (MENU_WRITE_ENABLED !== false) {
      throw new Error('進入時 MENU_WRITE_ENABLED 不是 false，請先確認檔案裡的值');
    }

    /* ── ① 挑一個可以動的既有 Banner ── */
    var read = readBanners();
    say('Banners 目前有 ' + read.rows.length + ' 列資料');
    if (!read.rows.length) throw new Error('Banners 沒有任何資料列，沒有東西可以測');

    var target = null;
    for (var i = 0; i < read.rows.length; i++) {
      var row  = read.rows[i];
      var site = menuWriteText(row.values[siteIdx]) || 'both';
      // active 才是前台真的看得到的列；menuWeb 專屬的列是唯讀的，
      // 拿它來測會被 skip，什麼都證明不了。
      if (menuToBool(row.values[activeIdx]) && site !== MENU_WRITE_LOCKED_SITE) {
        target = row;
        break;
      }
    }
    if (!target) {
      throw new Error('Banners 裡找不到「active 且不是 ' + MENU_WRITE_LOCKED_SITE +
        ' 專屬」的列，無法在不改變前台顯示以外的情況下測試');
    }

    targetId    = menuWriteText(target.values[idIdx]);
    originalAlt = menuWriteText(target.values[altIdx]);
    var testAlt = originalAlt + 'WRITE_TEST';

    say('測試目標 Banner id：' + targetId + '（試算表第 ' + target.rowNumber + ' 列）');
    say('原始 alt：「' + originalAlt + '」');
    say('測試用 alt：「' + testAlt + '」');

    /* ── ② 第一次寫入：改成 原值 + WRITE_TEST ── */
    say('');
    say('── 第一次寫入（改成測試值）──');
    var changed = snapshotOf(readBanners());
    changed.forEach(function (r) {
      if (menuWriteText(r.id) === targetId) r.alt = testAlt;
    });
    writeBanners('第一次寫入', changed, false);

    var afterWrite = altOnSheet(targetId);
    say('  重新讀取到的 alt：「' + afterWrite + '」');
    if (afterWrite !== testAlt) {
      throw new Error('第一次寫入後讀回來的 alt 不對，預期「' + testAlt +
        '」，實際「' + afterWrite + '」');
    }
    say('  ✓ 確認測試值已經寫進試算表');

    /* ── ③ 第二次寫入：還原 ── */
    say('');
    say('── 第二次寫入（還原原值）──');
    var restored = snapshotOf(readBanners());
    restored.forEach(function (r) {
      if (menuWriteText(r.id) === targetId) r.alt = originalAlt;
    });
    writeBanners('還原', restored, true);

    var finalAlt = altOnSheet(targetId);
    say('  重新讀取到的 alt：「' + finalAlt + '」');
    if (finalAlt !== originalAlt) {
      throw new Error('還原後讀回來的 alt 不對，預期「' + originalAlt +
        '」，實際「' + finalAlt + '」');
    }
    say('  ✓ 確認已經還原成原值');

    succeeded = true;

  } catch (err) {
    say('');
    say('✗ 測試失敗：' + menuWriteErrorText(err));

    /* 盡力還原。這一段自己包 try/catch —— 還原失敗不可以蓋掉原始錯誤 */
    if (targetId && originalAlt !== null) {
      try {
        say('嘗試把 ' + targetId + ' 的 alt 還原成「' + originalAlt + '」…');
        var rescue = snapshotOf(readBanners());
        rescue.forEach(function (r) {
          if (menuWriteText(r.id) === targetId) r.alt = originalAlt;
        });
        writeBanners('緊急還原', rescue, true);
        var rescued = altOnSheet(targetId);
        say(rescued === originalAlt
          ? '✓ 已還原成原值'
          : '⚠ 還原後讀到的是「' + rescued + '」，請手動確認試算表');
      } catch (err2) {
        say('⚠ 還原也失敗了：' + menuWriteErrorText(err2));
        say('⚠ 請手動把 Banners 的 ' + targetId + ' 的 alt 改回「' + originalAlt + '」');
      }
    } else {
      say('（還沒有寫入任何東西就失敗了，試算表沒有被改動）');
    }

    // 不吞掉錯誤
    throw err;

  } finally {
    // 不管成功、失敗、或中途丟錯誤，開關一定回到 false
    MENU_WRITE_ENABLED = false;
    lock.releaseLock();

    say('');
    say('MENU_WRITE_ENABLED 最終值 = ' + MENU_WRITE_ENABLED);
    say(succeeded
      ? '══ 測試成功：既有 Banner 的 UPDATE 路徑可以真的寫入 Sheets，且已還原 ══'
      : '══ 測試未成功，詳見上面的錯誤訊息 ══');
  }

  return lines.join('\n');
}
