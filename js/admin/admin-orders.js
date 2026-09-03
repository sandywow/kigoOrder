/* ═════════════════════════════
   訂單 API 呼叫
   ═════════════════════════════ */
function getOrderEndpoint() {
  return (state.landingData && state.landingData.orderEndpoint) || null;
}

async function apiGetOrders(scope, date) {
  const endpoint = getOrderEndpoint();
  if (!endpoint) return null;
  try {
    let qs = 'action=list' + (scope ? '&scope=' + encodeURIComponent(scope) : '');
    if (date) qs += '&date=' + encodeURIComponent(date);
    const url = endpoint + (endpoint.includes('?') ? '&' : '?') + qs;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return (data && data.ok && Array.isArray(data.orders)) ? data.orders : null;
  } catch (e) {
    console.warn('apiGetOrders failed', e);
    return null;
  }
}

// Content-Type 用 text/plain：Apps Script 沒有處理 CORS 預檢(OPTIONS)，
// 用 application/json 會觸發預檢而直接失敗。
async function apiPostOrder(payload) {
  const endpoint = getOrderEndpoint();
  if (!endpoint) return null;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn('apiPostOrder failed', e);
    return null;
  }
}

/* ═════════════════════════════
   今日訂單
   ═════════════════════════════ */
const ORDER_STATUS = {
  new:    { label: '新訂單', dot: '🟡' },
  making: { label: '製作中', dot: '🔵' },
  done:   { label: '已完成', dot: '🟢' }
};

// 付款狀態跟製作狀態是各自獨立的：做好了不等於收過錢，先付款後取餐也很常見。
// 只有「已結帳」的訂單會被算進統計的營業額。
const PAYMENT_STATUS = {
  unpaid: { label: '未結帳', dot: '⚪' },
  paid:   { label: '已結帳', dot: '💰' }
};

// 舊訂單沒有這個欄位，一律當成未結帳
function paymentOf(order) {
  return order && order.paymentStatus === 'paid' ? 'paid' : 'unpaid';
}

// 新的排最上面，忙的時候才不用一直往下捲找最新的單
function byNewestFirst(a, b) {
  return new Date(b.receivedAt || b.createdAt) - new Date(a.receivedAt || a.createdAt);
}

// 只用在「已完成」那一區：東西都做完了，剩下要盯的就是誰還沒付錢，
// 已結帳的沉到最下面。付款狀態相同時一樣是新的在前。
function byUnpaidFirst(a, b) {
  const paidDiff = (paymentOf(a) === 'paid' ? 1 : 0) - (paymentOf(b) === 'paid' ? 1 : 0);
  return paidDiff || byNewestFirst(a, b);
}

let todayOrders = [];
let todayOrdersSignature = '';

// 已經樂觀更新、但伺服器還沒確認的異動。
// 輪詢每 4 秒就抓一次，如果剛好在寫入途中抓到舊資料，
// 沒有這層覆蓋的話畫面會先跳回舊狀態、下一輪才變回來（閃一下）。
const pendingOps = new Map();
const pendingDeletes = new Set();

// 同一筆訂單可能同時有多個異動還沒被伺服器確認（例如剛按了結帳、接著按開始製作）。
// 直接 pendingOps.set 會整包覆蓋，把前一個異動丟掉，畫面就會閃回舊狀態，所以要用合併的。
function mergePendingOp(key, patch) {
  pendingOps.set(key, Object.assign({}, pendingOps.get(key), patch));
}

// 確認完成後只清掉自己負責的欄位，別把同一筆訂單上其他還在等待的異動一起清掉
function clearPendingOp(key, patch) {
  const current = pendingOps.get(key);
  if (!current) return;
  Object.keys(patch).forEach(k => {
    if (current[k] === patch[k]) delete current[k];
  });
  if (!Object.keys(current).length) pendingOps.delete(key);
}

function applyPendingOps(orders) {
  let result = orders;
  if (pendingDeletes.size) {
    result = result.filter(o => !pendingDeletes.has(String(o.orderId)));
  }
  if (pendingOps.size) {
    result = result.map(o => {
      const patch = pendingOps.get(String(o.orderId));
      return patch ? Object.assign({}, o, patch) : o;
    });
  }
  return result;
}

