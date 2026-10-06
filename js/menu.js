/* ═════════════════════
   LOAD ADMIN OVERRIDES
   ═════════════════════ */
// 資料優先順序：Google Sheets（js/menu-api.js）> 這裡的後台 localStorage > js/config.js
//
// ⚠ 這支檔案在 js/menu-api.js 之後才執行，所以「遠端已經套好的欄位」要跳過，
//   不然剛拿到的共同菜單資料會被後台存的舊值原封蓋回去 ——
//   首頁 banner 就是這樣一直停在 config.js 的 src/BANNER*.jpg。
//   Sheets 沒有管到的欄位（例如 orderEndpoint、桌號）照舊沿用後台設定。
(function () {
  // 瀏覽器封鎖網站資料時，光是讀 localStorage 就會丟 SecurityError。
  // 這裡沒接住的話整支 menu.js 會停在這行，客人就完全不能點餐。
  var stored = null;
  try { stored = localStorage.getItem('kigoMenuConfig'); } catch (e) {}
  if (!stored) return;
  var remote = (window.KigoMenuApi && window.KigoMenuApi.remote) || {};
  var remoteLanding = remote.landingKeys || {};
  try {
    var c = JSON.parse(stored);
    if (c.menuData && !remote.menuData)
      Object.keys(c.menuData).forEach(function(k) { menuData[k] = c.menuData[k]; });
    if (c.landingData)   Object.keys(c.landingData).forEach(function(k) {
      if (remoteLanding[k]) return;
      if (c.landingData[k] !== null) landingData[k] = c.landingData[k];
    });
    if (c.tabs && !remote.tabs)          { tabs.length = 0; c.tabs.forEach(function(t) { tabs.push(t); }); }
    if (c.sectionTitles && !remote.sectionTitles) Object.assign(sectionTitles, c.sectionTitles);
  } catch(e) {}
})();

/* ═════════════════════
   入座資訊（桌號／暱稱）
   ═════════════════════ */
// 用 sessionStorage 而不是 localStorage：桌號只在這次來店有效。
// 存到 localStorage 的話，客人下次來會沿用上次的桌號，送出的單就會送錯桌。
const SEATING_KEY = 'kigoSeating';

// 光靠分頁還不夠：手機上分頁常常開著沒關，隔天回到同一個分頁桌號還在，
// 單就送去錯的桌了。所以超過這個時間沒動作就重問一次。
const SEATING_TTL_MS = 2 * 60 * 60 * 1000;   // 2 小時

let seating = null;          // { tableNumber, nickname, savedAt }
let seatingDraftTable = null;  // 表單上「已選但還沒按確認」的桌號
let seatingOnConfirm = null;   // 確認後要做的事（第一次是進菜單，之後是單純修改）

function seatingExpired(record) {
  // 舊格式沒有 savedAt（時效上線前存的），一律當作過期重問，不要沿用不知道多久前的桌號
  const savedAt = record && Number(record.savedAt);
  return !savedAt || Date.now() - savedAt > SEATING_TTL_MS;
}

function loadSeating() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(SEATING_KEY));
    if (stored && stored.tableNumber && !seatingExpired(stored)) seating = stored;
    else if (stored) sessionStorage.removeItem(SEATING_KEY);
  } catch (e) {}
}

function saveSeating() {
  if (seating) seating.savedAt = Date.now();
  try { sessionStorage.setItem(SEATING_KEY, JSON.stringify(seating)); } catch (e) {}
}

function clearSeating() {
  seating = null;
  try { sessionStorage.removeItem(SEATING_KEY); } catch (e) {}
  paintSeatingChip();
}

// 分頁被切回前景、或準備送單時檢查一次 ——
// 只在載入時檢查是不夠的，分頁擺在背景幾小時再回來根本不會重新載入。
// 回傳 true 表示已過期、畫面已經被蓋掉，呼叫端接下來什麼都別做。
function ensureSeatingFresh() {
  if (!seating || !seatingExpired(seating)) return false;
  showSessionExpired();
  return true;
}

// 這次來店結束了：清掉入座資訊和購物車，蓋上一層走不出去的說明畫面。
// 不提供「重新選桌號」的入口是刻意的 —— 隔了兩小時以上，人可能早就換位子或離開了，
// 在舊分頁裡自己改桌號很容易改錯，一定要重新掃桌上的 QR Code 才對得起實際位子。
// 重新掃描會開新分頁（或重新載入），那時 loadSeating() 讀不到有效資料，就是全新的一次點餐。
function showSessionExpired() {
  clearSeating();
  cart.length = 0;
  renderCart();
  closeCart();
  closeAddToCartModal();
  closeSeatingForm();

  const overlay = document.getElementById('session-expired');
  if (!overlay) return;
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
}

function tableOptions() {
  const list = Array.isArray(landingData.tableNumbers) ? landingData.tableNumbers.filter(Boolean) : [];
  return list.map(String);
}

function paintSeatingTables() {
  const wrap = document.getElementById('seating-tables');
  if (!wrap) return;
  const options = tableOptions();

  if (!options.length) {
    // 桌號清單被清空時還是要能點餐，退回讓客人自己輸入
    wrap.innerHTML = `<input class="seating-input" id="seating-table-free" type="text" maxlength="20"
      placeholder="請輸入桌號" value="${seatingDraftTable ? escAttr(seatingDraftTable) : ''}"
      oninput="setSeatingTable(this.value)">`;
    return;
  }

  // 桌號字串要先 JSON.stringify 成 JS 字面值，再 escAttr 把引號轉成實體 ——
  // 直接放進 onclick="..." 的話，值裡的雙引號會把屬性截斷。
  // 數字包一層 span：菱形是兩個絕對定位的 ::before / ::after，
  // 沒有這層包裝的話文字會被壓在菱形底下。
  wrap.innerHTML = options.map(t => `
    <button type="button" class="seating-table${t === seatingDraftTable ? ' selected' : ''}"
            role="radio" aria-checked="${t === seatingDraftTable}"
            onclick="setSeatingTable(${escAttr(JSON.stringify(t))}, true)"><span
            class="seating-table-num">${escHtml(t)}</span></button>`).join('');
}

function setSeatingTable(value, repaint) {
  seatingDraftTable = String(value || '').trim() || null;
  if (seatingDraftTable) document.getElementById('seating-error').textContent = '';
  if (repaint) paintSeatingTables();
}

