/**
 * Kigo 訂單 API — Google Apps Script Web App
 *
 * 部署方式：
 * 1. 開啟目標 Google Sheet → 擴充功能(Extensions) → Apps Script
 * 2. 把這份檔案內容整份貼進去（取代原本的 Code.gs）
 * 3. 部署(Deploy) → 新增部署作業(New deployment) → 類型：網頁應用程式(Web app)
 *    - 執行身分(Execute as): 我(Me)
 *    - 具有存取權的使用者(Who has access): 所有人(Anyone)
 * 4. 複製產生的 /exec 網址，貼到後台「訂單 API Endpoint」欄位並儲存
 *
 * ⚠ 每次修改這份程式碼後，都要「部署 → 管理部署作業 → 編輯 → 版本選新版本 → 部署」，
 *   否則 /exec 網址還是跑舊版程式碼。
 *
 * 支援的呼叫：
 *   GET  ?action=list                     → 回傳全部訂單
 *   GET  ?action=list&scope=today         → 只回傳今天的訂單
 *   GET  ?action=list&scope=month         → 只回傳本月的訂單
 *   GET  ?action=list&scope=date&date=YYYY-MM-DD → 只回傳指定日期的訂單
 *   POST {items:[...], ...}          → 新增一筆訂單（前端送出訂單時用）
 *   POST {action:'updateStatus', orderId, status}  → 更新訂單狀態
 *   POST {action:'updateOrder', orderId, items:[...]}  → 修改訂單內容
 *   POST {action:'deleteOrder', orderId}           → 刪除整筆訂單
 *   POST {action:'clearToday', confirm:'CLEAR_TODAY'} → 清空今天所有訂單
 */

var SHEET_NAME = 'Orders';
// 新欄位一律往後加，既有資料列的位置才不會跑掉。
// quantity   = 售出數量（含招待）
// freeQty    = 招待數量
// chargedQty = 收費數量 = quantity - freeQty
// subtotal   = chargedQty × unitPrice（只算收費的）
// freeAmount = freeQty  × unitPrice（招待金額，統計用）
var SHEET_HEADERS = [
  'orderId', 'receivedAt', 'clientCreatedAt',
  'itemName', 'category', 'temp',
  'quantity', 'unitPrice', 'subtotal',
  'orderTotal', 'pageUrl',
  'tableNumber', 'status',
  'originalItems', 'updatedAt', 'changeLog',
  'freeQty', 'chargedQty', 'freeAmount'
];

var VALID_STATUS = ['new', 'making', 'done'];

function col(name) {
  return SHEET_HEADERS.indexOf(name);
}

/* ═════════════════════════════
   進入點
   ═════════════════════════════ */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('empty request body');
    }
    var payload = JSON.parse(e.postData.contents);

    if (payload.action === 'updateStatus') {
      return handleUpdateStatus(payload);
    }
    if (payload.action === 'updateOrder') {
      return handleUpdateOrder(payload);
    }
    if (payload.action === 'deleteOrder') {
      return handleDeleteOrder(payload);
    }
    if (payload.action === 'clearToday') {
      return handleClearToday(payload);
    }
    return handleCreateOrder(payload);
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    if (params.action === 'list') {
      return jsonResponse({
        ok: true,
        orders: listOrders(params.scope, params.date)
      });
    }
    return jsonResponse({ ok: true, message: 'Kigo order API is running.' });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

/* ═════════════════════════════
   新增訂單
   ═════════════════════════════ */
