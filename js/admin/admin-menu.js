function buildCatTabs() {
  const wrap = document.getElementById('cat-tabs');
  if (!wrap) return;
  wrap.innerHTML = '';
  Object.keys(state.menuData || {}).forEach((key, index) => {
    const button = document.createElement('button');
    button.className = 'cat-tab' + (index === 0 ? ' active' : '');
    button.textContent = key;
    button.onclick = () => {
      document.querySelectorAll('.cat-tab').forEach(b => b.classList.remove('active'));
      button.classList.add('active');
      renderMenuEditor(key);
    };
    wrap.appendChild(button);
  });
  const firstKey = Object.keys(state.menuData || {})[0];
  if (firstKey) renderMenuEditor(firstKey);
}

function renderMenuEditor(catKey) {
  const wrap = document.getElementById('menu-editor');
  if (!wrap) return;
  const items = state.menuData[catKey] || [];
  const withTemp = items.some(item => item.temp !== undefined);
  wrap.innerHTML = '';

  items.forEach((item, idx) => wrap.appendChild(buildItemCard(catKey, item, idx, withTemp, items.length)));

  const addBtn = document.createElement('button');
  addBtn.className = 'btn-add';
  addBtn.textContent = '＋ 新增品項';
  addBtn.onclick = () => {
    if (!state.menuData[catKey]) state.menuData[catKey] = [];
    // 價格預設留白：留白＝前台不開放點。以前預設 NT$0，忘了改就變成 0 元可以點
    state.menuData[catKey].push({ name: '新品項', nameJp: null, desc: null, price: null, tag: null, image: null, emoji: null });
    renderMenuEditor(catKey);
  };
  wrap.appendChild(addBtn);

  const linkBtn = document.createElement('button');
  linkBtn.className = 'btn-add';
  linkBtn.textContent = '＋ 從其他分類加入';
  linkBtn.onclick = () => openLinkItemModal(catKey);
  wrap.appendChild(linkBtn);
}

/* ── 從其他分類加入 ──
   把別的分類裡「已經存在的商品」加進這個分類。帶著同一個 id 複製一份進來，
   儲存時 buildItemsTable 會認出是同一個商品，所以 Items 不會多一列，
   只會在 ItemCategories 多一條連結；之後在這裡按「移除」也只拆掉這條連結。 */
let linkTargetCat = null;

function openLinkItemModal(catKey) {
  linkTargetCat = catKey;
  const tabLabel = key => ((state.tabs || []).find(t => t.key === key) || {}).label || key;
  document.getElementById('link-item-title').textContent = '加入到「' + tabLabel(catKey) + '」';

  const inTarget = {};
  (state.menuData[catKey] || []).forEach(item => { if (item.id) inTarget[item.id] = true; });

  // 同一個商品可能在好幾個分類，清單裡只列一次（列在第一個出現的分類下）
  const seen = {};
  let html = '';
  Object.keys(state.menuData || {}).forEach(key => {
    if (key === catKey) return;
    const rows = [];
    (state.menuData[key] || []).forEach((item, idx) => {
      if (item.id && seen[item.id]) return;
      if (item.id) seen[item.id] = true;
      const already = item.id && inTarget[item.id];
      const note = !item.id ? '尚未儲存，請先儲存一次' : already ? '已在這個分類' : (item.price || '');
      rows.push(`<button class="link-item-row" ${!item.id || already ? 'disabled' : ''}
        onclick="linkExistingItem('${key}',${idx})">
        <span class="link-item-name">${esc(item.name) || '（未命名）'}</span>
        <span class="link-item-note">${esc(note)}</span>
      </button>`);
    });
    if (rows.length) html += `<div class="link-item-group">${esc(tabLabel(key))}</div>` + rows.join('');
  });

  document.getElementById('link-item-body').innerHTML = html || '<p class="modal-hint">其他分類還沒有商品</p>';
  document.getElementById('link-item-backdrop').classList.add('open');
  document.getElementById('link-item-modal').classList.add('open');
}

function closeLinkItemModal() {
  linkTargetCat = null;
  document.getElementById('link-item-backdrop').classList.remove('open');
  document.getElementById('link-item-modal').classList.remove('open');
}

function linkExistingItem(fromKey, idx) {
  const catKey = linkTargetCat;
  const src = (state.menuData[fromKey] || [])[idx];
  if (!catKey || !src || !src.id) return;
  if (!state.menuData[catKey]) state.menuData[catKey] = [];
  if (state.menuData[catKey].some(item => item.id === src.id)) { closeLinkItemModal(); return; }

  const copy = deepClone(src);
  // 連結資訊是「這個分類的」，不能沿用來源分類的排序，否則 keepsExistingOrder 會判斷錯
  copy.linkCategoryKey = catKey;
  copy.linkSortOrder   = null;
  copy.linkActive      = true;
  state.menuData[catKey].push(copy);
  adminEdited = true;

  closeLinkItemModal();
  renderMenuEditor(catKey);
  showToast('已加入「' + (src.name || '品項') + '」，記得按儲存');
}