// 第一次進菜單一定要填，所以不給取消；之後從桌號按鈕進來只是修改，可以取消。
function openSeatingForm(onConfirm) {
  seatingOnConfirm = typeof onConfirm === 'function' ? onConfirm : null;
  const first = !seating;

  seatingDraftTable = seating ? seating.tableNumber : null;
  document.getElementById('seating-nickname').value = seating ? (seating.nickname || '') : '';
  document.getElementById('seating-error').textContent = '';
  paintSeatingTables();

  document.getElementById('seating-title').textContent = first ? '入座資訊' : '修改入座資訊';
  document.querySelector('#seating-modal .option-confirm').textContent = first ? '開始點餐' : '儲存';
  // 還沒填過就沒有「取消」這條路 —— 關掉了會停在一個沒有桌號的菜單
  document.getElementById('seating-close').style.display = first ? 'none' : '';
  document.getElementById('seating-cancel').style.display = first ? 'none' : '';

  document.getElementById('seating-backdrop').classList.add('open');
  document.getElementById('seating-modal').classList.add('open');
  document.getElementById('seating-modal').setAttribute('aria-hidden', 'false');
}

function closeSeatingForm() {
  document.getElementById('seating-backdrop').classList.remove('open');
  document.getElementById('seating-modal').classList.remove('open');
  document.getElementById('seating-modal').setAttribute('aria-hidden', 'true');
  seatingOnConfirm = null;
}

function confirmSeating() {
  if (!seatingDraftTable) {
    document.getElementById('seating-error').textContent = '請先選擇桌號';
    return;
  }
  seating = {
    tableNumber: seatingDraftTable,
    nickname: document.getElementById('seating-nickname').value.trim()
  };
  saveSeating();
  paintSeatingChip();

  const next = seatingOnConfirm;
  closeSeatingForm();
  if (next) next();
}

function paintSeatingChip() {
  const chip = document.getElementById('seating-chip');
  if (!chip) return;
  if (!seating) { chip.style.display = 'none'; return; }
  chip.style.display = '';
  const who = seating.nickname ? ` · ${seating.nickname}` : '';
  chip.innerHTML = `桌號 ${escHtml(seating.tableNumber)}${escHtml(who)} <span class="seating-chip-edit">修改</span>`;
}

/* ═════════════════════
   PAGE TRANSITIONS
   ═════════════════════ */
function showMenu(initialKey) {
  // 從成功頁按「返回菜單」時可能已經隔很久了，進菜單前先確認這次點餐還有效
  if (ensureSeatingFresh()) return;
  // 桌號是必填的，還沒填就先擋在入座資訊表單，填完再自動進菜單
  if (!seating) {
    openSeatingForm(() => showMenu(initialKey));
    return;
  }

  const key = initialKey || tabs[0].key;
  document.getElementById('landing').classList.replace('visible', 'hidden');
  const menuPage = document.getElementById('menu-page');
  menuPage.classList.replace('hidden', 'visible');
  menuPage.scrollTop = 0;

  // Activate correct tab, then render
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-key') === key);
  });
  renderSection(key);
}

function showLanding() {
  document.getElementById('menu-page').classList.replace('visible', 'hidden');
  document.getElementById('landing').classList.replace('hidden', 'visible');
  document.getElementById('landing').scrollTop = 0;
}

/* ═════════════════════
   TAB SWITCHING
   ═════════════════════ */
function switchTab(category, btn) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderSection(category);
  scrollToSectionTop();
}

/* 切分類後捲回這一區的最上面。

   頁籤列是 sticky 的（top:0，黏在 #menu-page 這個捲動容器的上緣），
   但捲動的時候瀏覽器不知道它會黏在那裡 —— 直接把 #menu-content 對齊容器頂端，
   分類標題就正好躲到頁籤列後面被吃掉了。所以目標位置要再往上扣掉頁籤列的高度。

   高度是當場量的，不是寫死的數字：頁籤文字換行、字級調整都會改變它。 */
function scrollToSectionTop() {
  const page    = document.getElementById('menu-page');
  const content = document.getElementById('menu-content');
  if (!page || !content) return;

  const bar = document.getElementById('tab-bar');
  const top = content.offsetTop - (bar ? Math.ceil(bar.getBoundingClientRect().height) : 0);

  // 只在「已經捲過頭、標題會被蓋住」時才捲。還在上面（看得到菜單標題）
  // 就不要自作主張把畫面往下拉。
  if (page.scrollTop > top) page.scrollTo({ top: top, behavior: 'smooth' });
}

/* ═════════════════════
   RENDER SECTIONS
   ═════════════════════ */
/* 冰熱標示：熱＝♨️ 的三道波、冰＝藍色的雪花，直接跟在品名後面。

   用 inline SVG 而不是直接打 emoji：emoji 的長相與顏色由各家系統的字型
   決定（而且 ♨️ 一定連下面那個湯池一起出現），顏色也沒辦法自己指定。 */

// ♨️ 的三道波。Twemoji（CC-BY 4.0）原本是「填滿的外框」，粗細綁死在形狀裡
// 改不了，所以這裡改成描它的中線再用 stroke 畫 —— 起伏的位置與幅度都是從
// 原路徑兩側取中點算出來的（頂點 10,1 → 最左 8,8 → 最右 13.1,19 → 收尾 9.3,27.4），
// 波形跟 emoji 一樣，差別只有顏色與現在可以自由調的筆畫粗細。
var TEMP_ICON_HOT = '<svg class="temp-icon temp-icon-hot" viewBox="6 0 23 28.5" fill="none" ' +
  'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">' +
  '<path d="M10 1C10 4 8 5 8 8C8 11.5 13.1 15 13.1 19C13.1 23 11.5 26.5 9.3 27.4"/>' +
  '<path d="M17 1C17 4 15 5 15 8C15 11.5 20.1 15 20.1 19C20.1 23 18.5 26.5 16.3 27.4"/>' +
  '<path d="M24 1C24 4 22 5 22 8C22 11.5 27.1 15 27.1 19C27.1 23 25.5 26.5 23.3 27.4"/></svg>';

var TEMP_ICON_COLD = '<svg class="temp-icon temp-icon-cold" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="1.35" stroke-linecap="round" aria-hidden="true">' +
  '<path d="M12 2.7L12 21.3M20.05 7.35L3.95 16.65M20.05 16.65L3.95 7.35' +
  'M12 6.6l2.38-1.66M12 6.6l-2.38-1.66M16.68 9.3l2.63 1.23M16.68 9.3l.25-2.89' +
  'M16.68 14.7l.25 2.89M16.68 14.7l2.63-1.23M12 17.4l-2.38 1.66M12 17.4l2.38 1.66' +
  'M7.32 14.7l-2.63-1.23M7.32 14.7l-.25 2.89M7.32 9.3l-.25-2.89M7.32 9.3l-2.63 1.23"/></svg>';

