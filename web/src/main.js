/* ============================================================
   写作器 — 基于 CodeMirror 6
   功能：书籍章节、撤销重做、错别字、排版、灵感、设置、导出
   ============================================================ */

import { EditorState } from "@codemirror/state";
import { EditorView, keymap, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, undo as undoCommand, redo as redoCommand, undoDepth, redoDepth } from "@codemirror/commands";

import {
  loadBooks, loadChapters, createBook, addChapter, saveChapter,
  deleteChapter, deleteBook, updateBookWordCount,
  storePut, countChars, BOOK_KEY, CHAPTER_KEY
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
  // 字数统一走 db.js 的 countChars，保证书籍/章节/状态栏口径一致
  const chars = countChars(text);
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const words = (text.match(/[A-Za-z0-9]+/g) || []).length;
  const punct = (text.match(/[\u3000-\u303f\uff00-\uffef\u2018\u2019\u201c\u201d\u2026\u2014]/g) || []).length;
  const paras = text.split(/\n/).filter((l) => l.trim().length > 0).length;
  return { chars, cjk, words, punct, paras };
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
        // 撤销分组：连续输入合并为一步，停顿超过 1 秒断组
        history({
          newGroupDelay: 1000,
          minDepth: 200,
          eventFilter: (event) => {
            // 输入法组字期间的事件不单独分组，交给 composition 处理
            if (event.type === "compositionstart") return false;
            return true;
          }
        }),
        drawSelection(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        theme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            refreshStats();
            scheduleSave();
            updateHistoryButtons();
          }
        })
      ]
    }),
    parent
  });

  // 初始化按钮状态
  setTimeout(updateHistoryButtons, 0);

  // 滚动时给悬浮栏加深阴影
  const scroller = view.scrollDOM;
  if (scroller) {
    scroller.addEventListener("scroll", () => {
      if (scroller.scrollTop > 8) {
        document.body.classList.add("scrolled");
      } else {
        document.body.classList.remove("scrolled");
      }
    }, { passive: true });
  }
}

function undo() {
  if (!view) return;
  undoCommand({ state: view.state, dispatch: view.dispatch });
  updateHistoryButtons();
}

function redo() {
  if (!view) return;
  redoCommand({ state: view.state, dispatch: view.dispatch });
  updateHistoryButtons();
}

/* ============================================================
   撤销/重做按钮状态
   ============================================================ */
function updateHistoryButtons() {
  if (!view) return;
  const st = view.state;
  const canUndo = undoDepth(st) > 0;
  const canRedo = redoDepth(st) > 0;
  const bu = $("btnUndo");
  const br = $("btnRedo");
  if (bu) {
    bu.disabled = !canUndo;
    bu.style.opacity = canUndo ? "1" : "0.35";
    bu.style.cursor = canUndo ? "pointer" : "default";
  }
  if (br) {
    br.disabled = !canRedo;
    br.style.opacity = canRedo ? "1" : "0.35";
    br.style.cursor = canRedo ? "pointer" : "default";
  }
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
   行内重命名：把文字变成输入框，回车确认，Esc 取消
   ============================================================ */
function startInlineEdit(rowEl, textSel, kind, id) {
  if (!rowEl) return;
  const span = rowEl.querySelector(textSel);
  if (!span) return;
  if (span.dataset.editing === "1") return;

  const oldText = span.textContent;
  span.dataset.editing = "1";

  const input = document.createElement("input");
  input.type = "text";
  input.value = oldText;
  input.className = "inline-edit";
  input.maxLength = 60;

  span.textContent = "";
  span.appendChild(input);
  input.focus();
  input.select();

  let finished = false;

  function finish(save) {
    if (finished) return;
    finished = true;

    const newText = input.value.trim();
    if (save && newText && newText !== oldText) {
      if (kind === "book") {
        // 更新书名
        const bk = S.books.find((b) => b.id === id);
        if (bk) {
          bk.name = newText;
          storePut("books", bk).then(() => {
            renderDrawer();
            setStatus("书名已改", "ok");
          });
          return;
        }
      } else if (kind === "chapter") {
        // 更新章节名
        const ch = S.chapters.find((c) => c.id === id);
        if (ch) {
          ch.title = newText;
          saveChapter({ ...ch, updated: Date.now() }).then(() => {
            if (S.chapterId === id) S.chapterTitle = newText;
            renderDrawer();
            setStatus("章节名已改", "ok");
          });
          return;
        }
      }
    }

    // 取消或不改：还原
    span.textContent = oldText;
    delete span.dataset.editing;
  }

  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
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

    // 渲染前先重算当前书字数（含标点），避免显示过期数据
    const needRecalc = S.bookId && books.some((b) => b.id === S.bookId);
    if (needRecalc) {
      updateBookWordCount(S.bookId)
        .then(() => loadBooks())
        .then((fresh) => {
          S.books = fresh;
          doRenderDrawer(fresh);
        })
        .catch(() => doRenderDrawer(books));
      return;
    }

    doRenderDrawer(books);
  });
}

