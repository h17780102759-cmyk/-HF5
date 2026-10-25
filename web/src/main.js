/* ============================================================
   写作器 — 基于 CodeMirror 6
   功能：书籍章节、撤销重做、错别字、排版、灵感、设置、导出
   ============================================================ */

import { EditorState } from "@codemirror/state";
import { EditorView, keymap, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, undo as undoCommand, redo as redoCommand } from "@codemirror/commands";

import {
  loadBooks, loadChapters, createBook, addChapter, saveChapter,
  deleteChapter, deleteBook, updateBookWordCount,
  BOOK_KEY, CHAPTER_KEY
} from "./db.js";

import { SENTENCE_LIB, GENRE_LIST, GENRE_NAME } from "./data.js";
import { runFormat, checkQuotePairs } from "./format.js";
import { detectTypos, lineOfIndex } from "./typo.js";
import { buildDocFile } from "./export.js";

/* ============================================================
   全局状态
   ============================================================ */
const S = {
  books: [],
  chapters: [],
  bookId: null,
  chapterId: null,
  chapterTitle: "",
  env: { theme: "dark", size: 17, line: 2.1, width: 760, tex: "paper", texOpacity: 8 },
  genre: "通用",
  userSent: {},
  hiddenSent: {},
  mode: null,
  panelData: null
};

const ENV_KEY = "xiezuoqi.env.v2";
const GENRE_KEY = "xiezuoqi.genre.v2";
const USER_SENT_KEY = "xiezuoqi.userSent.v2";
const HIDDEN_KEY = "xiezuoqi.hiddenSent.v2";

/* ============================================================
   工具函数
   ============================================================ */
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function setStatus(msg, kind) {
  const el = $("status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = kind || "";
  if (msg) {
    clearTimeout(setStatus._t);
    setStatus._t = setTimeout(() => { el.textContent = ""; el.className = ""; }, 2500);
  }
}

function countStats(text) {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const words = (text.match(/[A-Za-z0-9]+/g) || []).length;
  const paras = text.split(/\n/).filter((l) => l.trim().length > 0).length;
  return { chars: cjk + words, paras };
}

/* ============================================================
   编辑器
   ============================================================ */
let view = null;

function getDoc() { return view ? view.state.doc.toString() : ""; }
function setDoc(text) {
  if (!view) return;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text || "" }
  });
}

function createEditor(parent) {
  const theme = EditorView.theme({
    "&": { height: "100%", fontSize: "var(--ed-size)", backgroundColor: "transparent", color: "var(--text)" },
    ".cm-scroller": {
      fontFamily: 'var(--ed-font)', lineHeight: "var(--ed-line)",
      padding: "32px 20px", overflowY: "auto",
      backgroundColor: "transparent"
    },
    ".cm-content": {
      caretColor: "var(--accent)", maxWidth: "var(--ed-width)",
      margin: "0 auto", backgroundColor: "transparent"
    },
    ".cm-line": { padding: "0" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor": { borderLeftWidth: "2px", borderLeftColor: "var(--accent)" },
    ".cm-selectionBackground": { backgroundColor: "rgba(91,141,214,.3) !important" }
  });

  view = new EditorView({
    state: EditorState.create({
      doc: "",
      extensions: [
        history(),
        drawSelection(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        theme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            refreshStats();
            scheduleSave();
          }
        })
      ]
    }),
    parent
  });
}

function undo() {
  if (!view) return;
  undoCommand({ state: view.state, dispatch: view.dispatch });
}

function redo() {
  if (!view) return;
  redoCommand({ state: view.state, dispatch: view.dispatch });
}

/* ============================================================
   字数统计
   ============================================================ */
function refreshStats() {
  const s = countStats(getDoc());
  const e1 = $("statChars"), e2 = $("statParas");
  if (e1) e1.textContent = s.chars + " 字";
  if (e2) e2.textContent = s.paras + " 段";
}

/* ============================================================
   自动保存
   ============================================================ */
let saveTimer = null;
let lastSavedText = "";

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrent, 1500);
}

function saveCurrent(showMsg) {
  if (!S.chapterId) return;
  const text = getDoc();
  if (text === lastSavedText && !showMsg) return;

  const chap = { id: S.chapterId, bookId: S.bookId, title: S.chapterTitle, text, order: 0 };
  const idx = S.chapters.findIndex((c) => c.id === S.chapterId);
  if (idx >= 0) chap.order = S.chapters[idx].order;

  saveChapter(chap).then(() => {
    lastSavedText = text;
    const i = S.chapters.findIndex((c) => c.id === S.chapterId);
    if (i >= 0) S.chapters[i].text = text;
    if (S.bookId) updateBookWordCount(S.bookId);
    if (showMsg) setStatus("已保存", "ok");
  }).catch((e) => setStatus("保存失败：" + e.message, "warn"));
}

