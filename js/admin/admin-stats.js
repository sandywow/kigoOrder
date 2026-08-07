/* ═════════════════════════════
   統計
   金額一律只算收費的部分，招待另外統計。
   ═════════════════════════════ */
let statsScope = 'today';
let statsOrders = [];
let statsFetchInFlight = false;

function switchStatsScope(scope, btn) {
  statsScope = scope;
  document.querySelectorAll('#panel-stats .history-scope').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.getElementById('stats-date-row').style.display = scope === 'date' ? '' : 'none';

  if (scope === 'date') {
    const input = document.getElementById('stats-date');
    if (!input.value) {
      const d = new Date();
      const pad = n => String(n).padStart(2, '0');
      input.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
  }
  renderSalesStats();
}

function calculateSalesStats(orders) {
  const stats = {
    revenue: 0,        // 營業額（不含招待）
    orderCount: orders.length,
    freeAmount: 0,     // 招待金額
    items: new Map()   // 品名 -> { sold, charged, free, chargedAmount, freeAmount }
  };

  orders.forEach(order => {
    stats.revenue += Number(order.total) || 0;

    (order.items || []).forEach(item => {
      const name = item.name || '未知品項';
      const quantity = Number(item.quantity) || 0;
      const freeQty = Number(item.freeQty) || 0;
      const chargedQty = item.chargedQty != null ? Number(item.chargedQty) : quantity - freeQty;
      const unitPrice = Number(item.unitPrice) || 0;
      const chargedAmount = Number(item.subtotal) || chargedQty * unitPrice;
      const freeAmount = Number(item.freeAmount) || freeQty * unitPrice;

      stats.freeAmount += freeAmount;

      const row = stats.items.get(name) ||
        { sold: 0, charged: 0, free: 0, chargedAmount: 0, freeAmount: 0 };
      row.sold += quantity;          // 售出數量含招待
      row.charged += chargedQty;
      row.free += freeQty;
      row.chargedAmount += chargedAmount;
      row.freeAmount += freeAmount;
      stats.items.set(name, row);
    });
  });

  return stats;
}

async function renderSalesStats() {
  const totalsEl = document.getElementById('stat-total-sales');
  if (!totalsEl) return;

  const endpoint = (state.landingData && state.landingData.orderEndpoint) || null;
  if (!endpoint) {
    document.getElementById('stat-items').innerHTML =
      '<div class="history-empty">尚未設定訂單 API，無法讀取統計資料。</div>';
    return;
  }
  if (statsFetchInFlight) return;

  const dateValue = document.getElementById('stats-date').value;
  if (statsScope === 'date' && !dateValue) return;

  statsFetchInFlight = true;
  let orders;
  try {
    orders = await apiGetOrders(statsScope, statsScope === 'date' ? dateValue : null);
  } finally {
    statsFetchInFlight = false;
  }
  if (!orders) {
    document.getElementById('stat-items').innerHTML =
      '<div class="history-empty">讀取統計資料失敗，請稍後再試。</div>';
    return;
  }

  statsOrders = orders;
  paintSalesStats();
}

function paintSalesStats() {
  const stats = calculateSalesStats(statsOrders);

  document.getElementById('stat-total-sales').textContent = 'NT$' + stats.revenue;
  document.getElementById('stat-order-count').textContent = String(stats.orderCount);
  document.getElementById('stat-free-amount').textContent = 'NT$' + stats.freeAmount;
  renderCashBox();

  const wrap = document.getElementById('stat-items');
  if (!stats.items.size) {
    wrap.innerHTML = '<div class="history-empty">這個範圍內沒有銷售資料。</div>';
    return;
  }

  const rows = Array.from(stats.items.entries())
    .sort((a, b) => b[1].sold - a[1].sold)
    .map(([name, r]) => `
      <tr>
        <td>${esc(name)}</td>
        <td>${r.sold}</td>
        <td>${r.charged}</td>
        <td class="stat-free-cell">${r.free || '—'}</td>
        <td>NT$${r.chargedAmount}</td>
        <td class="stat-free-cell">${r.freeAmount ? 'NT$' + r.freeAmount : '—'}</td>
      </tr>`).join('');

  wrap.innerHTML = `
    <div class="stat-scroll">
      <table class="stat-table">
        <thead><tr>
          <th>品項</th><th>售出<br>(含招待)</th><th>收費<br>數量</th>
          <th>招待<br>數量</th><th>收費金額</th><th>招待金額</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// 開店現金 + 今日營收（不含招待）= 錢包應有金額
function renderCashBox() {
  const input = document.getElementById('stat-opening-cash');
  if (!input) return;

  const opening = Number(input.value) || 0;
  localStorage.setItem('kigoOpeningCash', String(opening));

  const revenue = calculateSalesStats(statsOrders).revenue;
  document.getElementById('cash-opening').textContent = 'NT$' + opening;
  document.getElementById('cash-income').textContent = 'NT$' + revenue;
  document.getElementById('cash-expected').textContent = 'NT$' + (opening + revenue);
}

function initStats() {
  const input = document.getElementById('stat-opening-cash');
  if (input) input.value = localStorage.getItem('kigoOpeningCash') || '';
}
