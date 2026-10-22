function switchPanel(name, btn) {
  document.querySelectorAll('.admin-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.admin-tab').forEach(b => b.classList.remove('active'));
  const panel = document.getElementById('panel-' + name);
  if (panel) panel.classList.add('active');
  if (btn) btn.classList.add('active');

  if (name === 'orders') {
    startOrderPolling();
  } else {
    stopOrderPolling();
  }
  if (name === 'stats') renderSalesStats();
}

/* ═════════════════════════════
   小便籤：所有裝置同步
   內容存在 Apps Script（Code.gs 的 readNotepad / handleSaveNotepad），每台裝置看到同一份。
   - 打字停 0.8 秒自動存上去，存好顯示 ✓；沒存成功顯示 ⚠，過一陣子自動重試
   - 每 30 秒、以及切回這個分頁時，抓一次最新的（別台裝置改的會出現在這裡）
   - 正在打字、或打了還沒存上去的時候，不拿伺服器的內容蓋掉
   這台裝置的瀏覽器也留一份（localStorage），開頁時先顯示它，連不上伺服器時也看得到。
   ═════════════════════════════ */
const NOTEPAD_LOCAL_KEY = 'kigoNotepad';
const NOTEPAD_SAVE_DELAY_MS = 800;
const NOTEPAD_SYNC_MS = 30000;
let notepadSaveTimer = null;
let notepadDirty = false;        // 打了字、還沒確定存上伺服器
let notepadSyncedAt = null;      // 這台裝置手上那份，在伺服器上的 updatedAt

function initNotepad() {
  const box = document.getElementById('notepad-text');
  if (!box) return;
  try { box.value = localStorage.getItem(NOTEPAD_LOCAL_KEY) || ''; } catch (e) {}

  box.addEventListener('input', () => {
    notepadDirty = true;
    setNotepadStatus('');
    clearTimeout(notepadSaveTimer);
    notepadSaveTimer = setTimeout(saveNotepad, NOTEPAD_SAVE_DELAY_MS);
  });

  pullNotepad();
  setInterval(pullNotepad, NOTEPAD_SYNC_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pullNotepad();
  });
}

async function saveNotepad() {
  const box = document.getElementById('notepad-text');
  if (!box) return;
  const text = box.value;
  try { localStorage.setItem(NOTEPAD_LOCAL_KEY, text); } catch (e) {}

  // apiPostOrder 會自己帶 token（在 admin-orders.js）
  const res = await apiPostOrder({ action: 'saveNotepad', text });
  if (res && res.ok && res.updatedAt) {
    notepadSyncedAt = res.updatedAt;
    // 存的途中又打了字：這次存的已經不是最新的，等下一輪的自動儲存
    if (box.value === text) notepadDirty = false;
    setNotepadStatus('✓');
    setTimeout(() => setNotepadStatus(''), 1500);
  } else {
    setNotepadStatus('⚠', '還沒同步到其他裝置，稍後會自動再試');
    clearTimeout(notepadSaveTimer);
    notepadSaveTimer = setTimeout(saveNotepad, NOTEPAD_SYNC_MS);
  }
}

async function pullNotepad() {
  const box = document.getElementById('notepad-text');
  if (!box || notepadDirty || document.activeElement === box) return;
  const endpoint = getOrderEndpoint();
  const token = menuWriteTokenValue();
  if (!endpoint || !token) return;

  let data = null;
  try {
    const url = endpoint + (endpoint.includes('?') ? '&' : '?') +
      'action=notepad&token=' + encodeURIComponent(token);
    data = await (await fetch(url, { cache: 'no-store' })).json();
  } catch (e) {
    return;   // 連不上就先用手上這份，下一輪再試
  }
  // Apps Script 還沒部署成有便籤的版本時，回應裡沒有 text，當作不支援、照舊只存本機
  if (!data || !data.ok || typeof data.text !== 'string') return;
  // 等回應的這段時間裡開始打字了：不要蓋掉
  if (notepadDirty || document.activeElement === box) return;

  if (!data.updatedAt) {
    // 伺服器上從來沒存過：這台裝置以前只存在本機的便籤，順手搬上去給其他裝置
    if (box.value) { notepadDirty = true; saveNotepad(); }
    return;
  }
  if (data.updatedAt === notepadSyncedAt) return;   // 沒有人改過
  notepadSyncedAt = data.updatedAt;
  box.value = data.text;
  try { localStorage.setItem(NOTEPAD_LOCAL_KEY, data.text); } catch (e) {}
}

function setNotepadStatus(text, title) {
  const el = document.getElementById('notepad-status');
  if (!el) return;
  el.textContent = text;
  el.title = title || '';
}

function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}