// 沒設定溫度的品項（以及分類把冰熱顯示關掉時）不會有圖示 ——
// 不像以前的圓點需要留空白佔位，圖示是跟在品名後面的，沒有就是沒有。
function tempIcons(temp) {
  if (!temp) return '';
  var out = '';
  if (temp === 'hot'  || temp === 'both') out += TEMP_ICON_HOT;
  if (temp === 'iced' || temp === 'both') out += TEMP_ICON_COLD;
  return out ? `<span class="temp-icons">${out}</span>` : '';
}

function renderSection(category) {
  const container = document.getElementById('menu-content');
  const items = menuData[category] || [];
  const t = sectionTitles[category] || { en: category, jp: null };
  let html = `<div class="menu-section active">`;

  if (t.en || t.jp) {
    html += `<div class="section-intro">
      ${t.en ? `<h3>${t.en}</h3>` : ''}
      ${t.jp ? `<p>${t.jp}</p>` : ''}
    </div>`;
  }

  items.forEach((item, i) => {
    const imgHtml = item.image
      ? `<img src="${item.image}" alt="${item.name || ''}" loading="lazy">`
      : '';
    const imgBlock   = imgHtml ? `<div class="menu-item-img-wrap">${imgHtml}</div>` : '';
    const rightBlock = imgBlock ? `<div class="menu-item-right">${imgBlock}</div>` : '';
    // 標籤可以填多個：用逗號或頓號隔開（半形 , 全形 ， 頓號 、都認），
    // 前台會拆成一顆一顆的膠囊排在同一列。目前的標籤都沒有這些符號，
    // 所以舊資料的顯示完全不受影響。
    const tagHtml = String(item.tag == null ? '' : item.tag)
      .split(/[,，、]/)
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => `<span class="item-tag">${s}</span>`)
      .join('');
    const soldOutHtml = item.soldOut ? `<span class="item-tag item-tag-soldout">售完</span>` : '';
    // 標籤一律自己一行，排在品名底下 —— 品名長短不一時才不會忽上忽下
    const tagsHtml   = (tagHtml || soldOutHtml) ? `<div class="menu-item-tags">${tagHtml}${soldOutHtml}</div>` : '';
    const nameHtml   = item.name   ? `<span class="menu-item-name">${item.name}</span>` : '';
    const nameJpHtml = item.nameJp ? `<div class="menu-item-name-jp">${item.nameJp.replace(/\n/g, '<br>')}</div>` : '';
    const descHtml   = item.desc   ? `<p class="menu-item-desc">${item.desc.replace(/\n/g, '<br>')}</p>` : '';
    const priceHtml  = item.price  ? `<div class="menu-item-price">${item.price}</div>` : '';
    // 加入購物車改成價格後面的一顆圓形＋。沒有文字了，所以 aria-label 要把
    // 「加入什麼」講清楚，報讀軟體才不會一整排都念成「按鈕」。
    // 沒有單價（試算表 price 欄留白）的品項只展示、不開放線上點，免得變成 0 元的單
    const addBtn     = (item.soldOut || itemUnitPrice(item) === null) ? '' :
      `<button class="add-to-cart" onclick="addToCart('${category}',${i})"` +
      ` aria-label="加入購物車：${(item.name || '').replace(/"/g, '&quot;')}" title="加入購物車">` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">` +
      `<path d="M12 6v12M6 12h12"/></svg></button>`;
    const priceRow   = (priceHtml || addBtn)
      ? `<div class="menu-item-price-row">${priceHtml}${addBtn}</div>` : '';

    html += `
      <div class="menu-item${item.soldOut ? ' menu-item-soldout' : ''}" style="animation-delay:${i * 0.07}s">
        <div class="menu-item-body">
          <div class="menu-item-top">${nameHtml}${tempIcons(item.temp)}</div>
          ${tagsHtml}
          ${nameJpHtml}
          ${descHtml}
          ${priceRow}
        </div>
        ${rightBlock}
      </div>`;
  });

  html += `<div class="ornament" style="padding:28px 0">✦ &nbsp; ✦ &nbsp; ✦</div></div>`;
  container.innerHTML = html;
}

/* ═══════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════ */
// 菜單內容是自己維護的所以直接內插，但暱稱和桌號是客人打的字，
// 進到 innerHTML 之前一定要跳脫。
function escHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(value) {
  return escHtml(value).replace(/"/g, '&quot;');
}

function setOrHide(id, val, useInnerHTML = false) {
  const el = document.getElementById(id);
  if (!el) return;
  if (val) {
    if (useInnerHTML) el.innerHTML = val; else el.textContent = val;
    el.style.display = '';
  } else {
    el.style.display = 'none';
  }
}

// 菜單入口的每個字各自套一個小圓框，所以要把標題拆成一個字一個 span。
// 用 Array.from 而不是 split('')：emoji 與某些符號是兩個 code unit，
// split('') 會把它們切成兩半變成亂碼。
// 用 createElement + textContent 而不是拼 HTML 字串 —— 這段文字是後台輸入的，
// 這樣寫就沒有跳脫字元的問題。
function setCtaButton(label) {
  const el = document.getElementById('cta-btn');
  if (!el) return;

  const text = String(label == null ? '' : label).trim();
  if (!text) { el.style.display = 'none'; return; }

  el.style.display = '';
  el.textContent = '';
  Array.from(text).forEach(ch => {
    const span = document.createElement('span');
    if (ch.trim() === '') {
      span.className = 'btn-menu-gap';      // 空白不套圈，只留間隔
    } else {
      span.className = 'btn-menu-char';
      span.textContent = ch;
    }
    el.appendChild(span);
  });
}

function hideEl(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

function showToast(msg, duration = 2800) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => toast.classList.remove('show'), duration);
}

/* ═══════════════════════════════════
   BUILD TABS
   ═══════════════════════════════════════════ */