function formatOrderClock(order) {
  const d = new Date(order.createdAt || order.receivedAt);
  if (isNaN(d.getTime())) return '—';
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function tempLabel(temp) {
  if (!temp) return '';
  const label = temp === 'hot' ? '熱' : temp === 'iced' ? '冰' : temp;
  return ` <span class="order-item-temp">(${esc(label)})</span>`;
}

function buildOrderCard(order) {
  const status = ORDER_STATUS[order.status] ? order.status : 'new';
  const items = order.items || [];
  const totalQty = items.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0);

  const totalFree = items.reduce((sum, i) => sum + (Number(i.freeQty) || 0), 0);
  const freeAmount = items.reduce((sum, i) => sum + (Number(i.freeAmount) || 0), 0);

  const itemRows = items.map(i => {
    const freeQty = Number(i.freeQty) || 0;
    const chargedQty = i.chargedQty != null ? Number(i.chargedQty) : (Number(i.quantity) || 0) - freeQty;
    return `
    <div class="order-item-row">
      <span class="order-item-name">${esc(i.name)}${tempLabel(i.temp)}${
        freeQty ? `<span class="order-item-free">招待${freeQty}</span>` : ''}</span>
      <span class="order-item-calc">NT$${Number(i.unitPrice) || 0} × ${chargedQty}</span>
      <span class="order-item-sub">NT$${Number(i.subtotal) || 0}</span>
    </div>`;
  }).join('');

  const payment = paymentOf(order);
  const id = esc(order.orderId);

  let actions = `<button class="btn-order" onclick="openEditOrder('${id}')">修改訂單</button>`;
  actions += payment === 'unpaid'
    ? `<button class="btn-order btn-order-pay" onclick="setOrderPayment('${id}','paid')">結帳</button>`
    : `<button class="btn-order" onclick="setOrderPayment('${id}','unpaid')">取消結帳</button>`;
  if (status === 'new') {
    actions += `<button class="btn-order btn-order-primary" onclick="setOrderStatus('${id}','making')">開始製作</button>`;
  } else if (status === 'making') {
    actions += `<button class="btn-order btn-order-primary" onclick="setOrderStatus('${id}','done')">標記完成</button>`;
  }

  return `
    <div class="order-card is-${status} is-${payment}">
      <div class="order-card-head">
        <span class="order-id">${id}</span>
        <span class="order-badge is-${status}">${ORDER_STATUS[status].dot} ${ORDER_STATUS[status].label}</span>
        <span class="pay-badge is-${payment}">${PAYMENT_STATUS[payment].dot} ${PAYMENT_STATUS[payment].label}</span>
      </div>
      <div class="order-sub">${formatOrderClock(order)} · 桌號 ${order.tableNumber ? esc(order.tableNumber) : '—'}${
        order.nickname ? ` · ${esc(order.nickname)}` : ''}</div>
      <div class="order-items">${itemRows}</div>
      <div class="order-foot">
        <div class="order-total-line">共 ${totalQty} 件${
          totalFree ? `<span class="order-free-note">（招待 ${totalFree} 件 -NT$${freeAmount}）</span>` : ''
        }<span class="order-total-amt">NT$${Number(order.total) || 0}</span></div>
        <div class="order-actions">${actions}</div>
      </div>
    </div>`;
}

function paintTodayOrders() {
  const wrap = document.getElementById('today-orders');
  if (!wrap) return;

  const sorted = todayOrders.slice().sort(byNewestFirst);

  const groups = ['new', 'making', 'done'].map(key => {
    let list = sorted.filter(o => (ORDER_STATUS[o.status] ? o.status : 'new') === key);
    // 新訂單和製作中維持時間順序 —— 那兩區是照著順序做事的，
    // 被付款狀態打亂反而會漏掉先來的單。已完成的才把已結帳的沉到下面。
    if (key === 'done') list = list.sort(byUnpaidFirst);
    const body = list.length
      ? list.map(buildOrderCard).join('')
      : '<div class="order-group-empty">目前沒有</div>';
    return `
      <div class="order-group">
        <div class="order-group-head">
          <span>${ORDER_STATUS[key].dot} ${ORDER_STATUS[key].label}</span>
          <span class="order-group-count">${list.length}</span>
        </div>
        ${body}
      </div>`;
  }).join('');

  wrap.innerHTML = groups;
}

// Apps Script 有時要 5~10 秒才回應。如果照樣每 4 秒再發一次，
// 請求會一直疊上去、把瀏覽器對同一網域的連線數吃光，整個後台就卡住。
// 所以同一時間只允許一個查詢在跑，還沒回來就跳過這一輪。
let todayFetchInFlight = false;
let consecutiveFetchFailures = 0;

async function refreshTodayOrders() {
  const wrap = document.getElementById('today-orders');
  if (!wrap) return;

  if (!getOrderEndpoint()) {
    wrap.innerHTML = '<div class="order-hint">尚未設定訂單 API。<br>請到「其他設定 → 訂單 API」填入 Google Apps Script 的 /exec 網址後儲存。</div>';
    return;
  }
  // 有寫入正在進行時先不輪詢，把連線讓給店家的操作，也避免抓到寫到一半的資料
  if (todayFetchInFlight || activeWrites > 0) return;

  todayFetchInFlight = true;
  let orders;
  try {
    orders = await apiGetOrders('today');
  } finally {
    todayFetchInFlight = false;
  }

  if (!orders) {
    consecutiveFetchFailures++;
    if (!todayOrders.length) {
      wrap.innerHTML = `<div class="order-hint">讀取訂單失敗（第 ${consecutiveFetchFailures} 次），持續重試中…<br>若一直沒有恢復，請確認 Apps Script 已重新部署為最新版本。</div>`;
    }
    return;
  }
  consecutiveFetchFailures = 0;

  // 伺服器內容沒變就不重繪，避免每 4 秒閃一次畫面
  const signature = JSON.stringify(orders);
  if (signature === todayOrdersSignature) return;
  todayOrdersSignature = signature;

  todayOrders = applyPendingOps(orders);
  paintTodayOrders();

  // 「訂單紀錄」如果也是看今天，就直接沿用這份資料，不用再打一次 API。
  // 同一份資料抓兩次會讓新訂單慢一倍才出現，也比較容易塞住連線。
  if (historyScope === 'today') {
    historySignature = signature;
    historyOrders = applyPendingOps(orders);
    paintHistory();
  }
}

/* ═════════════════════════════
   寫入排隊 + 結果確認
   ═════════════════════════════ */
// 連點多個動作時，如果同時往 Apps Script 送，請求會互相卡住（之前刪第二筆沒反應就是這樣）。
// 這裡讓所有寫入排成一列依序送出，動作不會被丟掉，也不會塞爆連線。
let writeChain = Promise.resolve();
let activeWrites = 0;