function handleCreateOrder(payload) {
  var items = normalizeItems(Array.isArray(payload.items) ? payload.items : []);
  if (!items.length) throw new Error('order has no items');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = getOrCreateSheet();
    // 訂單編號一律由伺服器發號（KG+年份後兩碼+MMDD+當日序號，例如 KG260805001）。
    // 早期版本是由客人手機各自計算的，多人同時點餐時會產生一樣的號碼，
    // 造成一個編號對到兩筆訂單、之後修改或刪除就會動到錯的資料。
    // 這段是在 LockService 的鎖裡面執行，所以同時來的訂單會依序拿到不同號碼。
    // 後台補登可以指定日期（例如補登昨天漏記的單），一般訂單就是現在時間
    var receivedAt = (payload.manual && toDateOrNull(payload.receivedAt)) || new Date();

    var ctx = {
      orderId: nextOrderId(sheet, receivedAt),
      receivedAt: receivedAt,
      // 存成日期物件而不是字串，試算表才會用你設定的時區(GMT+8)顯示
      clientCreatedAt: toDateOrNull(payload.createdAt) || '',
      pageUrl: (payload.meta && payload.meta.pageUrl) || '',
      // 金額一律由伺服器依品項重算，不直接採用前端送來的 total
      orderTotal: chargedTotal(items),
      tableNumber: payload.tableNumber || '',
      // 補登通常是「已經做好給客人了」才在事後登記，所以允許直接指定狀態；
      // 客人自己送的訂單一律從「新訂單」開始，不接受前端指定。
      status: (payload.manual && VALID_STATUS.indexOf(payload.status) !== -1)
        ? payload.status : 'new',
      // 客人原始點的內容，之後店家修改訂單時這欄不會被動到，方便日後查詢對照。
      originalItems: JSON.stringify(items),
      updatedAt: '',
      // 後台手動補登的訂單標記一下，日後對帳才分得出來不是客人自己點的
      changeLog: payload.manual
        ? Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MM/dd HH:mm') + ' 後台補登'
        : ''
    };

    var rows = items.map(function (item) { return buildItemRow(ctx, item); });
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, SHEET_HEADERS.length).setValues(rows);
    return jsonResponse({ ok: true, orderId: ctx.orderId, total: ctx.orderTotal });
  } finally {
    lock.releaseLock();
  }
}

// 找出「該日期」已經用到的最大流水號 +1。必須在 LockService 的鎖裡呼叫才安全。
function nextOrderId(sheet, when) {
  var prefix = 'KG' + Utilities.formatDate(when || new Date(), Session.getScriptTimeZone(), 'yyMMdd');
  var lastRow = sheet.getLastRow();
  var maxSeq = 0;

  if (lastRow >= 2) {
    var ids = sheet.getRange(2, col('orderId') + 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      var id = String(ids[i][0]);
      if (id.indexOf(prefix) === 0) {
        var seq = parseInt(id.substring(prefix.length), 10);
        if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
      }
    }
  }

  var n = String(maxSeq + 1);
  while (n.length < 3) n = '0' + n;
  return prefix + n;
}

/* ═════════════════════════════
   更新訂單狀態
   ═════════════════════════════ */
function handleUpdateStatus(payload) {
  var orderId = payload.orderId;
  var status = payload.status;
  if (!orderId) throw new Error('missing orderId');
  if (VALID_STATUS.indexOf(status) === -1) throw new Error('invalid status: ' + status);

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = getOrCreateSheet();
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) throw new Error('order not found: ' + orderId);

    var idColumn = sheet.getRange(2, col('orderId') + 1, lastRow - 1, 1).getValues();
    var statusColumn = col('status') + 1;
    var updated = 0;

    // 同一筆訂單在表單裡是多列（每個品項一列），全部都要更新。
    for (var i = 0; i < idColumn.length; i++) {
      if (String(idColumn[i][0]) === String(orderId)) {
        sheet.getRange(i + 2, statusColumn).setValue(status);
        updated++;
      }
    }

    if (!updated) throw new Error('order not found: ' + orderId);
    return jsonResponse({ ok: true, orderId: orderId, status: status, updatedRows: updated });
  } finally {
    lock.releaseLock();
  }
}

/* ═════════════════════════════
   修改訂單內容
   ═════════════════════════════ */