function buildTabs() {
  const bar = document.getElementById('tab-bar');
  bar.innerHTML = '';
  tabs.forEach((tab, i) => {
    const btn = document.createElement('button');
    btn.className = 'tab-btn' + (i === 0 ? ' active' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('data-key', tab.key);
    btn.textContent = tab.label;
    btn.onclick = () => switchTab(tab.key, btn);
    bar.appendChild(btn);
  });
}
let bannerCarouselTimer = null;
let bannerCarouselIndex = 0;
let bannerCarouselImages = [];
let pendingCartSelection = null;

function clearBannerCarousel() {
  if (bannerCarouselTimer) {
    clearTimeout(bannerCarouselTimer);
    bannerCarouselTimer = null;
  }
}

function updateBannerDisplayHeight(bannerDisplay, img) {
  if (!bannerDisplay || !img || !img.naturalWidth) return;
  const width = bannerDisplay.clientWidth;
  const height = Math.round((img.naturalHeight / img.naturalWidth) * width);
  bannerDisplay.style.height = `${height}px`;
}


// 下一張海報先抓起來放進瀏覽器快取。不預載的話，5 秒後切換的那一刻才開始
// 下載＋解碼 2~3 MB 的圖，淡入會卡住。同一個網址只抓一次，之後由快取供應。
const bannerPreloaded = new Set();

function preloadNextBanner() {
  if (bannerCarouselImages.length < 2) return;
  const next = bannerCarouselImages[(bannerCarouselIndex + 1) % bannerCarouselImages.length];
  if (!next || bannerPreloaded.has(next)) return;
  bannerPreloaded.add(next);
  const img = new Image();
  img.decoding = 'async';
  img.src = next;
}

function scheduleBannerCarousel() {
  clearBannerCarousel();
  if (bannerCarouselImages.length < 2) return;
  const delay = 5000;
  bannerCarouselTimer = setTimeout(() => {
    renderBannerSlide(bannerCarouselIndex + 1);
    scheduleBannerCarousel();
  }, delay);
}

function renderBannerSlide(index, noFade) {
  const bannerDisplay = document.getElementById('banner-display');
  if (!bannerDisplay || !bannerCarouselImages.length) return;
  bannerCarouselIndex = ((index % bannerCarouselImages.length) + bannerCarouselImages.length) % bannerCarouselImages.length;
  const src = bannerCarouselImages[bannerCarouselIndex];
  const dots = bannerCarouselImages.map((_, i) =>
    `<button type="button" class="banner-carousel-dot${i === bannerCarouselIndex ? ' active' : ''}" data-index="${i}" aria-label="切換至第 ${i + 1} 張海報"></button>`
  ).join('');

  let dotsWrapper = bannerDisplay.querySelector('.banner-carousel-dots');
  if (!dotsWrapper) {
    dotsWrapper = document.createElement('div');
    dotsWrapper.className = 'banner-carousel-dots';
    dotsWrapper.setAttribute('aria-label', '海報輪播指示');
    bannerDisplay.appendChild(dotsWrapper);
  }
  dotsWrapper.innerHTML = dots;

  const previousSlide = bannerDisplay.querySelector('.banner-slide.visible');
  const slide = document.createElement('div');
  slide.className = 'banner-slide';
  slide.dataset.slideIndex = bannerCarouselIndex;
  slide.style.zIndex = previousSlide ? 2 : 1;
  // decoding="async"：4500×7775 的原圖解碼要好幾百毫秒，不丟出主執行緒的話
  // 那段時間捲動與淡入動畫都會頓。fetchpriority 只給第一張（noFade=首次渲染），
  // 它是首屏最大的元素，值得插隊。
  slide.innerHTML = `<img src="${src}" alt="${landingData.bannerAlt || '當季推薦'}"` +
    ` decoding="async"${noFade ? ' fetchpriority="high"' : ''}>`;
  bannerDisplay.insertBefore(slide, dotsWrapper);

  const img = slide.querySelector('img');
  if (img) {
    if (img.complete && img.naturalWidth) {
      updateBannerDisplayHeight(bannerDisplay, img);
      preloadNextBanner();
    } else {
      img.addEventListener('load', () => {
        updateBannerDisplayHeight(bannerDisplay, img);
        // 這一張載完才去抓下一張，兩張不會搶頻寬
        preloadNextBanner();
      }, { once: true });
    }
  }

  if (previousSlide) {
    previousSlide.style.zIndex = 1;
  }

  if (noFade) {
    slide.classList.add('visible');
  } else {
    setTimeout(() => slide.classList.add('visible'), 40);
  }

  if (previousSlide) {
    setTimeout(() => {
      if (previousSlide.parentNode) previousSlide.parentNode.removeChild(previousSlide);
    }, 2600);
  }

  bannerDisplay.querySelectorAll('.banner-carousel-dot').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.index);
      clearBannerCarousel();
      renderBannerSlide(idx);
      scheduleBannerCarousel();
    });
  });
}
// ─────────────────────────────────────
//  Shopping cart (client-side)
// ─────────────────────────────────────
let cart = [];

