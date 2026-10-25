/* ============================================================
   导出 Word（生成 Word 兼容的 HTML）
   ============================================================ */

function esc(s){
  return String(s == null ? "" : s)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");
}
function inlineMd(s){
    var out = esc(s);
    // 行内代码 `code`
    out = out.replace(/`([^`]+)`/g, function(m, t){
      return '<span style="font-family:Consolas,monospace;background:#f0f0f0;">' + t + '</span>';
    });
    // 粗体 **x** 或 __x__
    out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    out = out.replace(/__([^_]+)__/g, "<b>$1</b>");
    // 斜体 *x* （避开已处理的粗体）
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
    return out;
  }

  // 整篇 Markdown -> 正文 HTML（用于 .doc）
  // 说明：.doc 是 Word 兼容 HTML，用 ::first-line 做缩进不可靠，
  //       所以缩进直接用插入的全角空格呈现（正文里本来就有）
  function mdToWordHtml(md){
    var lines = md.split("\n");
    var html = [];
    var inFence = false;
    var fenceBuf = [];
    var inList = false;
    var listTag = "ul";

    function closeList(){
      if(inList){ html.push("</" + listTag + ">"); inList = false; }
    }

    for(var i=0;i<lines.length;i++){
      var raw = lines[i];
      var t = raw.replace(/\s+$/, "");
      var trimmed = t.trim();

      // 代码块
      if(/^```/.test(trimmed)){
        if(!inFence){
          inFence = true; fenceBuf = [];
        }else{
          inFence = false;
          html.push('<p class="codeblock">' + esc(fenceBuf.join("\n")).replace(/\n/g,"<br>") + '</p>');
        }
        continue;
      }
      if(inFence){ fenceBuf.push(raw); continue; }

      if(trimmed === ""){ closeList(); continue; }

      // 标题
      var mh = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if(mh){
        closeList();
        var lv = mh[1].length;
        var txt = inlineMd(mh[2]);
        var sz = [22,19,17,16,15,14][lv-1];
        html.push('<p style="font-size:' + sz + 'pt;font-weight:bold;margin:16pt 0 10pt 0;">' + txt + '</p>');
        continue;
      }

      // 分割线
      if(/^([-*_])\s*(\1\s*){2,}$/.test(trimmed)){
        closeList();
        html.push('<p style="border-bottom:1px solid #999;margin:10pt 0;"></p>');
        continue;
      }

      // 引用
      if(/^>/.test(trimmed)){
        closeList();
        var qt = inlineMd(trimmed.replace(/^>\s?/, ""));
        html.push('<p style="margin:6pt 0 6pt 24pt;padding-left:10pt;border-left:3px solid #bbb;color:#444;">' + qt + '</p>');
        continue;
      }

      // 列表
      var ml = trimmed.match(/^([-*+])\s+(.*)$/);
      if(ml){
        if(!inList){ listTag = "ul"; html.push("<ul>"); inList = true; }
        html.push("<li>" + inlineMd(ml[2]) + "</li>");
        continue;
      }
      var mo = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
      if(mo){
        if(!inList){ listTag = "ol"; html.push("<ol>"); inList = true; }
        html.push("<li>" + inlineMd(mo[2]) + "</li>");
        continue;
      }
      closeList();

      // 普通段落：保留行首已有的全角空格作为缩进
      html.push('<p class="para">' + inlineMd(t) + '</p>');
    }

    closeList();
    if(inFence && fenceBuf.length){
      html.push('<p class="codeblock">' + esc(fenceBuf.join("\n")).replace(/\n/g,"<br>") + '</p>');
    }
    return html.join("\n");
  }

  // 组装完整 .doc（Word 兼容 HTML）
  export function buildDocFile(md, title){
    var body = mdToWordHtml(md);
    return '<html xmlns:o="urn:schemas-microsoft-com:office:office" ' +
           'xmlns:w="urn:schemas-microsoft-com:office:word" ' +
           'xmlns="http://www.w3.org/TR/REC-html40">\n' +
           '<head><meta charset="utf-8">\n' +
           '<title>' + esc(title || "文档") + '</title>\n' +
           '<!--[if gte mso 9]><xml><w:WordDocument>' +
           '<w:View>Print</w:View><w:Zoom>100</w:Zoom>' +
           '</w:WordDocument></xml><![endif]-->\n' +
           '<style>\n' +
           '@page{ size:A4; margin:2.54cm 3.17cm; }\n' +
           'body{ font-family:"宋体",SimSun,serif; font-size:12pt; line-height:1.75; color:#000; }\n' +
           'p.para{ margin:0 0 6pt 0; text-indent:0; }\n' +
           'p.codeblock{ font-family:Consolas,monospace; font-size:10pt; background:#f5f5f5; padding:6pt; }\n' +
           'ul,ol{ margin:6pt 0 6pt 24pt; }\n' +
           'li{ margin:3pt 0; }\n' +
           '</style></head><body>\n' +
           body + '\n</body></html>';
  }

  // 导出为 .doc，下载
  