function handleUpdateOrder(payload) {
  var orderId = payload.orderId;
  if (!orderId) throw new Error('missing orderId');

  var normalized = normalizeItems(Array.isArray(payload.items) ? payload.items : []);
  if (!normalized.length) throw new Error('order must keep at least one item');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = getOrCreateSheet();
    var block = findOrderRows(sheet, orderId);
    var oldRows = block.rows;
    var oldCount = oldRows.length;
    var newCount = normalized.length;

    var first = oldRows[0];
    var oldItems = normalizeItems(oldRows.map(function (row) {
      return {
        name: row[col('itemName')],
        category: row[col('category')],
        temp: row[col('temp')] || '',
        quantity: Number(row[col('quantity')]) || 0,
        freeQty: Number(row[col('freeQty')]) || 0,
        unitPrice: Number(row[col('unitPrice')]) || 0
      };
    }));

    var notes = diffItems(oldItems, normalized);
    var previousLog = first[col('changeLog')] || '';
    var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MM/dd HH:mm');

    // 這筆訂單的共同欄位沿用原本的值，不因為改品項而變動
    var ctx = {
      orderId: orderId,
      receivedAt: first[col('receivedAt')],
      clientCreatedAt: first[col('clientCreatedAt')],
      pageUrl: first[col('pageUrl')],
      orderTotal: chargedTotal(normalized),
      tableNumber: first[col('tableNumber')],
      status: first[col('status')] || 'new',
      // 舊訂單沒有 originalItems 的話，把「這次修改前」的內容補存成原始資料
      originalItems: first[col('originalItems')] || JSON.stringify(oldItems),
      updatedAt: new Date(),
      changeLog: notes.length
        ? (previousLog ? previousLog + ' ｜ ' : '') + stamp + ' ' + notes.join('、')
        : previousLog
    };

    // 先把列數調整成跟新品項數一致，再整批覆寫，這樣訂單在表單裡的位置不會跑掉
    if (newCount > oldCount) {
      sheet.insertRowsAfter(block.startRow + oldCount - 1, newCount - oldCount);
    } else if (newCount < oldCount) {
      sheet.deleteRows(block.startRow + newCount, oldCount - newCount);
    }

    var rows = normalized.map(function (item) { return buildItemRow(ctx, item); });
    sheet.getRange(block.startRow, 1, newCount, SHEET_HEADERS.length).setValues(rows);

    return jsonResponse({ ok: true, orderId: orderId, total: ctx.orderTotal, changeLog: ctx.changeLog });
  } finally {
    lock.releaseLock();
  }
}

/* ═════════════════════════════
   刪除整筆訂單
   ═════════════════════════════ */
function handleDeleteOrder(payload) {
  var orderId = payload.orderId;
  if (!orderId) throw new Error('missing orderId');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = getOrCreateSheet();
    var block = findOrderRows(sheet, orderId);
    sheet.deleteRows(block.startRow, block.rows.length);
    return jsonResponse({ ok: true, orderId: orderId, deletedRows: block.rows.length });
  } finally {
    lock.releaseLock();
  }
}

/* ═════════════════════════════
   清空今天的訂單（測試資料用）
   ═════════════════════════════ */
function handleClearToday(payload) {
  // 這是會刪掉整天資料的動作，要求呼叫端明確帶上確認字串，避免誤觸
  if (payload.confirm !== 'CLEAR_TODAY') throw new Error('missing confirmation');

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = getOrCreateSheet();
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return jsonResponse({ ok: true, deletedRows: 0 });

    var received = sheet.getRange(2, col('receivedAt') + 1, lastRow - 1, 1).getValues();
    var todayKey = dateKey(new Date());
    var targets = [];
    for (var i = 0; i < received.length; i++) {
      if (dateKey(received[i][0]) === todayKey) targets.push(i + 2);
    }
    if (!targets.length) return jsonResponse({ ok: true, deletedRows: 0 });

    // 由下往上、一段一段刪：往上刪不會讓還沒處理的列號位移，
    // 連續的列合併成一次呼叫也比一列一列刪快很多。
    var deleted = 0;
    var end = targets.length - 1;
    while (end >= 0) {
      var start = end;
      while (start > 0 && targets[start - 1] === targets[start] - 1) start--;
      var count = end - start + 1;
      sheet.deleteRows(targets[start], count);
      deleted += count;
      end = start - 1;
    }

    return jsonResponse({ ok: true, deletedRows: deleted });
  } finally {
    lock.releaseLock();
  }
}

// 同一筆訂單的列在表單裡是連續的（新增與修改都維持這個前提）
function findOrderRows(sheet, orderId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('order not found: ' + orderId);

  var values = sheet.getRange(2, 1, lastRow - 1, SHEET_HEADERS.length).getValues();
  var idIndex = col('orderId');
  var matches = [];

  for (var i = 0; i < values.length; i++) {
    if (String(values[i][idIndex]) === String(orderId)) matches.push(i);
  }
  if (!matches.length) throw new Error('order not found: ' + orderId);

  // 這筆訂單的列被別的資料隔開了 → 寧可中止，也不要覆寫到別人的資料
  var span = matches[matches.length - 1] - matches[0] + 1;
  if (span !== matches.length) throw new Error('order rows are not contiguous: ' + orderId);

  return {
    startRow: matches[0] + 2,
    rows: matches.map(function (i) { return values[i]; })
  };
}