// 品項單價。回傳 null = 沒有可用的單價，這個品項不開放線上點。
// 遠端菜單有 priceValue（試算表 price 欄的數字，留白是 null）就只看它 ——
// 顯示用的 price 可能是「2入 NT$180」「NT$1,200」這種文字，抓第一組數字會抓錯。
// config.js 的備援資料沒有 priceValue，才退回從顯示文字找 NT$ 後面的數字。
// 送單後伺服器會再用 Items 工作表核對一次，以那邊為準。
function itemUnitPrice(item) {
  if (!item) return null;
  if (Object.prototype.hasOwnProperty.call(item, 'priceValue')) {
    const v = item.priceValue;
    return (typeof v === 'number' && isFinite(v) && v >= 0) ? v : null;
  }
  if (!item.price) return null;
  const text = String(item.price).replace(/,/g, '');
  const m = text.match(/NT\$\s*(\d+)/i) || text.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function addToCart(cat, idx) {
  const item = (menuData[cat] || [])[idx];
  if (!item) return;
  if (item.soldOut) { showToast('此品項已售完'); return; }
  if (itemUnitPrice(item) === null) { showToast('此品項暫不開放線上點餐'); return; }
  openAddToCartModal(cat, idx);
}

function openAddToCartModal(cat, idx) {
  const item = (menuData[cat] || [])[idx];
  if (!item) return;
  pendingCartSelection = { cat, idx, qty: 1 };
  const modal = document.getElementById('item-option-modal');
  const backdrop = document.getElementById('item-option-backdrop');
  if (!modal || !backdrop) return;

  modal.querySelector('.modal-item-name').textContent = item.name || '';
  modal.querySelector('.modal-item-unit-price').textContent = item.price || '';
  const pickerContainer = modal.querySelector('#modal-temp-picker');
  const quantityInput = modal.querySelector('#modal-qty-input');
  const priceEl = modal.querySelector('.modal-item-price');

  quantityInput.value = 1;
  updateModalTotal();

  if (item.temp === 'both') {
    pickerContainer.innerHTML = `
      <div class="option-row">
        <div class="option-field-label">溫度<span class="required-mark">＊</span></div>
        <div class="modal-temp-options">
          <label><input type="radio" name="modal-temp" value="hot"> 熱</label>
          <label><input type="radio" name="modal-temp" value="iced"> 冰</label>
        </div>
      </div>`;
  } else if (item.temp === 'hot' || item.temp === 'iced') {
    const label = item.temp === 'hot' ? '熱' : '冰';
    pickerContainer.innerHTML = `
      <div class="option-row">
        <div class="option-field-label">溫度</div>
        <span>${label}</span>
      </div>`;
  } else {
    pickerContainer.innerHTML = '';
  }

  const imageWrap = modal.querySelector('.modal-item-image-wrap');
  const imageEl = modal.querySelector('.modal-item-image');
  if (imageWrap && imageEl) {
    if (item.image) {
      imageEl.src = item.image;
      imageEl.alt = item.name || '';
      imageWrap.style.display = '';
    } else {
      imageEl.removeAttribute('src');
      imageWrap.style.display = 'none';
    }
  }

  backdrop.classList.add('open');
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}

function updateModalTotal() {
  const item = pendingCartSelection ? (menuData[pendingCartSelection.cat] || [])[pendingCartSelection.idx] : null;
  const input = document.getElementById('modal-qty-input');
  const priceEl = document.querySelector('.modal-item-price');
  if (!item || !input || !priceEl) return;
  let qty = parseInt(input.value, 10);
  if (!qty || qty < 1) qty = 1;
  if (qty > MAX_ITEM_QTY) qty = MAX_ITEM_QTY;
  const total = (itemUnitPrice(item) || 0) * qty;
  priceEl.textContent = `NT$${total}`;
}

function closeAddToCartModal() {
  const modal = document.getElementById('item-option-modal');
  const backdrop = document.getElementById('item-option-backdrop');
  if (modal) { modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); }
  if (backdrop) backdrop.classList.remove('open');
  pendingCartSelection = null;
  flushPendingMenu();
}

function changeModalQty(delta) {
  const input = document.getElementById('modal-qty-input');
  if (!input) return;
  let value = parseInt(input.value, 10) || 1;
  value = Math.min(MAX_ITEM_QTY, Math.max(1, value + delta));
  input.value = value;
  updateModalTotal();
}

function confirmAddToCart() {
  if (!pendingCartSelection) return;
  if (blockedBySubmitting()) return;
  const { cat, idx } = pendingCartSelection;
  const item = (menuData[cat] || [])[idx];
  if (!item) { closeAddToCartModal(); return; }

  const input = document.getElementById('modal-qty-input');
  let qty = input ? parseInt(input.value, 10) : 1;
  if (!qty || qty < 1) qty = 1;
  if (qty > MAX_ITEM_QTY) qty = MAX_ITEM_QTY;

  let temp = null;
  if (item.temp === 'both') {
    const selected = document.querySelector('input[name="modal-temp"]:checked');
    if (!selected) { showToast('請選擇溫度'); return; }
    temp = selected.value;
  } else if (item.temp === 'hot' || item.temp === 'iced') {
    temp = item.temp;
  }

  const found = cart.find(c => c.cat === cat && c.idx === idx && c.temp === temp);
  if (found) {
    found.qty = Math.min(MAX_ITEM_QTY, found.qty + qty);
  } else {
    cart.push({ cat, idx, qty, temp });
  }

  renderCart();
  showToast('已加入購物車');
  closeAddToCartModal();
}

function toggleCart() {
  const drawer = document.getElementById('cart-drawer');
  const backdrop = document.getElementById('cart-backdrop');
  const open = !drawer.classList.contains('open');
  drawer.classList.toggle('open', open);
  backdrop.classList.toggle('open', open);
  drawer.setAttribute('aria-hidden', String(!open));
  if (open) renderCart();
}

function openCart() { document.getElementById('cart-drawer').classList.add('open'); document.getElementById('cart-backdrop').classList.add('open'); renderCart(); }
function closeCart() { document.getElementById('cart-drawer').classList.remove('open'); document.getElementById('cart-backdrop').classList.remove('open'); }

function renderCart() {
  const wrap = document.getElementById('cart-items');
  const countEl = document.getElementById('cart-count');
  const totalEl = document.getElementById('cart-total');
  if (!wrap) return;
  if (!cart.length) {
    wrap.innerHTML = '<div class="cart-empty">購物車目前是空的</div>';
    countEl.textContent = '0';
    totalEl.textContent = 'NT$0';
    flushPendingMenu();
    return;
  }
  let html = '';
  let total = 0;
  cart.forEach((c, i) => {
    const item = (menuData[c.cat] || [])[c.idx] || {};
    const price = itemUnitPrice(item) || 0;
    total += price * c.qty;
    const tempLabel = c.temp ? ` <span class="cart-item-temp">(${c.temp === 'hot' ? '熱' : c.temp === 'iced' ? '冰' : c.temp})</span>` : '';
    html += `<div class="cart-item">
      <div class="cart-item-info">
        <div class="cart-item-name">${item.name || ''}${tempLabel}</div>
        <div class="cart-item-controls">NT$${price} × <button onclick="changeQty(${i},-1)">-</button> <span class="cart-qty">${c.qty}</span> <button onclick="changeQty(${i},1)">+</button></div>
      </div>
      <div class="cart-item-remove"><button onclick="removeCartItem(${i})">移除</button></div>
    </div>`;
  });
  wrap.innerHTML = html;
  countEl.textContent = String(cart.reduce((s, c) => s + c.qty, 0));
  totalEl.textContent = 'NT$' + total;
}

function changeQty(i, delta) {
  if (blockedBySubmitting()) return;
  if (!cart[i]) return;
  cart[i].qty = Math.min(MAX_ITEM_QTY, cart[i].qty + delta);
  if (cart[i].qty <= 0) cart.splice(i, 1);
  renderCart();
}

function removeCartItem(i) { if (blockedBySubmitting()) return; cart.splice(i, 1); renderCart(); }

function clearCart() { if (blockedBySubmitting()) return; if (!confirm('清空購物車？')) return; cart.length = 0; renderCart(); }

