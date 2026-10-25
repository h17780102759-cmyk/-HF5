import { EditorState } from "@codemirror/state";
import { EditorView, keymap, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
/* ============================================================
   最简 CodeMirror 配置 —— 验证安卓输入法组字
   去掉：行号、Markdown、主题包、高亮、自动补全
   保留：输入、历史记录、光标绘制、换行
   ============================================================ */

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "17px",
    backgroundColor: "#1e1f22",
    color: "#d6d8dc"
  },
  ".cm-scroller": {
    fontFamily: '-apple-system, "Microsoft YaHei", "PingFang SC", sans-serif',
    lineHeight: "1.9",
    padding: "20px",
    overflowY: "auto"
  },
  ".cm-content": {
    caretColor: "#5b8dd6",
    minHeight: "100%"
  },
  ".cm-line": { padding: "0" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor": {
    borderLeftWidth: "2px",
    borderLeftColor: "#5b8dd6"
  },
  ".cm-selectionBackground": {
    backgroundColor: "rgba(91,141,214,.3) !important"
  }
});

/* ===== 底部状态栏 ===== */
const bar = document.createElement("div");
bar.style.cssText =
  "position:fixed;bottom:0;left:0;right:0;height:44px;" +
  "background:#26282c;color:#8b8f96;font-size:11px;" +
  "display:flex;flex-direction:column;justify-content:center;padding:0 10px;" +
  "border-top:1px solid #34373c;font-family:monospace;z-index:10;gap:2px;";
bar.innerHTML =
  '<div id="posInfo" style="color:#5b8dd6">光标：0　字数：0</div>' +
  '<div id="eventInfo" style="color:#8b8f96;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">就绪</div>';
document.body.appendChild(bar);

/* ===== 页面布局 ===== */
document.documentElement.style.cssText = "height:100%;";
document.body.style.cssText =
  "margin:0;height:100dvh;background:#1e1f22;color:#d6d8dc;overflow:hidden;";
const appEl = document.getElementById("app");
appEl.style.cssText = "height:calc(100dvh - 44px);overflow:hidden;";

/* ===== 状态显示 ===== */
const posInfo = document.getElementById("posInfo");
const eventInfo = document.getElementById("eventInfo");

let evtLog = [];
function pushEvt(name, extra) {
  const s = name + (extra ? ":" + String(extra).slice(0, 8) : "");
  evtLog.unshift(s);
  if (evtLog.length > 4) evtLog.pop();
  eventInfo.textContent = evtLog.join(" → ");
}

/* ===== 创建编辑器（唯一实例） ===== */
const view = new EditorView({
  state: EditorState.create({
    doc: "",
    extensions: [
      history(),
      drawSelection(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      editorTheme,
      EditorView.updateListener.of((update) => {
        if (update.docChanged || update.selectionSet) {
          const head = update.state.selection.main.head;
          const len = update.state.doc.length;
          posInfo.textContent = "光标：" + head + "　字数：" + len;
        }
      })
    ]
  }),
  parent: appEl
});

/* ===== 事件探测 + 组字兜底 ===== */
const dom = view.contentDOM;

let lastCompositionData = "";
let docLenBeforeComposition = 0;

dom.addEventListener("compositionstart", () => {
  pushEvt("组字开始");
  lastCompositionData = "";
  docLenBeforeComposition = view.state.doc.length;
});

dom.addEventListener("compositionupdate", (e) => {
  pushEvt("组字中", e.data || "");
  lastCompositionData = e.data || "";
});

dom.addEventListener("compositionend", (e) => {
  const data = e.data || lastCompositionData || "";
  pushEvt("组字结束", data);

  // 兜底：如果组字有内容但文档没变，手动插入
  setTimeout(() => {
    const nowLen = view.state.doc.length;
    if (data && nowLen === docLenBeforeComposition) {
      view.dispatch(
        view.state.replaceSelection(data)
      );
      pushEvt("手动插入", data);
    }
  }, 30);
});

dom.addEventListener("beforeinput", (e) => pushEvt("beforeinput", e.inputType || ""));
dom.addEventListener("input", () => pushEvt("input"));
dom.addEventListener("keydown", (e) => {
  if (e.key && e.key.length === 1) pushEvt("键", e.key);
});

/* ===== 聚焦 ===== */
view.focus();
pushEvt("已加载");