function doRenderDrawer(books) {
  const body = $("drawerBody");
  if (!body) return;

  let html = "";
    for (const bk of books) {
      const isActive = bk.id === S.bookId;
      const wc = bk.wordCount || 0;
      html += `<div class="bk-item${isActive ? " active" : ""}" data-book="${esc(bk.id)}">
        <span class="bk-name">${esc(bk.name)}</span>
        <span class="bk-meta">${wc}字</span>
        <button class="edit-btn" data-editbook="${esc(bk.id)}" title="重命名">✎</button>
        <button class="del" data-delbook="${esc(bk.id)}">×</button>
      </div>`;

      if (isActive) {
        html += '<div class="ch-list">';
        if (S.chapters.length === 0) {
          html += '<div class="empty" style="padding:10px">没有章节</div>';
        } else {
          for (const ch of S.chapters) {
            const on = ch.id === S.chapterId;
            const cc = countStats(ch.text || "").chars;
            html += `<div class="ch-item${on ? " active" : ""}" data-chapter="${esc(ch.id)}">
              <span class="ch-title">${esc(ch.title)}</span>
              <span class="ch-meta">${cc}</span>
              <button class="edit-btn" data-editch="${esc(ch.id)}" title="重命名">✎</button>
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
        if (e.target.classList.contains("edit-btn")) return;
        switchBook(el.dataset.book);
      });
    });

    // 书重命名
    body.querySelectorAll("[data-editbook]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        startInlineEdit(el.closest(".bk-item"), ".bk-name", "book", el.dataset.editbook);
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
        if (e.target.classList.contains("edit-btn")) return;
        saveCurrent();
        loadChapters(S.bookId).then((list) => {
          S.chapters = list;
          const idx = list.findIndex((c) => c.id === el.dataset.chapter);
          if (idx >= 0) openChapter(list, idx);
        });
      });
    });

    // 章节重命名
    body.querySelectorAll("[data-editch]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        startInlineEdit(el.closest(".ch-item"), ".ch-title", "chapter", el.dataset.editch);
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
/* ============================================================
   后文灵感：翻页式浏览 + 句子管理
   ============================================================ */

/* ---------- 句子池工具 ---------- */
function getPool(genre) {
  const builtin = (SENTENCE_LIB[genre] || SENTENCE_LIB["通用"] || []).slice();
  const hidden = S.hiddenSent[genre] || [];
  const visible = builtin.filter((_, i) => hidden.indexOf(i) === -1);
  const mine = S.userSent[genre] || [];
  return visible.concat(mine);
}

// 内置句（含原始索引）
function getBuiltinVisible(genre) {
  const all = SENTENCE_LIB[genre] || SENTENCE_LIB["通用"] || [];
  const hid = S.hiddenSent[genre] || [];
  const out = [];
  all.forEach((text, i) => {
    if (hid.indexOf(i) === -1) out.push({ text, idx: i });
  });
  return out;
}

function saveHidden() {
  try { localStorage.setItem(HIDDEN_KEY, JSON.stringify(S.hiddenSent)); } catch (e) {}
}

function saveUserSent() {
  try { localStorage.setItem(USER_SENT_KEY, JSON.stringify(S.userSent)); } catch (e) {}
}

/* ---------- 灵感面板（翻页式） ---------- */
let ideaState = null;   // { genre, idx }

function openIdea(opts) {
  S.mode = "idea";

  if (!ideaState || (opts && opts.reset)) {
    ideaState = { genre: S.genre, idx: 0 };
  }
  ideaState.genre = S.genre;

  renderIdeaPage();
}

function renderIdeaPage() {
  const pool = getPool(S.genre);
  if (ideaState.idx >= pool.length) ideaState.idx = 0;
  if (ideaState.idx < 0) ideaState.idx = Math.max(0, pool.length - 1);

  const cur = pool.length ? pool[ideaState.idx] : "";

  let html = '<div class="p-title">后文灵感</div>';

  // 题材选择
  html += '<div class="p-sub">题材</div><div class="row">';
  GENRE_LIST.forEach((g) => {
    html += `<div class="chip${g.name === S.genre ? " active" : ""}" data-genre="${esc(g.id)}">${esc(g.name)}</div>`;
  });
  html += "</div>";

  // 翻页卡片
  html += `<div class="book-wrap">
    <div class="book-stage" id="bookStage">
      <div class="book-page" id="bookPage">
        <div class="sent-text" id="sentText">${esc(cur) || "此题材暂无句子"}</div>
      </div>
    </div>
    <div class="page-indicator" id="pageInd">${pool.length ? (ideaState.idx + 1) + " / " + pool.length : "0 / 0"}</div>
  </div>`;

  // 翻页与操作按钮
  html += `<div class="pager">
    <button id="btnPrev" class="pager-btn">◀</button>
    <button id="btnCopySent" class="primary">复制</button>
    <button id="btnNext" class="pager-btn">▶</button>
  </div>`;

  // 添加句子
  html += '<div class="p-sub">添加句子</div>';
  html += '<textarea id="newSent" class="sent-input" placeholder="输入一句…"></textarea>';
  html += `<div class="row">
    <button class="primary" id="btnAddSent">保存</button>
    <span class="hint">Ctrl+Enter 快速保存</span>
    <span style="flex:1"></span>
    <button id="btnManageSent">管理句子</button>
  </div>`;

  showPanel(html);
  bindIdeaEvents();
}

/* ---------- 翻页 ---------- */
function turnIdeaPage(dir) {
  const pool = getPool(S.genre);
  if (pool.length <= 1) return;

  const page = $("bookPage");
  const stage = $("bookStage");
  if (!page || !stage) return;
  if (stage.dataset.turning === "1") return;
  stage.dataset.turning = "1";

  let next = ideaState.idx + dir;
  if (next >= pool.length) next = 0;              // 循环
  if (next < 0) next = pool.length - 1;

  // 翻出
  page.classList.add(dir > 0 ? "turn-out-left" : "turn-out-right");

  setTimeout(() => {
    ideaState.idx = next;
    page.classList.remove("turn-out-left", "turn-out-right");
    page.classList.add(dir > 0 ? "turn-in-right" : "turn-in-left");

    const el = $("sentText");
    if (el) el.textContent = pool[next];

    const ind = $("pageInd");
    if (ind) ind.textContent = (next + 1) + " / " + pool.length;

    setTimeout(() => {
      page.classList.remove("turn-in-right", "turn-in-left");
      stage.dataset.turning = "0";
    }, 260);
  }, 200);
}

/* ---------- 复制 ---------- */
function copyCurrentSentence() {
  const pool = getPool(S.genre);
  const t = pool[ideaState.idx];
  if (!t) return;
  copyText(t).then((ok) => {
    if (ok) {
      setStatus("已复制", "ok");
      const page = $("bookPage");
      if (page) {
        page.classList.add("flash");
        setTimeout(() => page.classList.remove("flash"), 300);
      }
    }
  });
}

/* ---------- 灵感面板事件 ---------- */
function bindIdeaEvents() {
  // 题材切换：重置到第一条
  document.querySelectorAll("[data-genre]").forEach((el) => {
    el.addEventListener("click", () => {
      S.genre = GENRE_NAME[el.dataset.genre] || "通用";
      try { localStorage.setItem(GENRE_KEY, el.dataset.genre); } catch (e) {}
      ideaState.idx = 0;
      renderIdeaPage();
    });
  });

  const prev = $("btnPrev");
  const next = $("btnNext");
  if (prev) prev.addEventListener("click", () => turnIdeaPage(-1));
  if (next) next.addEventListener("click", () => turnIdeaPage(1));

  const cb = $("btnCopySent");
  if (cb) cb.addEventListener("click", copyCurrentSentence);

  const page = $("bookPage");
  if (page) {
    page.addEventListener("click", () => {
      if (page.dataset.swiped === "1") { page.dataset.swiped = "0"; return; }
      copyCurrentSentence();
    });
  }

  // 触摸滑动
  const stage = $("bookStage");
  if (stage) {
    let startX = 0, startY = 0;

    stage.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
    }, { passive: true });

    stage.addEventListener("touchend", (e) => {
      const t = e.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        if (page) page.dataset.swiped = "1";
        turnIdeaPage(dx < 0 ? 1 : -1);
      }
    }, { passive: true });

    // 鼠标拖拽
    let mouseX = 0, down = false;
    stage.addEventListener("mousedown", (e) => { down = true; mouseX = e.clientX; });
    stage.addEventListener("mouseup", (e) => {
      if (!down) return;
      down = false;
      const dx = e.clientX - mouseX;
      if (Math.abs(dx) > 60) {
        if (page) page.dataset.swiped = "1";
        turnIdeaPage(dx < 0 ? 1 : -1);
      }
    });
    stage.addEventListener("mouseleave", () => { down = false; });
  }

  // 键盘方向键
  document.addEventListener("keydown", function ideaKey(e) {
    if (S.mode !== "idea") {
      document.removeEventListener("keydown", ideaKey);
      return;
    }
    if (!$("panelMask").classList.contains("show")) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); turnIdeaPage(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); turnIdeaPage(1); }
  });

  // 添加句子
  const ab = $("btnAddSent");
  const inp = $("newSent");
  if (ab && inp) {
    const doAdd = () => {
      const t = inp.value.trim();
      if (!t) return;
      if (!S.userSent[S.genre]) S.userSent[S.genre] = [];
      if (S.userSent[S.genre].indexOf(t) !== -1) {
        setStatus("已存在", "warn");
        return;
      }
      S.userSent[S.genre].push(t);
      saveUserSent();
      inp.value = "";
      const pool = getPool(S.genre);
      ideaState.idx = pool.length - 1;   // 跳到新加的
      renderIdeaPage();
      setStatus("已添加", "ok");
    };
    ab.addEventListener("click", doAdd);
    inp.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); doAdd(); }
    });
  }

  // 管理
  const mb = $("btnManageSent");
  if (mb) mb.addEventListener("click", openSentManager);
}

/* ============================================================
   句子管理面板
   ============================================================ */
function openSentManager() {
  S.mode = "manage";

  const builtin = getBuiltinVisible(S.genre);
  const mine = S.userSent[S.genre] || [];
  const total = builtin.length + mine.length;

  let html = `<div class="p-title">管理「${esc(S.genre)}」</div>`;
  html += `<div class="p-sub">共 ${total} 句</div>`;

  // 内置句子
  if (builtin.length > 0) {
    html += `<div class="g-title" style="color:var(--accent)">内置（${builtin.length} 句）</div>`;
    builtin.forEach((b) => {
      html += `<div class="item sent-row">
        <span class="sent-row-text">${esc(b.text)}</span>
        <button class="del" data-delbuiltin="${b.idx}">×</button>
      </div>`;
    });
  }

  // 自定义句子
  if (mine.length > 0) {
    html += `<div class="g-title" style="color:#d9a54a">我添加的（${mine.length} 句）</div>`;
    mine.forEach((t, i) => {
      html += `<div class="item sent-row" style="border-left-color:#d9a54a">
        <span class="sent-row-text">${esc(t)}</span>
        <button class="del" data-delmine="${i}">×</button>
      </div>`;
    });
  }

  if (total === 0) {
    html += '<div class="empty">此题材没有句子</div>';
  }

  html += `<div class="p-foot">
    <button id="btnBackIdea" class="primary">返回</button>
    <button id="btnExportSent">导出句子</button>
  </div>`;

  showPanel(html);

  // 删除内置句
  document.querySelectorAll("[data-delbuiltin]").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = parseInt(el.dataset.delbuiltin, 10);
      const txt = (SENTENCE_LIB[S.genre] || [])[idx] || "";
      if (!confirm("删除这句？\n\n" + txt)) return;
      if (!S.hiddenSent[S.genre]) S.hiddenSent[S.genre] = [];
      if (S.hiddenSent[S.genre].indexOf(idx) === -1) S.hiddenSent[S.genre].push(idx);
      saveHidden();
      openSentManager();
    });
  });

  // 删除自定义句
  document.querySelectorAll("[data-delmine]").forEach((el) => {
    el.addEventListener("click", () => {
      const i = parseInt(el.dataset.delmine, 10);
      const arr = S.userSent[S.genre] || [];
      const txt = arr[i] || "";
      if (!confirm("删除这句？\n\n" + txt)) return;
      arr.splice(i, 1);
      if (arr.length === 0) delete S.userSent[S.genre];
      saveUserSent();
      openSentManager();
    });
  });

  const back = $("btnBackIdea");
  if (back) back.addEventListener("click", () => {
    ideaState.idx = 0;
    openIdea({ reset: true });
  });

  const exp = $("btnExportSent");
  if (exp) exp.addEventListener("click", () => {
    const lines = [];
    GENRE_LIST.forEach((g) => {
      const pool = getPool(g.name);
      if (pool.length === 0) return;
      lines.push(`## ${g.name}（${pool.length} 句）`);
      pool.forEach((s) => lines.push(s));
      lines.push("");
    });
    if (lines.length === 0) { setStatus("没有可导出的句子", "warn"); return; }
    const txt = lines.join("\n");
    const blob = new Blob(["\ufeff" + txt], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "闲赋句子库.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    setStatus("已导出句子库", "ok");
  });
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

/* ============================================================
   双指缩放：只缩放正文字号，工具栏保持不动
   ============================================================ */
const ZOOM_MIN = 12;
const ZOOM_MAX = 40;

let pinchStartDist = 0;
let pinchStartSize = 17;
let pinching = false;

function setupPinchZoom(editorEl) {
  const pane = editorEl;
  if (!pane) return;

  function getDist(t1, t2) {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.hypot(dx, dy);
  }

  pane.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 2) return;
    pinching = true;
    pinchStartDist = getDist(e.touches[0], e.touches[1]);
    pinchStartSize = S.env.size;
  }, { passive: true });

  pane.addEventListener("touchmove", (e) => {
    if (!pinching || e.touches.length !== 2) return;
    e.preventDefault();

    const dist = getDist(e.touches[0], e.touches[1]);
    if (pinchStartDist < 10) return;

    const ratio = dist / pinchStartDist;
    let next = Math.round(pinchStartSize * ratio);
    if (next < ZOOM_MIN) next = ZOOM_MIN;
    if (next > ZOOM_MAX) next = ZOOM_MAX;

    if (next !== S.env.size) {
      S.env.size = next;
      // 只更新字号变量，不触发完整 applyEnv
      document.documentElement.style.setProperty("--ed-size", next + "px");
      const vs = $("valSize"), rs = $("rngSize");
      if (vs) vs.textContent = next + "px";
      if (rs) rs.value = next;
    }
  }, { passive: false });

  pane.addEventListener("touchend", (e) => {
    if (e.touches.length < 2 && pinching) {
      pinching = false;
      saveEnv();
      if (S.env.size !== pinchStartSize) {
        showToast("字号 " + S.env.size + "px");
      }
    }
  }, { passive: true });

  pane.addEventListener("touchcancel", () => {
    if (pinching) {
      pinching = false;
      saveEnv();
    }
  }, { passive: true });
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

  // 双指缩放（只缩放正文字号，工具栏不动）
  setupPinchZoom($("editor"));

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

  // ========== 返回键拦截（双击退出） ==========
  setupBackButton();

  setStatus("就绪", "ok");
}