function saveOrderToHistory(order) {
  try {
    const history = JSON.parse(localStorage.getItem('kigoOrderHistory')) || [];
    history.push(order);
    localStorage.setItem('kigoOrderHistory', JSON.stringify(history));
  } catch (e) {}
}

// 訂單編號格式：KG + 西元年後兩碼 + 月日(MMDD) + 當天第幾張訂單(3碼)，例如 KG260805001。
// 正常情況下編號是由伺服器發的（多人同時點餐才不會撞號），
// 這裡算的只是「還沒連上伺服器」時的備用號碼。
function generateOrderId() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(-2);
  const mm = pad(now.getMonth() + 1);
  const dd = pad(now.getDate());
  const dateKey = `${now.getFullYear()}-${mm}-${dd}`;

  let seq = null;
  try { seq = JSON.parse(localStorage.getItem('kigoOrderSeq')); } catch (e) {}
  if (!seq || seq.date !== dateKey) seq = { date: dateKey, count: 0 };
  seq.count += 1;
  // 寫不進去（空間滿了、被封鎖）也不能擋住送單
  try { localStorage.setItem('kigoOrderSeq', JSON.stringify(seq)); } catch (e) {}

  return `KG${yy}${mm}${dd}${String(seq.count).padStart(3, '0')}`;
}

function formatOrderTime(iso) {
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function receiptItemRow(item) {
  const tempLabel = item.temp ? ` <span class="cart-item-temp">(${item.temp === 'hot' ? '熱' : item.temp === 'iced' ? '冰' : item.temp})</span>` : '';
  const subtotal = (item.unitPrice || 0) * (item.quantity || 0);
  return `<div class="receipt-item-row">
      <div class="receipt-item-name">${item.name || ''}${tempLabel}</div>
      <div class="receipt-item-line"><span>NT$${item.unitPrice || 0} × ${item.quantity || 0}</span><span>NT$${subtotal}</span></div>
    </div>`;
}

let lastOrder = null;

function setReceiptRow(rowId, valueId, value) {
  const row = document.getElementById(rowId);
  if (!row) return;
  if (value) {
    document.getElementById(valueId).textContent = value;
    row.style.display = '';
  } else {
    row.style.display = 'none';
  }
}

function showOrderSuccess(order) {
  lastOrder = order;

  // 走到這裡時伺服器已經回應了，order.orderId 就是試算表上的編號
  document.getElementById('receipt-order-id').textContent = order.orderId || '';
  document.getElementById('receipt-order-time').textContent = formatOrderTime(order.createdAt);
  document.getElementById('receipt-table-number').textContent = order.tableNumber || '—';
  // 暱稱沒填就整列不顯示，收據才不會多一行空的
  setReceiptRow('receipt-nickname-row', 'receipt-nickname', order.nickname);
  document.getElementById('receipt-items').innerHTML = order.items.map(receiptItemRow).join('');
  document.getElementById('receipt-total').textContent = 'NT$' + order.total;

  document.getElementById('menu-page').classList.replace('visible', 'hidden');
  const successPage = document.getElementById('order-success-page');
  successPage.classList.replace('hidden', 'visible');
  successPage.scrollTop = 0;
}

function backToMenuFromSuccess() {
  lastOrder = null;
  cart.length = 0;
  renderCart();
  document.getElementById('order-success-page').classList.replace('visible', 'hidden');
  showMenu();
  // 點餐中擱著的新菜單，購物車清空了就可以套（這條路不會經過首頁）
  flushPendingMenu();
}

// 購物車空了、加入購物車視窗也關了 → 把點餐途中擱著的新菜單套上去（見 js/menu-api.js）。
// 用 setTimeout 讓目前這一輪的畫面更新先做完，再換資料重畫。
function flushPendingMenu() {
  if (cart.length || pendingCartSelection) return;
  setTimeout(() => {
    if (window.KigoMenuApi && typeof window.KigoMenuApi.flushPending === 'function') {
      window.KigoMenuApi.flushPending();
    }
  }, 0);
}

// 遠端菜單晚到、客人已經在菜單頁時，menu-api.js 套完資料會呼叫這裡重畫目前的分類。
// initLanding() 會重建頁籤（回到第一個），這裡把原本看的分類和捲動位置還原。
function rerenderMenuPage(prevKey) {
  const menuPage = document.getElementById('menu-page');
  if (!menuPage || !menuPage.classList.contains('visible') || !tabs.length) return;
  const key = tabs.some(t => t.key === prevKey) ? prevKey : tabs[0].key;
  const scrollTop = menuPage.scrollTop;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-key') === key);
  });
  renderSection(key);
  menuPage.scrollTop = scrollTop;
}