/* ============================================================
   书籍 / 章节
   ============================================================ */
function openChapter(list, idx) {
  const ch = list[idx];
  if (!ch) return;
  S.chapterId = ch.id;
  S.chapterTitle = ch.title || "未命名";
  lastSavedText = ch.text || "";
  setDoc(ch.text || "");
  refreshStats();
  try { localStorage.setItem(CHAPTER_KEY, ch.id); } catch (e) {}
  renderDrawer();
}

function switchBook(bookId) {
  saveCurrent();
  S.bookId = bookId;
  try { localStorage.setItem(BOOK_KEY, bookId); } catch (e) {}
  loadChapters(bookId).then((list) => {
    S.chapters = list;
    if (list.length === 0) {
      addChapter(bookId, "第一章", 0).then((ch) => {
        S.chapters = [ch];
        openChapter(S.chapters, 0);
      });
      return;
    }
    openChapter(list, 0);
  });
}

/* ============================================================
   抽屉渲染
   ============================================================ */
function renderDrawer() {
  const body = $("drawerBody");
  if (!body) return;

  loadBooks().then((books) => {
    S.books = books;
    if (books.length === 0) {
      body.innerHTML = '<div class="empty">还没有书<br>点「＋ 新书」创建</div>';
      return;
    }

    if (!S.bookId) {
      switchBook(books[0].id);
      return;
    }

    let html = "";
    for (const bk of books) {
      const isActive = bk.id === S.bookId;
      const wc = bk.wordCount || 0;
      html += `<div class="bk-item${isActive ? " active" : ""}" data-book="${esc(bk.id)}">
        <span class="bk-name">${esc(bk.name)}</span>
        <span class="bk-meta">${wc}字</span>
        <button class="del" data-delbook="${esc(bk.id)}">×</button>
      </div>`;

      if (isActive) {
        html += '<div class="ch-list">';
        if (S.chapters.length === 0) {
          html += '<div class="empty" style="padding:10px">没有章节</div>';
        } else {
          for (const ch of S.chapters) {
            const on = ch.id === S.chapterId;
            const cc = ((ch.text || "").match(/[\u4e00-\u9fff]/g) || []).length;
            html += `<div class="ch-item${on ? " active" : ""}" data-chapter="${esc(ch.id)}">
              <span class="ch-title">${esc(ch.title)}</span>
              <span class="ch-meta">${cc}</span>
              <button class="del" data-delch="${esc(ch.id)}">×</button>
            </div>`;
          }
        }
        html += '<div class="ch-item ch-add" id="chAddBtn">＋ 添加章节</div>';
        html += "</div>";
      }
    }
    body.innerHTML = html;

    body.querySelectorAll("[data-book]").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.classList.contains("del")) return;
        switchBook(el.dataset.book);
      });
    });

    body.querySelectorAll("[data-delbook]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!confirm("删除这本书？所有章节都会被删除。")) return;
        deleteBook(el.dataset.delbook).then(() => {
          if (S.bookId === el.dataset.delbook) { S.bookId = null; S.chapterId = null; setDoc(""); }
          renderDrawer();
        });
      });
    });

    body.querySelectorAll("[data-chapter]").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.classList.contains("del")) return;
        saveCurrent();
        loadChapters(S.bookId).then((list) => {
          S.chapters = list;
          const idx = list.findIndex((c) => c.id === el.dataset.chapter);
          if (idx >= 0) openChapter(list, idx);
        });
      });
    });

    body.querySelectorAll("[data-delch]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!confirm("删除这一章？")) return;
        const cid = el.dataset.delch;
        deleteChapter(cid).then(() => {
          loadChapters(S.bookId).then((list) => {
            S.chapters = list;
            if (S.chapterId === cid) {
              if (list.length) openChapter(list, 0);
              else { S.chapterId = null; setDoc(""); }
            }
            updateBookWordCount(S.bookId);
            renderDrawer();
          });
        });
      });
    });

    const addBtn = $("chAddBtn");
    if (addBtn) {
      addBtn.addEventListener("click", () => {
        const name = prompt("章节名：", "第" + (S.chapters.length + 1) + "章");
        if (!name || !name.trim()) return;
        saveCurrent();
        addChapter(S.bookId, name.trim(), S.chapters.length).then((ch) => {
          loadChapters(S.bookId).then((list) => {
            S.chapters = list;
            const idx = list.findIndex((c) => c.id === ch.id);
            openChapter(list, idx);
          });
        });
      });
    }
  });
}

