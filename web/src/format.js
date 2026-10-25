/* ============================================================
   排版引擎（自旧版迁移，纯字符串处理，不依赖编辑器）
   ============================================================ */

  // 原则：不碰 Markdown 标记，不碰代码块，只规整"正文行"内的问题
  var fmtChanges = [];       // 本次排版的改动清单
  var fmtBeforeText = "";    // 排版前快照，用于撤销

  // 行类型判定
  function classifyLine(line){
    var s = line.trim();
    if(s === "") return "blank";
    if(/^```/.test(s)) return "fence";
    // 标题 # ## ###（要求 # 后跟空格）
    if(/^#{1,6}\s/.test(s)) return "heading";
    // 列表 - * + 或 1.
    if(/^([-*+]|\d+[.)])\s/.test(s)) return "list";
    // 引用
    if(/^>/.test(s)) return "quote";
    // 水平分割线
    if(/^([-*_])\s*(\1\s*){2,}$/.test(s)) return "rule";
    // 表格
    if(/^\|/.test(s)) return "table";
    return "text";
  }

  // 找出代码块占据的行号（含围栏行本身）
  function findFenceRanges(lines){
    var inFence = false, startLine = -1, ranges = [];
    for(var i=0;i<lines.length;i++){
      if(/^\s*```/.test(lines[i])){
        if(!inFence){ inFence = true; startLine = i; }
        else { inFence = false; ranges.push([startLine, i]); }
      }
    }
    if(inFence) ranges.push([startLine, lines.length-1]);  // 未闭合，保护到末尾
    return ranges;
  }

  function inRanges(idx, ranges){
    for(var i=0;i<ranges.length;i++){
      if(idx >= ranges[i][0] && idx <= ranges[i][1]) return true;
    }
    return false;
  }

  var CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  var ALNUM = /[A-Za-z0-9]/;
  // 数字后面的这些字是量词/单位，不加空格（3个、2024年、第3章）
  var UNIT_AFTER = "章节条款页个位年月日号级项步米斤公寸次遍天周秒分时岁人元块角分张只件台辆本套册卷集回段句字行列页";

  // 逐个字符扫描，判断是否需要插空格
  function addCjkLatinSpaces(str){
    var out = "";
    for(var i=0;i<str.length;i++){
      var ch = str.charAt(i);
      var prev = out.length > 0 ? out.charAt(out.length - 1) : "";
      var lastOrig = i > 0 ? str.charAt(i-1) : "";

      // 中文 -> 英文/数字：需要空格，除非前一个字是"第"（序数）
      if(ALNUM.test(ch) && prev !== "" && CJK.test(prev)){
        if(lastOrig === "第"){
          out += ch;
          continue;
        }
        out += " " + ch;
        continue;
      }

      // 英文/数字 -> 中文：需要空格，除非这个中文是量词/单位
      if(CJK.test(ch) && prev !== "" && ALNUM.test(prev)){
        if(UNIT_AFTER.indexOf(ch) !== -1){
          out += ch;
          continue;
        }
        out += " " + ch;
        continue;
      }

      out += ch;
    }
    return out;
  }

  /* ---------- 受保护片段：URL / 路径 / 邮箱 / 时间 / 版本号 / 英文标识 ---------- */
  // 思路：先把这些片段替换成占位符，规则跑完再还原，避免被标点规则误伤

  var PROTECT_RULES = [
    // URL（http/https/ftp/file 协议）
    /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s<>"'，。；：！？、）】」]+/g,
    // 邮箱
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    // Windows 盘符路径  C:\ 或 D:/
    /\b[A-Za-z]:[\\\/][^\s<>"'，。；：！？、）】」]*/g,
    // UNIX 绝对路径 /usr/local/bin
    /(^|[\s（(【「])\/[a-zA-Z0-9_.-]+(\/[a-zA-Z0-9_.-]+)+/g,
    // 时间 10:30 / 10:30:45
    /\b\d{1,2}:\d{2}(:\d{2})?\b/g,
    // 版本号 1.2.3 / v2.1 / 1.2.3.4
    /\bv?\d+(\.\d+){2,}\b/g,
    // 单个小数（1.5、3.14）——两侧都是数字，不会被句点规则误伤，但保留以防
    /\b\d+\.\d+[a-zA-Z0-9]*\b/g,
    // 比例 3:4（冒号两侧都是数字）
    /\b\d+:\d+\b/g,
    // 带引号的英文标识 / 文件名
    /\b[a-zA-Z0-9_-]+\.(txt|md|doc|docx|pdf|png|jpg|jpeg|gif|json|xml|html|css|js|py|java|cpp|zip|rar|mp4|mp3)\b/gi
  ];

  var PROTECT_PREFIX = "\u0001P";

  // 找出所有受保护片段，替换为占位符
  // 注意：用 m[0]（完整匹配），不依赖捕获组，避免多捕获组规则判断错误
  function protectSegments(text){
    var store = [];   // { ph: 占位符, raw: 原文 }

    for(var r=0; r<PROTECT_RULES.length; r++){
      var re = new RegExp(PROTECT_RULES[r].source, "g");
      text = text.replace(re, function(m){
        if(!m) return m;
        // UNIX 路径规则带前导字符（空白/括号），需要把它留在外面
        var lead = "";
        var target = m;
        var first = m.charAt(0);
        // 若首字符是空白或左括号这类"前导符"，说明是捕获组前缀
        if(r === 3 && first !== "/" ){
          lead = first;
          target = m.slice(1);
        }
        if(!target) return m;
        var ph = PROTECT_PREFIX + store.length + "\u0002";
        store.push({ ph: ph, raw: target });
        return lead + ph;
      });
    }
    return { text: text, store: store };
  }

  // 还原占位符
  function restoreSegments(text, store){
    if(!store || store.length === 0) return text;
    for(var i=0; i<store.length; i++){
      // split/join 避免 replace 的特殊字符问题
      text = text.split(store[i].ph).join(store[i].raw);
    }
    return text;
  }

  // 只在"中文语境"下把半角标点转全角
  // 判断依据：标点紧邻中文字符（左或右至少一侧是中文）
  // 这样 test, this 这种英文里的逗号不会被改，中文里的句子，标点会被改
  function convertPunctInChinese(text){
    var PUNCT_MAP = {
      ",": "，", ";": "；", ":": "：", "!": "！", "?": "？",
      "(": "（", ")": "）"
    };
    var CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
    var out = "";

    for(var i=0; i<text.length; i++){
      var ch = text.charAt(i);
      var target = PUNCT_MAP[ch];

      if(!target){
        out += ch;
        continue;
      }

      // 左邻：跳过空格向前找一个有效字符
      var left = "";
      for(var l=i-1; l>=0; l--){
        if(text.charAt(l) !== " "){ left = text.charAt(l); break; }
      }
      // 右邻
      var right = "";
      for(var r=i+1; r<text.length; r++){
        if(text.charAt(r) !== " "){ right = text.charAt(r); break; }
      }

      var leftIsCjk  = left  !== "" && CJK.test(left);
      var rightIsCjk = right !== "" && CJK.test(right);

      // 只要有一侧是中文，就转全角（中文句子里混半角标点是不规范的）
      if(leftIsCjk || rightIsCjk){
        out += target;
      }else{
        out += ch;   // 纯英文语境，保持原样
      }
    }
    return out;
  }

  // 正文行内的具体规则
  // 返回 {text, changes:[{rule, was, now}]}
  function formatTextLine(raw){
    var changes = [];

    // ① 先保护不应被改动的片段
    var prot = protectSegments(raw);
    var out = prot.text;

    // R1 中西文间加空格（带例外：序数、量词）
    var before = out;
    out = addCjkLatinSpaces(out);
    if(out !== before) changes.push({rule:"中西文间加空格", was:before, now:out});

    // R2 全角标点统一（只处理中文语境，不碰受保护片段）
    before = out;
    out = convertPunctInChinese(out);
    if(out !== before) changes.push({rule:"半角标点转全角", was:before, now:out});

    // R3 中文句点转句号
    before = out;
    out = out.replace(/([\u4e00-\u9fff])\.([\u4e00-\u9fff])/g, "$1。$2");
    out = out.replace(/([\u4e00-\u9fff])\.$/, "$1。");
    out = out.replace(/([\u4e00-\u9fff])\.(?=[\u201c\u201d（）《》，,；;！!？?]|$)/g, "$1。");
    if(out !== before) changes.push({rule:"中文句点转句号", was:before, now:out});

    // R4 中文行首尾多余空格（保护行首的 2 个全角缩进）
    before = out;
    var indentPrefix = "";
    var mIndent = out.match(/^(\u3000{1,2})/);
    if(mIndent){ indentPrefix = mIndent[1]; out = out.slice(indentPrefix.length); }
    out = out.replace(/^\s+/, "").replace(/\s+$/, "");
    if(indentPrefix && out !== "") out = indentPrefix + out;
    if(out !== before && out !== "") changes.push({rule:"去除行首尾空白", was:before, now:out});

    // R5 连续多个空格压成一个（中文行内，同样保护缩进前缀）
    before = out;
    indentPrefix = "";
    mIndent = out.match(/^(\u3000{1,2})/);
    if(mIndent){ indentPrefix = mIndent[1]; out = out.slice(indentPrefix.length); }
    out = out.replace(/[ \t\u3000]{2,}/g, " ");
    if(indentPrefix && out !== "") out = indentPrefix + out;
    if(out !== before) changes.push({rule:"压缩连续空格", was:before, now:out});

    // R6 重复标点（，， -> ，；。。 -> 。）
    before = out;
    out = out.replace(/([，。！？；：、])\1+/g, "$1");
    if(out !== before) changes.push({rule:"去除重复标点", was:before, now:out});

    // R7 全角空格夹在中文中间转普通空格（只处理行内，不碰行首缩进）
    before = out;
    indentPrefix = "";
    mIndent = out.match(/^(\u3000{1,2})/);
    if(mIndent){ indentPrefix = mIndent[1]; out = out.slice(indentPrefix.length); }
    out = out.replace(/([\u4e00-\u9fff]+)\u3000+([\u4e00-\u9fff]+)/g, "$1 $2");
    if(indentPrefix && out !== "") out = indentPrefix + out;
    if(out !== before) changes.push({rule:"全角空格转普通空格", was:before, now:out});

    // ② 还原被保护的片段（URL、路径、时间、版本号等）
    var restored = restoreSegments(out, prot.store);
    if(restored !== out){
      // 还原后内容变了，但这是必要的（占位符换回原文）
      out = restored;
    }

    return { text: out, changes: changes };
  }

  // 主入口：返回 {lines:[], changes:[], total:0}
  // opts.indent === false 时跳过首行缩进
  // 主入口
  // opts.indent      : 缩进字符数 0 / 1 / 2（默认 2）
  // opts.keepBlank   : true = 保留原有空行数；false = 合并成一个（默认 false）
  export function runFormat(text, opts){
    var opt = opts || {};
    var indentCount = (typeof opt.indent === "number") ? opt.indent : 2;
    var doIndent = indentCount > 0;
    var keepBlank = (opt.keepBlank === true);

    var lines = text.split("\n");
    var fences = findFenceRanges(lines);
    var result = [];
    var changes = [];

    for(var i=0;i<lines.length;i++){
      var raw = lines[i];
      var kind = classifyLine(raw);

      // 保护：代码块内、行尾的 \r 都原样保留
      if(inRanges(i, fences) || kind === "fence"){
        result.push(raw);
        continue;
      }

      if(kind === "text"){
        var r = formatTextLine(raw);
        for(var k=0;k<r.changes.length;k++){
          changes.push({
            line: i+1,
            rule: r.changes[k].rule,
            was:  r.changes[k].was,
            now:  r.changes[k].now
          });
        }
        result.push(r.text);
      }else{
        // 标题/列表/引用/表格/分割线：只去尾部空白，不动内容
        var t = raw.replace(/\s+$/, "");
        if(t !== raw){
          changes.push({line:i+1, rule:"去除行尾空白", was:raw, now:t, mark:kind});
        }
        result.push(t);
      }
    }

    // R8 空行处理
    var collapsed = [];
    var blankRun = 0;
    var mergedBlank = 0;
    if(keepBlank){
      // 保留原样，不做任何合并
      collapsed = result.slice();
    }else{
      for(var j=0;j<result.length;j++){
        var isBlank = result[j].trim() === "";
        if(isBlank){
          blankRun++;
          if(blankRun === 1) collapsed.push(result[j]);
          else mergedBlank++;
        }else{
          blankRun = 0;
          collapsed.push(result[j]);
        }
      }
      if(mergedBlank > 0){
        changes.push({
          line: 0,
          rule: "合并多余空行",
          was: "（共 " + mergedBlank + " 个多余空行）",
          now: "连续空行压缩为 1 个",
          bulk: true
        });
      }
    }

    // R9 首行缩进
    if(!doIndent){
      return { text: collapsed.join("\n"), lines: collapsed, changes: changes, indentCount: 0, mergedBlank: mergedBlank };
    }

    var INDENT = new Array(indentCount + 1).join("\u3000");   // 生成 indentCount 个全角空格
    var indented = [];
    var indentAdded = 0;

    for(var q=0;q<collapsed.length;q++){
      var lineText = collapsed[q];
      if(lineText.trim() === ""){ indented.push(lineText); continue; }

      // 代码块或围栏行：原样
      if(/^\s*```/.test(lineText)){ indented.push(lineText); continue; }

      var kindQ = classifyLine(lineText);
      if(kindQ !== "text"){
        indented.push(lineText);
        continue;
      }

      // 正文行：去掉原有行首缩进，再按目标数量加
      var body = lineText.replace(/^[\u3000 ]+/, "");
      if(body === ""){ indented.push(lineText); continue; }
      var newLine = INDENT + body;
      if(newLine !== lineText){ indentAdded++; }
      indented.push(newLine);
    }

    if(indentAdded > 0){
      changes.push({
        line: 0,
        rule: "首行缩进 " + indentCount + " 字符",
        was: "（共 " + indentAdded + " 个正文段落）",
        now: "已为这些段落行首添加 " + indentCount + " 个全角空格",
        bulk: true
      });
    }

    return {
      text: indented.join("\n"),
      lines: indented,
      changes: changes,
      indentCount: indentAdded,
      mergedBlank: mergedBlank
    };
  }

  /* ---------- 引号配对检测（只报告，不修改） ---------- */
  // 检测中文引号 “ ” 和 「 」 的配对情况
  // 注意：中文小说里经常有一句话跨段的情形，这里只做逐行配对的粗略检测
  export function checkQuotePairs(text){
    var out = [];
    var lines = text.split("\n");

    var inFence = false;

    for(var i=0;i<lines.length;i++){
      var line = lines[i];

      // 代码块内跳过
      if(/^\s*```/.test(line)){ inFence = !inFence; continue; }
      if(inFence) continue;

      // 跳过 Markdown 结构行
      if(/^(#{1,6}\s|>|\|)/.test(line.trim())) continue;

      var open1 = 0, close1 = 0;   // “ ”
      var open2 = 0, close2 = 0;   // 「 」

      for(var p=0;p<line.length;p++){
        var ch = line.charAt(p);
        // 粗略排除转义
        if(p > 0 && line.charAt(p-1) === "\\") continue;
        if(ch === "\u201c") open1++;
        else if(ch === "\u201d") close1++;
        else if(ch === "\u300c") open2++;
        else if(ch === "\u300d") close2++;
      }

      var problems = [];

      if(open1 !== close1){
        if(open1 > close1){
          problems.push("缺少右引号 ”（有 " + (open1 - close1) + " 个未闭合）");
        }else{
          problems.push("多余右引号 ”（多出 " + (close1 - open1) + " 个）");
        }
      }
      if(open2 !== close2){
        if(open2 > close2){
          problems.push("缺少右引号 」（有 " + (open2 - close2) + " 个未闭合）");
        }else{
          problems.push("多余右引号 」（多出 " + (close2 - open2) + " 个）");
        }
      }

      // 引号顺序错误：出现了 ” 但前面没有 “
      if(close1 > 0 && open1 === 0){
        problems.push("出现了右引号 ” 但没有对应的左引号 “");
      }
      if(close2 > 0 && open2 === 0){
        problems.push("出现了右引号 」 但没有对应的左引号 「");
      }

      if(problems.length > 0){
        var preview = line.trim();
        if(preview.length > 44) preview = preview.slice(0, 44) + "…";
        out.push({
          line: i + 1,
          text: preview + "　—　" + problems.join("；")
        });
      }

      if(out.length >= 20) break;
    }

    return out;
  }