function submitOrder() {
  if (orderSubmitting) return;
  if (!cart.length) { showToast('購物車為空'); return; }
  // 送單是最不能送錯桌的一刻，這裡再確認一次入座資訊沒過期。
  // 過期的話畫面會被 session 過期那層蓋掉，這張單就不送了。
  if (ensureSeatingFresh()) return;
  // 正常流程進菜單前就填過了，這裡是保險：分頁還原、sessionStorage 被清掉時
  // 還是要有桌號才能送單，否則店家收到一張不知道要送去哪的訂單。
  // 這種情況桌號只是沒讀到、東西是客人剛點的，填完就直接幫他送出去。
  if (!seating) {
    closeCart();
    openSeatingForm(() => submitOrder());
    return;
  }
  const orderItems = cart.map(c => {
    const item = (menuData[c.cat] || [])[c.idx] || {};
    return {
      name: item.name || '',
      category: c.cat,
      quantity: c.qty,
      temp: c.temp || null,
      id: item.id || null,
      unitPrice: itemUnitPrice(item) || 0
    };
  });
  const total = orderItems.reduce((sum, item) => sum + (item.unitPrice || 0) * item.quantity, 0);

  // 這張單的識別碼：上一次送出沒確認成功、內容也沒變 → 沿用同一組，伺服器會認出是重送，不會多一張。
  // 內容變了就不能沿用（伺服器會回傳舊內容，新加的東西就不見了），但上一次可能其實成功了，先問客人。
  const fingerprint = orderFingerprint(orderItems, seating);
  let requestId;
  if (unconfirmedOrder && unconfirmedOrder.fingerprint === fingerprint) {
    requestId = unconfirmedOrder.requestId;
  } else {
    if (unconfirmedOrder && !confirm('上一次送出的訂單可能已經成功了，請先向店員確認。\n\n確定要用目前的購物車再送一張新的訂單嗎？')) return;
    requestId = newRequestId();
  }
  unconfirmedOrder = { requestId, fingerprint };

  const payload = {
    clientRequestId: requestId,
    orderId: generateOrderId(),
    createdAt: new Date().toISOString(),
    tableNumber: seating ? seating.tableNumber : null,
    nickname: seating ? seating.nickname : '',
    total,
    items: orderItems,
    meta: {
      pageUrl: location.href
    }
  };

  // 剛送出一單，人顯然還在店裡，時效從現在重新起算，免得續攤加點時被叫去重填
  saveSeating();

  const endpoint = landingData.orderEndpoint;

  // 沒有設定送單網址（本機測試）就只存本機紀錄
  if (!endpoint) {
    unconfirmedOrder = null;
    saveOrderToHistory(payload);
    finishOrder(payload);
    return;
  }

  // 一定要等伺服器回 ok 才算成功。以前是先顯示成功頁、背景再送，
  // 送失敗客人也不知道，店家那邊就漏單了。
  orderSubmitting = true;
  setOrderSubmittingUi(true);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), ORDER_TIMEOUT_MS) : null;
  const done = () => {
    clearTimeout(timer);
    orderSubmitting = false;
    setOrderSubmittingUi(false);
  };

  // Content-Type 用 text/plain：Google Apps Script Web App 沒有處理 CORS 預檢(OPTIONS)，
  // 用 application/json 會觸發預檢而直接失敗。body 內容仍是 JSON 字串，後端自行 JSON.parse。
  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    signal: controller ? controller.signal : undefined
  })
    .then(res => {
      if (!res.ok) throw new Error('伺服器回應錯誤');
      return res.json();
    })
    .then(data => {
      if (!data || data.ok === false) throw new Error((data && data.error) || '伺服器回應錯誤');
      return data;
    })
    .then(data => {
      done();
      unconfirmedOrder = null;   // 伺服器確認收到了（重送的話是原本那張），下一張用新的識別碼
      // 以伺服器發的編號為準，才會跟 Google 試算表上的一致
      if (data.orderId) payload.orderId = data.orderId;
      // 單價以伺服器核對 Items 工作表後的為準（客人的菜單可能是舊價），收據照這份顯示。
      // 伺服器會濾掉無效品項，數量對不上就不套，維持原本的顯示。
      if (Array.isArray(data.items) && data.items.length === payload.items.length) {
        data.items.forEach((s, i) => { payload.items[i].unitPrice = Number(s.unitPrice) || 0; });
        if (typeof data.total === 'number') payload.total = data.total;
      }
      saveOrderToHistory(payload);
      finishOrder(payload);
    }, err => {
      done();
      console.error('Sync order to Sheets failed:', err);
      // 購物車原封不動留著，unconfirmedOrder 也留著：內容沒改就再按一次，
      // 會沿用同一組識別碼，伺服器其實已經收到的話只會回傳原本那張，不會多一張。
      const timedOut = err && err.name === 'AbortError';
      showToast((timedOut ? '連線逾時' : '訂單送出失敗') + '\n請再按一次「送出訂單」', 6000);
    });
}

const ORDER_TIMEOUT_MS = 30000;   // 伺服器搶鎖最多等 20 秒，再留一點餘裕

// 每個品項最多點幾份。伺服器 Code.gs 的 ORDER_MAX_QTY 超過就整張單拒收，兩邊要一致。
const MAX_ITEM_QTY = 99;

// 送出了但還沒確認成功的那張單：{ requestId, fingerprint }。成功就清掉，失敗就留著給重送用。
// 只放在記憶體：重新整理頁面購物車也會清空，沒有東西可以重送。
let unconfirmedOrder = null;