/* ============================================================
   面板通用
   ============================================================ */
function showPanel(html) {
  $("panelBody").innerHTML = html;
  $("panelMask").classList.add("show");
}

function closePanel() {
  $("panelMask").classList.remove("show");
  S.mode = null;
  if (view) view.focus();
}

/* ============================================================
   错别字面板
   ============================================================ */
function openTypos() {
  const text = getDoc();
  if (!text.trim()) { setStatus("正文为空", "warn"); return; }

  const hits = detectTypos(text);
  S.panelData = hits;
  S.mode = "typo";

  let html = '<div class="p-title">错别字检查</div>';
  if (hits.length === 0) {
    html += '<div class="empty">没有发现高置信度的错别字</div>';
  } else {
    html += `<div class="p-sub">共 ${hits.length} 处</div>`;
    hits.forEach((h, i) => {
      const ln = lineOfIndex(text, h.start);
      html += `<div class="item">
        <span class="ln">L${ln}</span>
        <span class="was">${esc(h.wrong)}</span>
        <span style="color:var(--dim)"> → </span>
        <span class="now">${esc(h.right)}</span>
        <span style="color:var(--dim);font-size:11px;margin-left:6px">${esc(h.reason || "")}</span>
      </div>`;
    });
  }
  html += `<div class="p-foot">
    <button class="primary" id="btnApplyTypo">应用修改</button>
  </div>`;
  showPanel(html);

  const btn = $("btnApplyTypo");
  if (btn && hits.length > 0) {
    btn.addEventListener("click", () => {
      let out = text;
      const sorted = hits.slice().sort((a, b) => b.start - a.start);
      for (const h of sorted) {
        out = out.slice(0, h.start) + h.right + out.slice(h.start + h.len);
      }
      setDoc(out);
      refreshStats();
      saveCurrent();
      closePanel();
      setStatus("已应用错别字修改", "ok");
    });
  }
}

/* ============================================================
   排版面板
   ============================================================ */
function openFormat() {
  const text = getDoc();
  if (!text.trim()) { setStatus("正文为空", "warn"); return; }

  function render(indent, keepBlank) {
    const res = runFormat(text, { indent, keepBlank });
    S.panelData = res.text;
    S.mode = "format";

    let html = '<div class="p-title">一键排版</div>';

    html += '<div class="p-sub">选项</div><div class="row">';
    [[0, "不缩进"], [1, "1字符"], [2, "2字符"]].forEach(([v, label]) => {
      html += `<div class="chip${indent === v ? " active" : ""}" data-indent="${v}">${label}</div>`;
    });
    html += `<div class="chip${keepBlank ? " active" : ""}" data-blank="1">保留空行</div>`;
    html += "</div>";

    html += `<div class="p-sub">改动（${res.changes.length} 处）</div>`;
    if (res.changes.length === 0) {
      html += '<div class="empty" style="padding:14px">正文已规范</div>';
    } else {
      const groups = {};
      res.changes.forEach((c) => {
        if (!groups[c.rule]) groups[c.rule] = [];
        groups[c.rule].push(c);
      });
      Object.keys(groups).forEach((rule) => {
        html += `<div class="g-title">${esc(rule)}（${groups[rule].length}）</div>`;
        groups[rule].slice(0, 8).forEach((c) => {
          const w = c.was.length > 60 ? c.was.slice(0, 60) + "…" : c.was;
          const n = c.now.length > 60 ? c.now.slice(0, 60) + "…" : c.now;
          html += `<div class="item"><span class="ln">L${c.line}</span><span class="was">${esc(w)}</span><br><span class="now">${esc(n)}</span></div>`;
        });
      });
    }

    const q = checkQuotePairs(text);
    html += '<div class="p-sub">引号检查</div>';
    if (q.length === 0) {
      html += '<div class="empty" style="padding:10px">引号配对正常</div>';
    } else {
      q.forEach((it) => {
        html += `<div class="item warn"><span class="ln">L${it.line}</span>${esc(it.text)}</div>`;
      });
    }

    html += `<div class="p-foot"><button class="primary" id="btnApplyFmt">应用到正文</button></div>`;
    showPanel(html);

    document.querySelectorAll("[data-indent]").forEach((el) => {
      el.addEventListener("click", () => render(parseInt(el.dataset.indent, 10), keepBlank));
    });
    document.querySelectorAll("[data-blank]").forEach((el) => {
      el.addEventListener("click", () => render(indent, true));
    });
    const ab = $("btnApplyFmt");
    if (ab) {
      ab.addEventListener("click", () => {
        setDoc(S.panelData);
        refreshStats();
        saveCurrent();
        closePanel();
        setStatus("排版已应用", "ok");
      });
    }
  }

  render(2, false);
}