function queueWrite(task) {
  activeWrites++;
  const run = writeChain.then(task, task);
  writeChain = run.then(() => {}, () => {});
  return run.then(
    v => { activeWrites--; return v; },
    e => { activeWrites--; throw e; }
  );
}

// 查詢伺服器上這筆訂單目前的樣子。
// reachable=false 代表「連不上、查不到」，不等於「操作失敗」——
// 這兩者一定要分開，否則會把已經成功的操作誤判成失敗然後把畫面還原回去。
async function probeOrder(orderId) {
  const orders = await apiGetOrders('today');
  if (!orders) return { reachable: false, order: null };
  return {
    reachable: true,
    order: orders.find(o => String(o.orderId) === String(orderId)) || null
  };
}

async function setOrderStatus(orderId, status) {
  const key = String(orderId);
  const order = findLoadedOrder(orderId);
  const previous = order ? order.status : null;

  // 樂觀更新：Apps Script 回應常要好幾秒，先讓畫面立刻反應，失敗再還原。
  // 狀態切換每天要按很多次，成功不跳提示，畫面上的顏色變化就夠清楚了。
  mergePendingOp(key, { status });
  patchLoadedOrders(orderId, { status });
  repaintOrders();

  await queueWrite(async () => {
    const res = await apiPostOrder({ action: 'updateStatus', orderId, status });
    if (res && res.ok) {
      clearPendingOp(key, { status });
      return;
    }

    const probe = await probeOrder(orderId);
    if (!probe.reachable) {
      // 查不到不代表沒寫成功，保留畫面上的結果，讓之後的輪詢自動校正
      clearPendingOp(key, { status });
      return;
    }
    if (probe.order && probe.order.status === status) {
      clearPendingOp(key, { status });
      return;
    }

    clearPendingOp(key, { status });
    if (previous) {
      patchLoadedOrders(orderId, { status: previous });
      repaintOrders();
    }
    console.error('updateStatus failed', res);
    showToast((res && res.error) ? '更新失敗：' + res.error : '更新失敗，請稍後再試');
  });
}

// 跟 setOrderStatus 同一套做法：先樂觀更新畫面，再用 probe 確認伺服器上的實際結果。
// 結帳會直接影響統計的營業額，所以按錯要能馬上改回來，成功不跳提示（badge 變化就夠明顯）。
async function setOrderPayment(orderId, paymentStatus) {
  const key = String(orderId);
  const order = findLoadedOrder(orderId);
  const previous = order ? paymentOf(order) : null;
  if (previous === paymentStatus) return;

  mergePendingOp(key, { paymentStatus });
  patchLoadedOrders(orderId, { paymentStatus });
  repaintOrders();

  await queueWrite(async () => {
    const res = await apiPostOrder({ action: 'updatePayment', orderId, paymentStatus });
    if (res && res.ok) {
      clearPendingOp(key, { paymentStatus });
      return;
    }

    const probe = await probeOrder(orderId);
    if (!probe.reachable) {
      // 查不到不等於沒寫成功，保留畫面上的結果，讓之後的輪詢自動校正
      clearPendingOp(key, { paymentStatus });
      return;
    }
    if (probe.order && paymentOf(probe.order) === paymentStatus) {
      clearPendingOp(key, { paymentStatus });
      return;
    }

    clearPendingOp(key, { paymentStatus });
    if (previous) {
      patchLoadedOrders(orderId, { paymentStatus: previous });
      repaintOrders();
    }
    console.error('updatePayment failed', res);
    showToast((res && res.error) ? '更新失敗：' + res.error : '更新失敗，請稍後再試');
  });
}

/* ═════════════════════════════
   修改訂單 / 補登訂單
   ═════════════════════════════ */
let editingOrder = null;
let savingOrderEdit = false;

// 訂單可能來自「今日訂單」也可能來自「訂單紀錄」，兩邊都要找
function findLoadedOrder(orderId) {
  const key = String(orderId);
  return todayOrders.find(o => String(o.orderId) === key)
      || historyOrders.find(o => String(o.orderId) === key)
      || null;
}

// 同一筆訂單在「今日訂單」和「訂單紀錄」是兩個各自抓回來的物件。
// 只改其中一個的話，另一個清單會停在舊金額，要按重整才會更新，所以兩邊都要一起改。
function patchLoadedOrders(orderId, patch) {
  const key = String(orderId);
  [todayOrders, historyOrders].forEach(list => {
    list.forEach(o => {
      if (String(o.orderId) === key) Object.assign(o, patch);
    });
  });
}

function repaintOrders() {
  paintTodayOrders();
  paintHistory();
}