function newRequestId() {
  if (window.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

// 判斷「這次要送的跟上次是不是同一張單」：品項、數量、冰熱、桌號、暱稱都一樣才算
function orderFingerprint(items, seat) {
  return JSON.stringify([
    items.map(i => [i.id, i.name, i.category, i.quantity, i.temp]),
    seat ? seat.tableNumber : null,
    seat ? seat.nickname : null
  ]);
}
let orderSubmitting = false;

// 送單中：按鈕改成「送出中…」並停用，購物車裡的按鈕一起擋住，
// 免得送出的內容跟畫面上的購物車對不起來
function setOrderSubmittingUi(busy) {
  const drawer = document.getElementById('cart-drawer');
  if (drawer) drawer.classList.toggle('is-submitting', busy);
  const sending = document.getElementById('order-sending');
  if (sending) {
    sending.classList.toggle('open', busy);
    sending.setAttribute('aria-hidden', String(!busy));
  }
  document.querySelectorAll('.cart-submit').forEach(btn => {
    btn.disabled = busy;
    btn.textContent = busy ? '送出中…' : '送出訂單';
  });
}

function blockedBySubmitting() {
  if (!orderSubmitting) return false;
  showToast('訂單送出中，請稍候');
  return true;
}

function finishOrder(payload) {
  cart.length = 0;
  renderCart();
  closeCart();
  showOrderSuccess(payload);
}
/* ═══════════════════════════════════
   INIT
   ═══════════════════════════════════════════ */
function initLanding() {
  const ld = landingData;

  /* ── Header ── */
  setOrHide('cafe-name', ld.cafeName);
  setOrHide('cafe-sub',  ld.cafeSub);
  if (ld.showDate) {
    const d = new Date();
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const dateStr = `${months[d.getMonth()]} ${d.getDate()}`;
    const full = ld.dateSeasonLabel ? `${dateStr} &nbsp;·&nbsp; ${ld.dateSeasonLabel}` : dateStr;
    setOrHide('landing-date-line', full, true);
  } else {
    hideEl('landing-date-line');
  }

  /* ── Hero image (single image override) ── */
  const heroVisual = document.getElementById('hero-visual');
  if (ld.heroImage) {
    heroVisual.innerHTML = `<img class="hero-img" src="${ld.heroImage}" alt="${ld.heroTitle || '季節主視覺'}" loading="lazy">`;
  }
  setOrHide('hero-badge',    ld.heroBadge);
  setOrHide('hero-title',    ld.heroTitle);
  setOrHide('hero-subtitle', ld.heroSubtitle);

  /* ── Tagline ── */
  const taglineBlock = document.querySelector('.tagline-block');
  if (ld.tagline) {
    setOrHide('landing-tagline',    ld.tagline, true);
    setOrHide('landing-tagline-jp', ld.taglineJp);
    if (taglineBlock) taglineBlock.style.display = '';
  } else {
    if (taglineBlock) taglineBlock.style.display = 'none';
  }

  /* ── Seasonal card ── */
  const card = document.getElementById('seasonal-card');
  if (ld.cardLabel) {
    setOrHide('card-label-text', ld.cardLabel);
    setOrHide('card-name',       ld.cardName);
    setOrHide('card-name-jp',    ld.cardNameJp);
    setOrHide('card-desc',       ld.cardDesc);
    setOrHide('card-price',      ld.cardPrice);
    setOrHide('card-tag',        ld.cardTag);
    if (card) card.style.display = '';
  } else {
    if (card) card.style.display = 'none';
  }

  /* ── Banner ──
     bannerImage 有值 → 顯示圖片
     bannerImage null + bannerPlaceholder true → 顯示佔位符
     bannerImage null + bannerPlaceholder false/null → 整區塊隱藏 */
  const bannerSection = document.getElementById('banner-section');
  const bannerDisplay = document.getElementById('banner-display');
  clearBannerCarousel();
  bannerCarouselImages = Array.isArray(ld.bannerImages) ? ld.bannerImages.filter(Boolean) : [];
  bannerCarouselIndex = 0;
  setOrHide('banner-label-text', ld.bannerLabel);

  // initLanding() 會被重跑（遠端菜單晚一步到就是走這條路）。
  // 上一輪沒有海報時整個區塊被設成 display:none，這裡不先解除的話，
  // 遠端補上海報後圖只是畫進一個看不見的容器裡，畫面上永遠不會出現。
  if (bannerSection) bannerSection.style.display = '';

  // 沒有快取時不畫 config.js 的舊海報（見 js/menu-api.js 的 bannerState）：
  // 等遠端時顯示咖啡杯載入動畫；遠端失敗就整區隱藏，不退回舊海報。
  const menuApi = window.KigoMenuApi;
  const bannerState = (menuApi && menuApi.bannerState) ? menuApi.bannerState() : 'ready';
  const hasRemoteBanner = !!(menuApi && menuApi.remote && menuApi.remote.landingKeys &&
    menuApi.remote.landingKeys.bannerImages);

  if (bannerState === 'waiting') {
    if (bannerDisplay) {
      bannerDisplay.style.height = '';
      bannerDisplay.innerHTML = `
        <div class="banner-loading" role="status" aria-label="海報載入中">
          <svg class="banner-loading-cup" viewBox="0 0 64 64" aria-hidden="true">
            <path class="steam s1" d="M24 22c-3-4 3-6 0-10s3-6 0-9"/>
            <path class="steam s2" d="M32 22c-3-4 3-6 0-10s3-6 0-9"/>
            <path class="steam s3" d="M40 22c-3-4 3-6 0-10s3-6 0-9"/>
            <path class="cup" d="M14 28h36v8c0 9-7 16-16 16h-4c-9 0-16-7-16-16z"/>
            <path class="cup" d="M50 31h3a6 6 0 0 1 0 12h-4"/>
            <path class="cup" d="M10 57h44"/>
          </svg>
          <div class="banner-loading-text">Brewing</div>
        </div>`;
    }
  } else if (bannerState === 'failed' && !hasRemoteBanner) {
    if (bannerDisplay) bannerDisplay.innerHTML = '';
    if (bannerSection) bannerSection.style.display = 'none';
  } else if (bannerCarouselImages.length) {
    // 上一輪留下的單張圖／佔位符要清掉，否則會疊在輪播圖底下。
    // .banner-slide 不能清 —— renderBannerSlide 要靠舊的那張做淡入交接。
    const stale = bannerDisplay ? bannerDisplay.querySelector('.banner-img-wrap, .banner-placeholder, .banner-loading') : null;
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
    renderBannerSlide(0, true);
    scheduleBannerCarousel();
  } else if (ld.bannerImage) {
    bannerDisplay.innerHTML =
      `<div class="banner-img-wrap"><img src="${ld.bannerImage}" alt="${ld.bannerAlt || '當季推薦'}"></div>`;
  } else if (ld.bannerPlaceholder) {
    bannerDisplay.innerHTML = `
      <div class="banner-placeholder">
        <div class="banner-placeholder-icon">🌿</div>
        <div class="banner-placeholder-text">
          當季推薦海報<br>
          <span style="font-size:11px;opacity:0.7;letter-spacing:0.1em">在 bannerImage 填入圖片網址</span>
        </div>
      </div>`;
  } else {
    if (bannerSection) bannerSection.style.display = 'none';
  }

  /* ── CTA ── */
  setCtaButton(ld.ctaButton);
  setOrHide('cta-hint', ld.ctaHint);

  /* ── Footer ── */
  setOrHide('footer-left',  ld.footerLeft);
  setOrHide('footer-right', ld.footerRight);
  if (!ld.footerLeft && !ld.footerRight) hideEl('landing-footer');

  /* ── Menu page header ── */
  setOrHide('menu-title-text',    ld.menuTitle);
  setOrHide('menu-subtitle-text', ld.menuSubtitle);

  /* ── Menu page small logo ── */
  const logoWrap = document.getElementById('menu-logo-wrap');
  if (logoWrap && (ld.cafeName || ld.cafeSub)) {
    logoWrap.innerHTML =
      (ld.cafeName ? `<div class="cafe-logo-text" style="font-size:21px;line-height:1.2">${ld.cafeName}</div>` : '') +
      (ld.cafeSub  ? `<div class="cafe-logo-jp"   style="font-size:10px">${ld.cafeSub}</div>`  : '');
  }

  buildTabs();

  /* ── 入座資訊 ── */
  // 同一次來店中重新整理頁面時，桌號要還在，不要叫客人重填一次
  // （sessionStorage 會在分頁關閉時清掉，超過 SEATING_TTL_MS 也會失效）
  loadSeating();
  paintSeatingChip();

  /* ── Apply visibility flags from landingData ── */
  const landing = document.getElementById('landing');
  landing.classList.toggle('hide-hero',   !!ld.hideHero);
  landing.classList.toggle('hide-card',   !!ld.hideCard);
  landing.classList.toggle('hide-banner', !!ld.hideBanner);
}

document.addEventListener('DOMContentLoaded', initLanding);

// 分頁擺在背景不會重新載入，所以回到前景時補檢查一次入座資訊有沒有過期。
// 過期就當場蓋上說明畫面，不要等到客人點完一輪按送出才發現白點了。
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') ensureSeatingFresh();
});
