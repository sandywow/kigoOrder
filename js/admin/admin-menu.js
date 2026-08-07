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
    state.menuData[catKey].push({ name: '新品項', nameJp: null, desc: null, price: 'NT$0', tag: null, image: null, emoji: null });
    renderMenuEditor(catKey);
  };
  wrap.appendChild(addBtn);
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
          <label>標籤 <span class="hint">（可空白）</span></label>
          <input type="text" value="${esc(item.tag)}" placeholder="限定"
            oninput="updateItem('${catKey}',${idx},'tag',this.value)">
        </div>
      </div>
      <div class="field">
        <label>圖片網址 <span class="hint">（空白 = 不顯示）</span></label>
        <input type="text" value="${esc(item.image)}" placeholder="src/photo.jpg 或圖片網址"
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