function normalizeItems(items) {
  return items.map(function (item) {
    var quantity = Number(item.quantity) || 0;
    var freeQty = Number(item.freeQty) || 0;
    if (freeQty < 0) freeQty = 0;
    if (freeQty > quantity) freeQty = quantity;   // 招待數量不得超過售出數量
    return {
      name: String(item.name || ''),
      category: String(item.category || ''),
      temp: item.temp || '',
      quantity: quantity,
      freeQty: freeQty,
      chargedQty: quantity - freeQty,
      unitPrice: Number(item.unitPrice) || 0
    };
  }).filter(function (item) {
    return item.name && item.quantity > 0;
  });
}

// 訂單金額只算收費的部分，招待不計入
function chargedTotal(items) {
  return items.reduce(function (sum, item) {
    return sum + item.chargedQty * item.unitPrice;
  }, 0);
}

// 一筆訂單的所有列共用 ctx 這些欄位，只有品項相關的欄位不同
function buildItemRow(ctx, item) {
  return [
    ctx.orderId,
    ctx.receivedAt,
    ctx.clientCreatedAt,
    item.name,
    item.category,
    item.temp,
    item.quantity,
    item.unitPrice,
    item.chargedQty * item.unitPrice,
    ctx.orderTotal,
    ctx.pageUrl,
    ctx.tableNumber,
    ctx.status,
    ctx.originalItems,
    ctx.updatedAt,
    ctx.changeLog,
    item.freeQty,
    item.chargedQty,
    item.freeQty * item.unitPrice
  ];
}

function itemLabel(item) {
  var temp = item.temp === 'hot' ? '熱' : item.temp === 'iced' ? '冰' : item.temp;
  return item.name + (temp ? '(' + temp + ')' : '');
}

// 比對修改前後，產生像「新增 香橙巴斯克×1、享．拿鐵(冰) 2→1、招待 享．拿鐵(冰)×1」這樣的說明
function diffItems(oldItems, newItems) {
  var oldMap = {}, newMap = {}, keys = [], notes = [];
  var has = function (map, k) { return Object.prototype.hasOwnProperty.call(map, k); };
  var get = function (map, k) { return has(map, k) ? map[k] : { qty: 0, free: 0 }; };

  function tally(list, map) {
    list.forEach(function (item) {
      var k = itemLabel(item);
      if (keys.indexOf(k) === -1) keys.push(k);
      var cur = get(map, k);
      map[k] = {
        qty: cur.qty + (Number(item.quantity) || 0),
        free: cur.free + (Number(item.freeQty) || 0)
      };
    });
  }
  tally(oldItems, oldMap);
  tally(newItems, newMap);

  keys.forEach(function (k) {
    var before = get(oldMap, k);
    var after = get(newMap, k);

    if (before.qty !== after.qty) {
      if (!before.qty) notes.push('新增 ' + k + '×' + after.qty);
      else if (!after.qty) notes.push('刪除 ' + k + '×' + before.qty);
      else notes.push(k + ' ' + before.qty + '→' + after.qty);
    }

    // 品項被整個刪掉時就不用再單獨記招待的變化了
    if (after.qty && before.free !== after.free) {
      if (!before.free) notes.push('招待 ' + k + '×' + after.free);
      else if (!after.free) notes.push('取消招待 ' + k + '×' + before.free);
      else notes.push('招待 ' + k + ' ' + before.free + '→' + after.free);
    }
  });
  return notes;
}

/* ═════════════════════════════
   讀取訂單
   ═════════════════════════════ */
// scope: 'today' | 'month' | 'date'（搭配 dateStr，格式 YYYY-MM-DD）| 其他值 = 全部
function buildDateFilter(scope, dateStr) {
  var now = new Date();
  if (scope === 'today') {
    var todayKey = dateKey(now);
    return function (d) { return dateKey(d) === todayKey; };
  }
  if (scope === 'date' && dateStr) {
    return function (d) { return dateKey(d) === String(dateStr); };
  }
  if (scope === 'month') {
    var thisMonth = monthKey(now);
    return function (d) { return monthKey(d) === thisMonth; };
  }
  return null;
}