/* ============================================================
   灵感面板
   ============================================================ */
function getPool(genre) {
  const builtin = (SENTENCE_LIB[genre] || SENTENCE_LIB["通用"] || []).slice();
  const hidden = S.hiddenSent[genre] || [];
  const visible = builtin.filter((_, i) => hidden.indexOf(i) === -1);
  const mine = S.userSent[genre] || [];
  return visible.concat(mine);
}

function openIdea() {
  S.mode = "idea";
  const pool = getPool(S.genre);
  let cur = pool.length ? pool[Math.floor(Math.random() * pool.length)] : "";

  function render() {
    let html = '<div class="p-title">后文灵感</div>';
    html += '<div class="p-sub">题材</div><div class="row">';
    GENRE_LIST.forEach((g) => {
      html += `<div class="chip${g.name === S.genre ? " active" : ""}" data-genre="${esc(g.id)}">${esc(g.name)}</div>`;
    });
    html += "</div>";

    html += `<div class="sent-card" id="sentCard"><div class="sent-text" id="sentText">${esc(cur) || "此题材暂无句子"}</div></div>`;
    html += '<div class="row" style="justify-content:center"><button class="primary" id="btnRefresh">刷新</button><button id="btnCopySent">复制</button></div>';

    html += '<div class="p-sub">添加句子</div>';
    html += '<textarea id="newSent" class="sent-input" placeholder="输入一句…"></textarea>';
    html += '<div class="row"><button class="primary" id="btnAddSent">保存</button><span class="hint">Ctrl+Enter 快速保存</span></div>';

    showPanel(html);

    document.querySelectorAll("[data-genre]").forEach((el) => {
      el.addEventListener("click", () => {
        S.genre = GENRE_NAME[el.dataset.genre] || "通用";
        try { localStorage.setItem(GENRE_KEY, el.dataset.genre); } catch (e) {}
        const p = getPool(S.genre);
        cur = p.length ? p[Math.floor(Math.random() * p.length)] : "";
        render();
      });
    });

    const rf = $("btnRefresh");
    if (rf) {
      rf.addEventListener("click", () => {
        const p = getPool(S.genre);
        if (!p.length) return;
        let next = cur;
        let guard = 0;
        while (next === cur && guard++ < 20) next = p[Math.floor(Math.random() * p.length)];
        cur = next;
        const el = $("sentText");
        if (el) {
          el.textContent = cur;
          el.style.opacity = "0.2";
          setTimeout(() => { el.style.opacity = "1"; }, 40);
        }
      });
    }

    const cb = $("btnCopySent");
    if (cb) {
      cb.addEventListener("click", () => {
        if (!cur) return;
        copyText(cur).then((ok) => { if (ok) setStatus("已复制", "ok"); });
      });
    }

    const card = $("sentCard");
    if (card) {
      card.addEventListener("click", () => {
        if (!cur) return;
        copyText(cur).then((ok) => { if (ok) setStatus("已复制", "ok"); });
      });
    }

    const ab = $("btnAddSent");
    const inp = $("newSent");
    if (ab && inp) {
      const doAdd = () => {
        const t = inp.value.trim();
        if (!t) return;
        if (!S.userSent[S.genre]) S.userSent[S.genre] = [];
        if (S.userSent[S.genre].indexOf(t) !== -1) { setStatus("已存在", "warn"); return; }
        S.userSent[S.genre].push(t);
        try { localStorage.setItem(USER_SENT_KEY, JSON.stringify(S.userSent)); } catch (e) {}
        inp.value = "";
        cur = t;
        const el = $("sentText");
        if (el) el.textContent = t;
        setStatus("已添加", "ok");
      };
      ab.addEventListener("click", doAdd);
      inp.addEventListener("keydown", (e) => {
        if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); doAdd(); }
      });
    }
  }

  render();
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