function priceNumber(price) {
  const m = String(price == null ? '' : price).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function findMenuItem(cat, name) {
  const items = (state.menuData || {})[cat] || [];
  return items.find(i => i.name === name) || null;
}

function categoryLabel(cat) {
  const t = (state.sectionTitles || {})[cat];
  return (t && (t.jp || t.en)) || cat;
}

function menuItemOptions(selectedCat, selectedName) {
  let html = '';
  let found = false;
  Object.keys(state.menuData || {}).forEach(cat => {
    const items = state.menuData[cat] || [];
    if (!items.length) return;
    html += `<optgroup label="${esc(categoryLabel(cat))}">`;
    items.forEach((item, idx) => {
      const selected = cat === selectedCat && item.name === selectedName;
      if (selected) found = true;
      html += `<option value="${esc(cat)}|${idx}"${selected ? ' selected' : ''}>${esc(item.name)}</option>`;
    });
    html += '</optgroup>';
  });
  if (!selectedName) {
    // 新增的空白列：先不預設任何品項，讓店家自己選
    html = '<option value="" selected>—　請選擇品項　—</option>' + html;
  } else if (!found) {
    // 品項可能已被改名或從菜單移除，仍要能顯示原本點的東西
    html = `<option value="" selected>${esc(selectedName)}（已不在菜單）</option>` + html;
  }
  return html;
}

function tempOptions(row) {
  const menuItem = findMenuItem(row.category, row.name);
  const config = menuItem ? menuItem.temp : null;
  let values = config === 'both' ? ['hot', 'iced'] : (config ? [config] : []);
  if (row.temp && values.indexOf(row.temp) === -1) values = [row.temp].concat(values);

  if (!values.length) return '<option value="">—</option>';
  return values.map(t =>
    `<option value="${esc(t)}"${t === row.temp ? ' selected' : ''}>${t === 'hot' ? '熱' : t === 'iced' ? '冰' : esc(t)}</option>`
  ).join('');
}

function openEditOrder(orderId) {
  const order = findLoadedOrder(orderId);
  if (!order) { showToast('找不到這筆訂單'); return; }

  // 深拷貝一份來編輯，背景輪詢更新資料時不會影響編輯中的內容
  editingOrder = {
    orderId: order.orderId,
    isManual: false,
    createdAt: order.createdAt || order.receivedAt,
    tableNumber: order.tableNumber,
    // 以下都是唯讀顯示用。付款狀態由訂單卡上的「結帳」按鈕處理；
    // 暱稱是客人自己填的，店家不應該在這裡改掉客人寫的東西。
    paymentStatus: paymentOf(order),
    nickname: order.nickname || '',
    changeLog: order.changeLog || '',
    items: (order.items || []).map(i => ({
      name: i.name,
      category: i.category,
      temp: i.temp || '',
      quantity: Number(i.quantity) || 0,
      freeQty: Number(i.freeQty) || 0,
      unitPrice: Number(i.unitPrice) || 0
    }))
  };
  showEditModal();
}

// 補登訂單：沿用同一個編輯視窗，只是還沒有訂單編號
function todayInputValue() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function openManualOrder() {
  if (!getOrderEndpoint()) { showToast('尚未設定訂單 API'); return; }
  editingOrder = {
    orderId: null,
    isManual: true,
    orderDate: todayInputValue(),   // 可改成補登昨天等日期
    orderStatus: 'new',
    // 補登通常是「錢已經收了才回頭記帳」，預設已結帳，要改再改
    orderPayment: 'paid',
    tableNumber: null,
    changeLog: '',
    items: [{ name: '', category: '', temp: '', quantity: 1, freeQty: 0, unitPrice: 0 }]
  };
  showEditModal();
}

function setManualDate(value) {
  if (!editingOrder) return;
  editingOrder.orderDate = value;
  // 補登過去的日期通常是「早就做完了」，直接預設已完成，店家要改再改
  if (value !== todayInputValue()) editingOrder.orderStatus = 'done';
  paintEditOrder();
}

function setManualStatus(value) {
  if (editingOrder) editingOrder.orderStatus = value;
}

function setManualPayment(value) {
  if (editingOrder) editingOrder.orderPayment = value;
}

// 把「日期 + 現在時刻」組成當地時間，再轉成 ISO 給伺服器。
// 直接用 new Date('2026-08-05') 會被當成 UTC，在 GMT+8 可能跨到別天。
function manualDateToIso(dateStr) {
  const parts = String(dateStr || '').split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return new Date().toISOString();
  const now = new Date();
  return new Date(parts[0], parts[1] - 1, parts[2],
                  now.getHours(), now.getMinutes(), now.getSeconds()).toISOString();
}

function showEditModal() {
  document.getElementById('order-edit-backdrop').classList.add('open');
  document.getElementById('order-edit-modal').classList.add('open');
  document.querySelector('#order-edit-modal .modal-title').textContent =
    editingOrder.isManual ? '補登訂單' : '修改訂單';
  document.getElementById('order-edit-save').textContent =
    editingOrder.isManual ? '建立訂單' : '儲存修改';
  paintEditOrder();
}

function closeEditOrder() {
  editingOrder = null;
  document.getElementById('order-edit-backdrop').classList.remove('open');
  document.getElementById('order-edit-modal').classList.remove('open');
}

function paintEditOrder() {
  if (!editingOrder) return;
  const body = document.getElementById('order-edit-body');

  const rows = editingOrder.items.map((row, i) => {
    const freeQty = row.freeQty || 0;
    const chargedQty = row.quantity - freeQty;
    return `
    <div class="edit-row${freeQty ? ' has-free' : ''}">
      <div class="edit-row-top">
        <select class="edit-select-item" onchange="changeEditItem(${i}, this.value)">${menuItemOptions(row.category, row.name)}</select>
        <select class="edit-select-temp" onchange="changeEditTemp(${i}, this.value)">${tempOptions(row)}</select>
      </div>
      <div class="edit-row-bottom">
        <div class="edit-qty">
          <button type="button" onclick="changeEditQty(${i}, -1)">−</button>
          <input type="number" min="1" value="${row.quantity}" onchange="setEditQty(${i}, this.value)">
          <button type="button" onclick="changeEditQty(${i}, 1)">＋</button>
          <span class="edit-row-price">${row.name ? '× NT$' + row.unitPrice : '× —'}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <span class="edit-row-sub">${row.name ? 'NT$' + row.unitPrice * chargedQty : '—'}</span>
          <button type="button" class="edit-remove" onclick="removeEditItem(${i})">刪除</button>
        </div>
      </div>
      <div class="edit-row-free">
        <span class="edit-free-label">招待</span>
        <div class="edit-qty">
          <button type="button" onclick="changeEditFree(${i}, -1)" ${freeQty <= 0 ? 'disabled' : ''}>−</button>
          <input type="number" min="0" max="${row.quantity}" value="${freeQty}" onchange="setEditFree(${i}, this.value)">
          <button type="button" onclick="changeEditFree(${i}, 1)" ${freeQty >= row.quantity ? 'disabled' : ''}>＋</button>
        </div>
        <span class="edit-free-summary">收費 ${chargedQty} · 招待 ${freeQty}${freeQty ? `（-NT$${row.unitPrice * freeQty}）` : ''}</span>
      </div>
    </div>`;
  }).join('');

  // 訂單卡上不再顯示修改紀錄，這裡是唯一看得到的地方
  const changeLog = editingOrder.changeLog
    ? `<div class="order-changelog">✎ 修改紀錄：${esc(editingOrder.changeLog)}</div>`
    : '';

  const statusOptions = ['new', 'making', 'done'].map(s =>
    `<option value="${s}"${s === editingOrder.orderStatus ? ' selected' : ''}>${ORDER_STATUS[s].dot} ${ORDER_STATUS[s].label}</option>`
  ).join('');

  const paymentOptions = ['unpaid', 'paid'].map(p =>
    `<option value="${p}"${p === editingOrder.orderPayment ? ' selected' : ''}>${PAYMENT_STATUS[p].dot} ${PAYMENT_STATUS[p].label}</option>`
  ).join('');

  const header = editingOrder.isManual
    ? `<div class="order-edit-meta">
         <div style="margin-bottom:8px">手動補登一筆訂單，訂單編號會依所選日期自動產生。</div>
         <div class="manual-fields">
           <label>訂單日期
             <input type="date" value="${esc(editingOrder.orderDate)}" onchange="setManualDate(this.value)">
           </label>
           <label>訂單狀態
             <select onchange="setManualStatus(this.value)">${statusOptions}</select>
           </label>
           <label>付款狀態
             <select onchange="setManualPayment(this.value)">${paymentOptions}</select>
           </label>
         </div>
       </div>`
    : `<div class="order-edit-meta">
         訂單編號 ${esc(editingOrder.orderId)}　·　桌號 ${editingOrder.tableNumber ? esc(editingOrder.tableNumber) : '—'}${
           editingOrder.nickname ? '　·　' + esc(editingOrder.nickname) : ''}　·　${
           PAYMENT_STATUS[editingOrder.paymentStatus].dot} ${PAYMENT_STATUS[editingOrder.paymentStatus].label}
       </div>${changeLog}`;

  body.innerHTML = `
    ${header}
    ${rows}
    <button type="button" class="btn-add" onclick="addEditItem()">＋ 新增品項</button>`;

  document.getElementById('order-edit-total').textContent = 'NT$' + editOrderTotal();
}

// 訂單金額只算收費的數量，招待不計入
function editOrderTotal() {
  return editingOrder.items.reduce(
    (sum, i) => sum + i.unitPrice * (i.quantity - (i.freeQty || 0)), 0);
}

function clampFree(row) {
  if (!row.freeQty || row.freeQty < 0) row.freeQty = 0;
  if (row.freeQty > row.quantity) row.freeQty = row.quantity;   // 招待不得超過售出數量
}

function changeEditFree(index, delta) {
  const row = editingOrder.items[index];
  if (!row) return;
  row.freeQty = (row.freeQty || 0) + delta;
  clampFree(row);
  paintEditOrder();
}

function setEditFree(index, value) {
  const row = editingOrder.items[index];
  if (!row) return;
  row.freeQty = parseInt(value, 10) || 0;
  clampFree(row);
  paintEditOrder();
}

function changeEditItem(index, value) {
  const row = editingOrder.items[index];
  if (!row || !value) return;
  const sep = value.lastIndexOf('|');
  const cat = value.slice(0, sep);
  const item = (state.menuData[cat] || [])[Number(value.slice(sep + 1))];
  if (!item) return;

  row.name = item.name;
  row.category = cat;
  row.unitPrice = priceNumber(item.price);
  // 換了品項，溫度要跟著新品項的設定走
  row.temp = item.temp === 'both' ? 'hot' : (item.temp || '');
  paintEditOrder();
}

function changeEditTemp(index, value) {
  const row = editingOrder.items[index];
  if (!row) return;
  row.temp = value;
  paintEditOrder();
}

function changeEditQty(index, delta) {
  const row = editingOrder.items[index];
  if (!row) return;
  row.quantity = Math.max(1, row.quantity + delta);
  clampFree(row);   // 數量調小時，招待數量不能超過它
  paintEditOrder();
}

function setEditQty(index, value) {
  const row = editingOrder.items[index];
  if (!row) return;
  row.quantity = Math.max(1, parseInt(value, 10) || 1);
  clampFree(row);
  paintEditOrder();
}

function removeEditItem(index) {
  if (editingOrder.items.length <= 1) {
    showToast('訂單至少要保留一個品項');
    return;
  }
  editingOrder.items.splice(index, 1);
  paintEditOrder();
}

function addEditItem() {
  // 空白列，品項欄顯示「請選擇品項」，避免誤送出預設的第一個品項
  editingOrder.items.push({ name: '', category: '', temp: '', quantity: 1, freeQty: 0, unitPrice: 0 });
  paintEditOrder();
}

function deleteWholeOrder() {
  if (!editingOrder || editingOrder.isManual) return;
  const orderId = editingOrder.orderId;
  closeEditOrder();
  return deleteOrderById(orderId);
}

async function deleteOrderById(orderId) {
  const key = String(orderId);
  if (!confirm(`確定要刪除訂單 ${orderId} 嗎？\n\nGoogle 試算表上這筆訂單的所有資料都會一併移除，無法復原。`)) return;

  const removedToday = todayOrders.find(o => String(o.orderId) === key);
  const removedHistory = historyOrders.find(o => String(o.orderId) === key);

  // 樂觀移除，並記在 pendingDeletes，避免輪詢把它又抓回來
  pendingDeletes.add(key);
  todayOrders = todayOrders.filter(o => String(o.orderId) !== key);
  historyOrders = historyOrders.filter(o => String(o.orderId) !== key);
  repaintOrders();
  showToast('訂單已刪除');   // 畫面上已經移除了，提示不用等伺服器回應

  await queueWrite(async () => {
    const res = await apiPostOrder({ action: 'deleteOrder', orderId });
    if (res && res.ok) {
      pendingDeletes.delete(key);
      refreshAfterWrite();
      return;
    }

    const probe = await probeOrder(orderId);
    if (!probe.reachable) {
      // 查不到不代表沒刪成功，不要把訂單還原回畫面（之前就是這樣誤報的）
      pendingDeletes.delete(key);
      return;
    }
    if (!probe.order) {
      pendingDeletes.delete(key);
      refreshAfterWrite();
      return;
    }

    // 確認伺服器上真的還在，才算失敗，把訂單放回畫面
    pendingDeletes.delete(key);
    if (removedToday && !todayOrders.some(o => String(o.orderId) === key)) {
      todayOrders = todayOrders.concat([removedToday]);
    }
    if (removedHistory && !historyOrders.some(o => String(o.orderId) === key)) {
      historyOrders = historyOrders.concat([removedHistory]);
    }
    repaintOrders();
    console.error('deleteOrder failed', res);
    showToast((res && res.error) ? '刪除失敗：' + res.error : '刪除失敗，請稍後再試');
    refreshAfterWrite();
  });
}

// 寫入完成後，把目前看得到的清單都重抓一次
function refreshAfterWrite() {
  todayOrdersSignature = '';
  historySignature = '';
  refreshTodayOrders();
  renderOrderManagement();
}

// 與 Code.gs 的 diffItems 產生相同格式的文字，讓修改紀錄不用等伺服器回應就先顯示。
// 伺服器回來的才是最終版本，下一次抓資料時會覆蓋這裡的樂觀值。
function localItemLabel(item) {
  const t = item.temp === 'hot' ? '熱' : item.temp === 'iced' ? '冰' : (item.temp || '');
  return item.name + (t ? `(${t})` : '');
}

function localDiffItems(oldItems, newItems) {
  const oldMap = new Map(), newMap = new Map(), keys = [];
  const get = (map, k) => map.get(k) || { qty: 0, free: 0 };
  const tally = (list, map) => list.forEach(item => {
    const k = localItemLabel(item);
    if (!keys.includes(k)) keys.push(k);
    const cur = get(map, k);
    map.set(k, {
      qty: cur.qty + (Number(item.quantity) || 0),
      free: cur.free + (Number(item.freeQty) || 0)
    });
  });
  tally(oldItems, oldMap);
  tally(newItems, newMap);

  const notes = [];
  keys.forEach(k => {
    const before = get(oldMap, k);
    const after = get(newMap, k);

    if (before.qty !== after.qty) {
      if (!before.qty) notes.push(`新增 ${k}×${after.qty}`);
      else if (!after.qty) notes.push(`刪除 ${k}×${before.qty}`);
      else notes.push(`${k} ${before.qty}→${after.qty}`);
    }
    if (after.qty && before.free !== after.free) {
      if (!before.free) notes.push(`招待 ${k}×${after.free}`);
      else if (!after.free) notes.push(`取消招待 ${k}×${before.free}`);
      else notes.push(`招待 ${k} ${before.free}→${after.free}`);
    }
  });
  return notes;
}

function localChangeLog(previousLog, oldItems, newItems) {
  const notes = localDiffItems(oldItems, newItems);
  if (!notes.length) return previousLog;
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return (previousLog ? previousLog + ' ｜ ' : '') + stamp + ' ' + notes.join('、');
}

async function saveOrderEdit() {
  if (!editingOrder || savingOrderEdit) return;

  const items = editingOrder.items.filter(i => i.quantity > 0);
  if (!items.length) { showToast('訂單至少要保留一個品項'); return; }
  if (items.some(i => !i.name)) { showToast('還有品項沒有選擇'); return; }

  // 金額只算收費數量，招待不計入
  const total = items.reduce((sum, i) => sum + i.unitPrice * (i.quantity - (i.freeQty || 0)), 0);

  if (editingOrder.isManual) {
    const orderDate = editingOrder.orderDate;
    const receivedAt = manualDateToIso(orderDate);
    const status = editingOrder.orderStatus || 'new';
    const paymentStatus = editingOrder.orderPayment === 'paid' ? 'paid' : 'unpaid';
    // 2026-08-04 → KG260804，用來檢查伺服器有沒有照指定日期發號
    const expectedPrefix = 'KG' + orderDate.replace(/-/g, '').slice(2);

    closeEditOrder();
    showToast('訂單補登中…');
    savingOrderEdit = true;
    await queueWrite(async () => {
      const res = await apiPostOrder({
        manual: true,
        receivedAt,
        createdAt: receivedAt,
        status,
        paymentStatus,
        tableNumber: null,
        total,
        items,
        meta: { pageUrl: location.href }
      });

      if (res && res.ok) {
        const id = res.orderId || '';
        if (id && id.indexOf(expectedPrefix) !== 0) {
          // 伺服器沒照指定日期發號 → 幾乎都是 Apps Script 還在跑舊版程式碼
          console.warn('expected prefix', expectedPrefix, 'got', id);
          showToast('已補登 ' + id + '，但日期沒生效：請重新部署 Apps Script');
        } else {
          showToast('已補登訂單 ' + id);
        }
        // 跳到補登的那一天，才看得到剛剛建立的訂單
        showHistoryForDate(orderDate);
      } else {
        console.error('manual order failed', res);
        showToast((res && res.error) ? '補登失敗：' + res.error : '補登失敗，請稍後再試');
      }
      refreshAfterWrite();
    });
    savingOrderEdit = false;
    return;
  }

  const orderId = editingOrder.orderId;
  const key = String(orderId);
  const patched = items.map(i => {
    const chargedQty = i.quantity - (i.freeQty || 0);
    return Object.assign({}, i, {
      chargedQty,
      subtotal: i.unitPrice * chargedQty,
      freeAmount: i.unitPrice * (i.freeQty || 0)
    });
  });

  // 跟狀態按鈕一樣採樂觀更新：先關視窗、先更新畫面，
  // 不讓店家對著「儲存中…」等 Apps Script 來回好幾秒。
  const order = findLoadedOrder(orderId);
  const changeLog = order
    ? localChangeLog(order.changeLog || '', order.items || [], patched)
    : '';

  const patch = { items: patched, total, changeLog };
  mergePendingOp(key, patch);
  patchLoadedOrders(orderId, patch);
  repaintOrders();
  closeEditOrder();
  showToast('訂單已更新');   // 畫面已經是新的了，提示不用等伺服器回應

  await queueWrite(async () => {
    const res = await apiPostOrder({ action: 'updateOrder', orderId, items });
    if (res && res.ok) {
      clearPendingOp(key, patch);
      refreshAfterWrite();
      return;
    }

    const probe = await probeOrder(orderId);
    if (!probe.reachable) {
      clearPendingOp(key, patch);
      return;
    }
    if (probe.order && Number(probe.order.total) === Number(total)) {
      clearPendingOp(key, patch);
      refreshAfterWrite();
      return;
    }

    clearPendingOp(key, patch);
    console.error('updateOrder failed', res);
    showToast((res && res.error) ? '儲存失敗：' + res.error : '儲存失敗，請稍後再試');
    refreshAfterWrite();
  });
}

/* ═════════════════════════════
   訂單紀錄
   ═════════════════════════════ */
let orderPollTimer = null;
let historyFetchInFlight = false;
let historySignature = '';
let historyOrders = [];
let historyScope = 'today';

function markHistoryScopeButton(scope) {
  // 只挑訂單紀錄這區的按鈕：統計分頁也用同樣的 class，選太廣會把它的高亮清掉
  document.querySelectorAll('#order-management .history-scope').forEach(b =>
    b.classList.toggle('active', b.getAttribute('data-scope') === scope));
}

// 補登完切到看得到那筆訂單的範圍，否則補登過去的日期會「按了沒反應」
function showHistoryForDate(dateStr) {
  const today = todayInputValue();
  let scope = 'all';
  if (dateStr === today) scope = 'today';
  else if (dateStr.slice(0, 7) === today.slice(0, 7)) scope = 'month';

  historyScope = scope;
  markHistoryScopeButton(scope);
  historySignature = '';
}

function switchHistoryScope(scope) {
  historyScope = scope;
  markHistoryScopeButton(scope);
  historySignature = '';
  document.getElementById('order-list').innerHTML = '<div class="history-empty">讀取中…</div>';
  // 切回「今天」時直接用今日訂單那份資料，不用多打一次 API
  if (scope === 'today') {
    todayOrdersSignature = '';
    refreshTodayOrders();
  } else {
    renderOrderManagement();
  }
}

function orderDateLabel(order) {
  const d = new Date(order.receivedAt || order.createdAt);
  if (isNaN(d.getTime())) return '—';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

function paintHistory() {
  const wrap = document.getElementById('order-list');
  if (!wrap) return;

  if (!historyOrders.length) {
    wrap.innerHTML = '<div class="history-empty">這個範圍內沒有訂單。</div>';
    return;
  }

  // 新的排前面，並依日期分組
  const sorted = historyOrders.slice().sort(byNewestFirst);

  const groups = new Map();
  sorted.forEach(o => {
    const day = orderDateLabel(o);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(o);
  });
  let html = '';
  groups.forEach((list, day) => {
    const dayTotal = list.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
    html += `<div class="history-day">${day}　·　${list.length} 筆　·　NT$${dayTotal}</div>`;
    html += list.map(order => {
      const status = ORDER_STATUS[order.status] ? order.status : 'new';
      const payment = paymentOf(order);
      const items = (order.items || []).map(i => {
        const freeQty = Number(i.freeQty) || 0;
        return `${esc(i.name)}${tempLabel(i.temp)} ×${Number(i.quantity) || 0}` +
               (freeQty ? `<span class="order-item-free">招待${freeQty}</span>` : '');
      }).join('、');
      const id = esc(order.orderId);
      return `
        <div class="history-row">
          <div class="history-main">
            <div class="history-head">
              <span class="history-id">${id}</span>
              <span>${formatOrderClock(order)}</span>
              <span class="history-status is-${status}">${ORDER_STATUS[status].label}</span>
              <span class="pay-badge is-${payment}">${PAYMENT_STATUS[payment].dot} ${PAYMENT_STATUS[payment].label}</span>
              ${order.tableNumber ? `<span>桌號 ${esc(order.tableNumber)}</span>` : ''}
              ${order.nickname ? `<span>${esc(order.nickname)}</span>` : ''}
            </div>
            <div class="history-items">${items}</div>
          </div>
          <span class="history-amt${payment === 'unpaid' ? ' is-unpaid' : ''}">NT$${Number(order.total) || 0}</span>
          <div class="history-actions">
            ${payment === 'unpaid'
              ? `<button class="btn-order btn-order-pay" onclick="setOrderPayment('${id}','paid')">結帳</button>`
              : `<button class="btn-order" onclick="setOrderPayment('${id}','unpaid')">取消結帳</button>`}
            <button class="btn-order" onclick="openEditOrder('${id}')">修改</button>
            <button class="btn-order btn-order-danger" onclick="deleteOrderById('${id}')">刪除</button>
          </div>
        </div>`;
    }).join('');
  });

  wrap.innerHTML = html;
}

async function renderOrderManagement() {
  const wrap = document.getElementById('order-list');
  if (!wrap) return;
  if (historyFetchInFlight || activeWrites > 0) return;

  if (!getOrderEndpoint()) {
    wrap.innerHTML = '<div class="history-empty">尚未設定訂單 API，無法讀取訂單紀錄。</div>';
    return;
  }

  historyFetchInFlight = true;
  let orders;
  try {
    orders = await apiGetOrders(historyScope === 'all' ? '' : historyScope);
  } finally {
    historyFetchInFlight = false;
  }
  if (!orders) return;   // 讀取失敗就維持現有畫面，等下一輪

  // 內容沒變就不重畫，否則畫面會無緣無故閃一下
  const signature = JSON.stringify(orders);
  if (signature === historySignature) return;
  historySignature = signature;

  historyOrders = applyPendingOps(orders);
  paintHistory();
}

// 今日訂單每 4 秒更新一次；「訂單記錄」是整張表的資料、抓起來重，
// 不需要跟著這麼頻繁，改成進入分頁時抓一次，之後每 10 輪（約 40 秒）再抓。
const POLL_INTERVAL = 4000;
const HISTORY_EVERY_N_TICKS = 10;
let orderPollTick = 0;

function orderPollLoop() {
  // 分頁在背景（切到別的視窗、手機鎖屏）時不用一直打 API
  if (document.hidden) return;

  // 連續失敗就拉長間隔，不要在 Apps Script 已經吃不消時繼續猛打
  if (consecutiveFetchFailures > 0) {
    const skipEvery = Math.min(consecutiveFetchFailures + 1, 8);
    if (orderPollTick % skipEvery !== 0) { orderPollTick++; return; }
  }

  orderPollTick++;
  refreshTodayOrders();   // scope=today 時會順便更新訂單紀錄
  if (historyScope !== 'today' && orderPollTick % HISTORY_EVERY_N_TICKS === 0) {
    renderOrderManagement();
  }
}

function startOrderPolling() {
  stopOrderPolling();
  orderPollTick = 0;
  consecutiveFetchFailures = 0;
  refreshTodayOrders();
  if (historyScope !== 'today') renderOrderManagement();
  orderPollTimer = setInterval(orderPollLoop, POLL_INTERVAL);
}

function stopOrderPolling() {
  if (orderPollTimer) {
    clearInterval(orderPollTimer);
    orderPollTimer = null;
  }
}

async function clearTodayOrders() {
  if (!getOrderEndpoint()) {
    showToast('尚未設定訂單 API');
    return;
  }
  if (!confirm('確定要清空今天的所有訂單嗎？\n\nGoogle 試算表上今天的訂單會全部刪除，無法復原。\n（昨天以前的訂單不受影響）')) return;

  const btn = document.getElementById('btn-clear-today');
  if (btn) { btn.disabled = true; btn.textContent = '清除中…'; }

  await queueWrite(async () => {
    const res = await apiPostOrder({ action: 'clearToday', confirm: 'CLEAR_TODAY' });

    if (res && res.ok) {
      showToast(`已清空今日訂單（${res.deletedRows} 列）`);
    } else {
      // 跟其他寫入一樣：查不到不等於失敗，用實際剩下的訂單來判斷
      const orders = await apiGetOrders('today');
      if (!orders) {
        showToast('連線不穩，請重新整理確認結果');
      } else if (!orders.length) {
        showToast('已清空今日訂單');
      } else {
        console.error('clearToday failed', res);
        showToast((res && res.error) ? '清除失敗：' + res.error : '清除失敗，請稍後再試');
      }
    }

    todayOrders = [];
    historyOrders = [];
    todayOrdersSignature = '';
    historySignature = '';
    pendingOps.clear();
    pendingDeletes.clear();
    repaintOrders();
  });

  if (btn) { btn.disabled = false; btn.textContent = '清空今日所有訂單'; }
  refreshTodayOrders();
  renderOrderManagement();
}