/* ============================================================
   返回键：第一次提示，2 秒内再按才退出
   ============================================================ */
let backPressedOnce = false;
let backTimer = null;

function handleBack() {
  // ① 如果有面板打开，先关面板
  if ($("panelMask").classList.contains("show")) {
    closePanel();
    return true;   // 已处理
  }
  if ($("setMask").classList.contains("show")) {
    closeSettings();
    return true;
  }
  if ($("drawer").classList.contains("show")) {
    $("drawerMask").classList.remove("show");
    $("drawer").classList.remove("show");
    return true;
  }
  if ($("menuPanel").classList.contains("show")) {
    $("menuPanel").classList.remove("show");
    return true;
  }

  // ② 没有面板：判断是否要退出
  if (backPressedOnce) {
    // 第二次按：保存并退出
    saveCurrent();
    backPressedOnce = false;
    if (backTimer) { clearTimeout(backTimer); backTimer = null; }
    exitApp();
    return true;
  }

  // 第一次按：提示
  backPressedOnce = true;
  showToast("再按一次返回键退出");
  backTimer = setTimeout(() => {
    backPressedOnce = false;
    backTimer = null;
  }, 2000);
  return true;
}

function exitApp() {
  // Capacitor 环境下真正退出
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    window.Capacitor.Plugins.App.exitApp();
    return;
  }
  // 网页环境下：尝试关闭窗口（多数浏览器不允许）
  try { window.close(); } catch (e) {}
}

function setupBackButton() {
  // ---- 方式 1：Capacitor 原生返回键（如果有 App 插件） ----
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    try {
      // Capacitor 6 中监听通过 addListener，返回 Promise
      Promise.resolve(
        window.Capacitor.Plugins.App.addListener("backButton", () => {
          if (!handleBack()) exitApp();
        })
      ).catch(() => {});
    } catch (e) {}
  }

  // ---- 方式 2：history 拦截（WebView / 浏览器通用） ----
  // 先压入一个历史记录，拦截返回
  try {
    history.pushState({ guard: true }, "", location.href);
  } catch (e) {}

  window.addEventListener("popstate", (e) => {
    // 每次返回都重新压入，保证不会被真正退回
    try {
      history.pushState({ guard: true }, "", location.href);
    } catch (err) {}

    const handled = handleBack();
    if (!handled) {
      // 允许退出
      try { history.back(); } catch (err) {}
    }
  });
}

/* ============================================================
   轻提示（比 setStatus 更醒目）
   ============================================================ */
let toastTimer = null;
function showToast(msg) {
  let el = $("appToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "appToast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
  }, 1800);
}

document.addEventListener("DOMContentLoaded", init);