function buildItemCard(catKey, item, idx, withTemp, total) {
  const card = document.createElement('div');
  card.className = 'item-card' + (item.soldOut ? ' is-soldout' : '');

  const sel = () => ['', 'hot', 'iced', 'both'].map(o =>
    `<option value="${o}" ${item.temp === o || (!item.temp && o === '') ? 'selected' : ''}>${
      o === '' ? '不顯示' : o === 'hot' ? '熱' : o === 'iced' ? '冰' : '冰 · 熱'
    }</option>`
  ).join('');

  const upSvg   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 15l-6-6-6 6"/></svg>`;
  const downSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>`;

  card.innerHTML = `
    <div class="item-card-header" onclick="toggleCard(this)">
      <span class="item-card-name">${esc(item.name) || '（未命名）'}</span>
      <span class="soldout-badge"${item.soldOut ? '' : ' style="display:none"'}>售完</span>
      <div class="item-card-actions">
        <button class="btn-move" onclick="event.stopPropagation(); moveItem('${catKey}',${idx},-1)" ${idx === 0 ? 'disabled' : ''}>${upSvg}</button>
        <button class="btn-move" onclick="event.stopPropagation(); moveItem('${catKey}',${idx},1)" ${idx === total - 1 ? 'disabled' : ''}>${downSvg}</button>
        <button class="btn-remove" onclick="event.stopPropagation(); removeItem('${catKey}',${idx})">移除</button>
        <span class="item-chevron">▼</span>
      </div>
    </div>
    <div class="item-fields">
      <div class="toggle-row">
        <span class="toggle-label">售完</span>
        <label class="toggle">
          <input type="checkbox" ${item.soldOut ? 'checked' : ''} onchange="
            updateItem('${catKey}',${idx},'soldOut',this.checked);
            const c=this.closest('.item-card');
            c.classList.toggle('is-soldout',this.checked);
            c.querySelector('.soldout-badge').style.display=this.checked?'':'none';
          ">
          <span class="toggle-track"></span>
        </label>
      </div>
      <div class="field-row">
        <div class="field">
          <label>品名</label>
          <input type="text" value="${esc(item.name)}"
            oninput="updateItem('${catKey}',${idx},'name',this.value);
                     this.closest('.item-card').querySelector('.item-card-name').textContent=this.value||'（未命名）'">
        </div>
        <div class="field">
          <label>副品名 <span class="hint">（可空白，換行會顯示在網頁）</span></label>
          <textarea oninput="updateItem('${catKey}',${idx},'nameJp',this.value)">${esc(item.nameJp)}</textarea>
        </div>
      </div>
      <div class="field">
        <label>說明文字</label>
        <textarea oninput="updateItem('${catKey}',${idx},'desc',this.value)">${esc(item.desc)}</textarea>
      </div>
      <div class="field-row">
        <div class="field">
          <label>價格</label>
          <input type="text" value="${esc(item.price)}" placeholder="NT$0"
            oninput="updateItem('${catKey}',${idx},'price',this.value)">
        </div>
        <div class="field">
          <label>標籤 <span class="hint">（可空白；多個用、隔開）</span></label>
          <input type="text" value="${esc(item.tag)}" placeholder="限定"
            oninput="updateItem('${catKey}',${idx},'tag',this.value)">
        </div>
      </div>
      <div class="field">
        <label>圖片路徑 <span class="hint">（例：src/photo.jpg；也可貼完整網址，空白 = 不顯示）</span></label>
        <input type="text" value="${esc(item.image)}" placeholder="src/photo.jpg"
          oninput="updateItem('${catKey}',${idx},'image',this.value)">
      </div>
      <div class="field"><label>溫度選項</label><select onchange="updateItem('${catKey}',${idx},'temp',this.value)">${sel()}</select></div>
    </div>`;
  return card;
}

function toggleCard(header) {
  header.closest('.item-card').classList.toggle('collapsed');
}

function moveItem(catKey, idx, dir) {
  const items = state.menuData[catKey];
  const newIdx = idx + dir;
  if (!items || newIdx < 0 || newIdx >= items.length) return;
  [items[idx], items[newIdx]] = [items[newIdx], items[idx]];
  renderMenuEditor(catKey);
}

function removeItem(catKey, idx) {
  if (!confirm('確定要移除「' + (state.menuData[catKey][idx].name || '這個品項') + '」嗎？')) return;
  state.menuData[catKey].splice(idx, 1);
  renderMenuEditor(catKey);
}

function updateItem(catKey, idx, field, value) {
  if (!state.menuData[catKey] || !state.menuData[catKey][idx]) return;
  state.menuData[catKey][idx][field] = (field === 'soldOut') ? value : ne(value);
}

function esc(s) { return (s == null ? '' : String(s)).replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