/* ============================================================
   导出 Word
   ============================================================ */
function doExport() {
  const text = getDoc();
  if (!text.trim()) { setStatus("正文为空", "warn"); return; }
  const base = S.chapterTitle || "未命名";
  const html = buildDocFile(text, base);

  const blob = new Blob(["\ufeff" + html], { type: "application/msword;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = base + ".doc";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  setStatus("已导出：" + base + ".doc", "ok");
}

/* ============================================================
   设置
   ============================================================ */
const FONT_MAP = {
  hei: '"Microsoft YaHei","PingFang SC",sans-serif',
  song: 'SimSun,"Songti SC",serif',
  kai: 'KaiTi,"Kaiti SC",serif'
};

function loadEnv() {
  try {
    const raw = localStorage.getItem(ENV_KEY);
    if (raw) {
      const e = JSON.parse(raw);
      Object.assign(S.env, e);
    }
  } catch (e) {}
  try {
    const g = localStorage.getItem(GENRE_KEY);
    if (g && GENRE_NAME[g]) S.genre = GENRE_NAME[g];
  } catch (e) {}
  try {
    const u = localStorage.getItem(USER_SENT_KEY);
    if (u) S.userSent = JSON.parse(u) || {};
  } catch (e) {}
  try {
    const h = localStorage.getItem(HIDDEN_KEY);
    if (h) S.hiddenSent = JSON.parse(h) || {};
  } catch (e) {}
}

function applyEnv() {
  document.body.className = "theme-" + S.env.theme;
  const r = document.documentElement.style;
  r.setProperty("--ed-size", S.env.size + "px");
  r.setProperty("--ed-line", String(S.env.line));
  r.setProperty("--ed-width", S.env.width + "px");
  r.setProperty("--ed-font", FONT_MAP.hei);

  // 背景纹理
  document.body.setAttribute("data-tex", S.env.tex || "none");
  r.setProperty("--tex-opacity", (S.env.texOpacity / 100).toFixed(3));

  const vs = $("valSize"), vl = $("valLine"), vw = $("valWidth"), vt = $("valTex");
  const rs = $("rngSize"), rl = $("rngLine"), rw = $("rngWidth"), rt = $("rngTex");
  if (vs) vs.textContent = S.env.size + "px";
  if (vl) vl.textContent = S.env.line.toFixed(1);
  if (vw) vw.textContent = S.env.width + "px";
  if (vt) vt.textContent = S.env.texOpacity + "%";
  if (rs) rs.value = S.env.size;
  if (rl) rl.value = Math.round(S.env.line * 10);
  if (rw) rw.value = S.env.width;
  if (rt) rt.value = S.env.texOpacity;

  document.querySelectorAll("[data-theme]").forEach((el) => {
    el.classList.toggle("active", el.dataset.theme === S.env.theme);
  });
  document.querySelectorAll("[data-tex-opt]").forEach((el) => {
    el.classList.toggle("active", el.dataset.texOpt === (S.env.tex || "none"));
  });
}

function saveEnv() {
  try { localStorage.setItem(ENV_KEY, JSON.stringify(S.env)); } catch (e) {}
}

function openSettings() {
  applyEnv();
  $("setMask").classList.add("show");
}

function closeSettings() {
  $("setMask").classList.remove("show");
  if (view) view.focus();
}

/* ============================================================
   初始化
   ============================================================ */
function init() {
  loadEnv();
  applyEnv();

  createEditor($("editor"));

  // 顶栏按钮
  $("btnUndo").addEventListener("click", undo);
  $("btnRedo").addEventListener("click", redo);
  $("btnDrawer").addEventListener("click", () => {
    $("drawerMask").classList.add("show");
    $("drawer").classList.add("show");
    renderDrawer();
  });
  $("btnSave").addEventListener("click", () => saveCurrent(true));
  $("btnMenu").addEventListener("click", (e) => {
    e.stopPropagation();
    $("menuPanel").classList.toggle("show");
  });

  document.addEventListener("click", (e) => {
    if (!$("menuWrap").contains(e.target)) $("menuPanel").classList.remove("show");
  });

  // 菜单项
  document.querySelectorAll("[data-act]").forEach((el) => {
    el.addEventListener("click", () => {
      $("menuPanel").classList.remove("show");
      const act = el.dataset.act;
      setTimeout(() => {
        if (act === "typos") openTypos();
        else if (act === "idea") openIdea();
        else if (act === "format") openFormat();
        else if (act === "export") doExport();
        else if (act === "settings") openSettings();
      }, 40);
    });
  });

  // 抽屉
  $("drawerClose").addEventListener("click", () => {
    $("drawerMask").classList.remove("show");
    $("drawer").classList.remove("show");
  });
  $("drawerMask").addEventListener("click", () => {
    $("drawerMask").classList.remove("show");
    $("drawer").classList.remove("show");
  });
  $("drawerNewBook").addEventListener("click", () => {
    const name = prompt("书名：", "新书");
    if (!name || !name.trim()) return;
    createBook(name.trim()).then((r) => {
      S.bookId = r.book.id;
      S.chapters = [r.chapter];
      lastSavedText = "";
      setDoc("");
      refreshStats();
      renderDrawer();
      setStatus("已创建「" + name.trim() + "」", "ok");
    });
  });

  // 面板关闭
  $("panelClose").addEventListener("click", closePanel);
  $("panelMask").addEventListener("click", (e) => {
    if (e.target === $("panelMask")) closePanel();
  });

  // 设置面板
  $("setClose").addEventListener("click", closeSettings);
  $("setMask").addEventListener("click", (e) => {
    if (e.target === $("setMask")) closeSettings();
  });
  document.querySelectorAll("[data-theme]").forEach((el) => {
    el.addEventListener("click", () => {
      S.env.theme = el.dataset.theme;
      applyEnv(); saveEnv();
    });
  });
  $("rngSize").addEventListener("input", (e) => {
    S.env.size = parseInt(e.target.value, 10);
    applyEnv(); saveEnv();
  });
  $("rngLine").addEventListener("input", (e) => {
    S.env.line = parseInt(e.target.value, 10) / 10;
    applyEnv(); saveEnv();
  });
  $("rngWidth").addEventListener("input", (e) => {
    S.env.width = parseInt(e.target.value, 10);
    applyEnv(); saveEnv();
  });
  $("rngTex").addEventListener("input", (e) => {
    S.env.texOpacity = parseInt(e.target.value, 10);
    applyEnv(); saveEnv();
  });
  document.querySelectorAll("[data-tex-opt]").forEach((el) => {
    el.addEventListener("click", () => {
      S.env.tex = el.dataset.texOpt;
      applyEnv(); saveEnv();
    });
  });

  // 恢复上次的书
  loadBooks().then((books) => {
    S.books = books;
    if (books.length === 0) {
      setStatus("点「书籍」创建第一本", "ok");
      return;
    }
    let target = null;
    try { target = localStorage.getItem(BOOK_KEY); } catch (e) {}
    const book = books.find((b) => b.id === target) || books[0];
    S.bookId = book.id;
    loadChapters(book.id).then((list) => {
      S.chapters = list;
      if (list.length === 0) {
        addChapter(book.id, "第一章", 0).then((ch) => {
          S.chapters = [ch];
          openChapter(S.chapters, 0);
        });
        return;
      }
      let lastId = null;
      try { lastId = localStorage.getItem(CHAPTER_KEY); } catch (e) {}
      let idx = list.findIndex((c) => c.id === lastId);
      if (idx < 0) idx = 0;
      openChapter(list, idx);
    });
  });

  $("btnUndo").style.opacity = "0.35";
  $("btnRedo").style.opacity = "0.35";

  // 快捷键
  document.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (e.key === "Escape") {
      if ($("panelMask").classList.contains("show")) closePanel();
      if ($("setMask").classList.contains("show")) closeSettings();
      if ($("drawer").classList.contains("show")) {
        $("drawerMask").classList.remove("show");
        $("drawer").classList.remove("show");
      }
      return;
    }
    if (ctrl && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveCurrent(true);
    } else if (ctrl && e.shiftKey && e.key.toLowerCase() === "t") {
      e.preventDefault(); openTypos();
    } else if (ctrl && e.shiftKey && e.key.toLowerCase() === "i") {
      e.preventDefault(); openIdea();
    } else if (ctrl && e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault(); openFormat();
    } else if (ctrl && e.shiftKey && e.key.toLowerCase() === "d") {
      e.preventDefault(); doExport();
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if (getDoc() !== lastSavedText) {
      saveCurrent();
    }
  });

  setStatus("就绪", "ok");
}

document.addEventListener("DOMContentLoaded", init);