function listOrders(scope, dateStr) {
  var sheet = getOrCreateSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var matchesDate = buildDateFilter(scope, dateStr);
  var startRow = 2;
  var numRows = lastRow - 1;

  // 先只讀 receivedAt 這一欄找出符合的列在哪個範圍，再把那段整批讀回來。
  // 表越大差越多——查「今天」時不用把整張表 19 欄全部搬一次。
  if (matchesDate) {
    var dates = sheet.getRange(2, col('receivedAt') + 1, numRows, 1).getValues();
    var firstIdx = -1, lastIdx = -1;
    for (var i = 0; i < dates.length; i++) {
      if (matchesDate(dates[i][0])) {
        if (firstIdx === -1) firstIdx = i;
        lastIdx = i;
      }
    }
    if (firstIdx === -1) return [];
    startRow = firstIdx + 2;
    numRows = lastIdx - firstIdx + 1;
  }

  var rows = sheet.getRange(startRow, 1, numRows, SHEET_HEADERS.length).getValues();
  var ordersById = {};
  var orderIds = [];

  rows.forEach(function (row) {
    var orderId = row[col('orderId')];
    if (!orderId) return;

    var receivedAt = row[col('receivedAt')];
    if (matchesDate && !matchesDate(receivedAt)) return;

    if (!ordersById[orderId]) {
      ordersById[orderId] = {
        orderId: orderId,
        receivedAt: toIsoString(receivedAt),
        createdAt: row[col('clientCreatedAt')] || toIsoString(receivedAt),
        total: row[col('orderTotal')],
        pageUrl: row[col('pageUrl')],
        tableNumber: row[col('tableNumber')] || null,
        status: row[col('status')] || 'new',
        updatedAt: row[col('updatedAt')] ? toIsoString(row[col('updatedAt')]) : null,
        changeLog: row[col('changeLog')] || '',
        originalItems: parseJsonOrNull(row[col('originalItems')]),
        items: []
      };
      orderIds.push(orderId);
    }
    var quantity = Number(row[col('quantity')]) || 0;
    var freeQty = Number(row[col('freeQty')]) || 0;
    ordersById[orderId].items.push({
      name: row[col('itemName')],
      category: row[col('category')],
      temp: row[col('temp')] || null,
      quantity: quantity,
      freeQty: freeQty,
      chargedQty: Number(row[col('chargedQty')]) || (quantity - freeQty),
      unitPrice: row[col('unitPrice')],
      subtotal: row[col('subtotal')],
      freeAmount: Number(row[col('freeAmount')]) || 0
    });
  });

  return orderIds.map(function (id) { return ordersById[id]; });
}

/* ═════════════════════════════
   工具
   ═════════════════════════════ */
function dateKey(value) {
  return formatDateAs(value, 'yyyy-MM-dd');
}

function monthKey(value) {
  return formatDateAs(value, 'yyyy-MM');
}

function formatDateAs(value, pattern) {
  if (!(value instanceof Date)) {
    value = new Date(value);
    if (isNaN(value.getTime())) return '';
  }
  return Utilities.formatDate(value, Session.getScriptTimeZone(), pattern);
}

function toIsoString(value) {
  return (value instanceof Date) ? value.toISOString() : String(value || '');
}

function toDateOrNull(value) {
  if (!value) return null;
  var d = (value instanceof Date) ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function parseJsonOrNull(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch (e) { return null; }
}

function getOrCreateSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

  // 工作表實際欄數不夠的話先補欄，否則寫入/讀取會直接報錯
  var maxColumns = sheet.getMaxColumns();
  if (maxColumns < SHEET_HEADERS.length) {
    sheet.insertColumnsAfter(maxColumns, SHEET_HEADERS.length - maxColumns);
  }

  // 舊版表單欄位較少，這裡補寫完整標題列。
  // 新欄位是接在最後面，所以既有資料列的位置不受影響，只是新欄位留白。
  if (sheet.getLastRow() === 0 || sheet.getLastColumn() < SHEET_HEADERS.length) {
    sheet.getRange(1, 1, 1, SHEET_HEADERS.length).setValues([SHEET_HEADERS]);
  }
  return sheet;
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
