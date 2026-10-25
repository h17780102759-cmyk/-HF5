import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
  placeholder as cmPlaceholder
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";

/* ============ 编辑器主题 ============ */
const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "17px",
    backgroundColor: "transparent",
    color: "var(--text, #d6d8dc)"
  },
  ".cm-scroller": {
    fontFamily: '"Microsoft YaHei", "PingFang SC", serif',
    lineHeight: "2.1",
    letterSpacing: "0.02em",
    padding: "40px 48px",
    overflowY: "auto"
  },
  ".cm-content": {
    caretColor: "var(--accent, #5b8dd6)",
    maxWidth: "760px",
    margin: "0 auto"
  },
  ".cm-line": {
    padding: "0"
  },
  "&.cm-focused": {
    outline: "none"
  },
  ".cm-cursor": {
    borderLeftWidth: "2px",
    borderLeftColor: "var(--accent, #5b8dd6)"
  },
  ".cm-selectionBackground, ::selection": {
    backgroundColor: "rgba(91,141,214,.32) !important"
  },
  ".cm-activeLine": {
    backgroundColor: "transparent"
  },
  ".cm-gutters": {
    display: "none"
  }
}, { dark: true });

/* ============ 创建编辑器 ============ */
const startText = `在这里开始写。

这是一段测试文字，用来验证光标位置是否正常。

试着把光标点回上面某一行，然后打字，看看字会出现在哪里。`;

const view = new EditorView({
  state: EditorState.create({
    doc: startText,
    extensions: [
      lineNumbers(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      markdown(),
      oneDark,
      editorTheme,
      cmPlaceholder("在这里开始写……"),
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          updateStats(update.state.doc.toString());
        }
        if (update.selectionSet) {
          updateCursorInfo(update.state.selection.main.head);
        }
      })
    ]
  }),
  parent: document.getElementById("app")
});

/* ============ 统计与状态栏 ============ */
function countStats(text) {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const words = (text.match(/[A-Za-z0-9]+/g) || []).length;
  const paras = text.split(/\n/).filter((l) => l.trim().length > 0).length;
  return { chars: cjk + words, paras };
}

function updateStats(text) {
  const s = countStats(text);
  const el = document.getElementById("statChars");
  if (el) el.textContent = s.chars + " 字";
  const el2 = document.getElementById("statParas");
  if (el2) el2.textContent = s.paras + " 段";
}

function updateCursorInfo(pos) {
  const el = document.getElementById("cursorInfo");
  if (el) el.textContent = "光标位置：" + pos;
}

/* ============ 简单状态栏（验证用） ============ */
const bar = document.createElement("div");
bar.id = "bar";
bar.style.cssText =
  "position:fixed;bottom:0;left:0;right:0;height:28px;" +
  "background:#26282c;color:#8b8f96;font-size:11.5px;" +
  "display:flex;align-items:center;gap:16px;padding:0 12px;" +
  "border-top:1px solid #34373c;font-family:sans-serif;";
bar.innerHTML =
  '<span id="statChars">0 字</span>' +
  '<span id="statParas">0 段</span>' +
  '<span style="flex:1"></span>' +
  '<span id="cursorInfo" style="color:#5b8dd6"></span>';
document.body.appendChild(bar);

/* 让编辑器让出底部空间 */
document.documentElement.style.setProperty("--bar-height", "28px");
document.body.style.cssText =
  "margin:0;height:100dvh;background:#1e1f22;color:#d6d8dc;overflow:hidden;";
document.getElementById("app").style.cssText =
  "height:calc(100dvh - 28px);overflow:hidden;";

/* 初始化统计 */
updateStats(startText);
updateCursorInfo(0);
