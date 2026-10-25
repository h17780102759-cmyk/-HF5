/* ============================================================
   错别字检测（自旧版迁移，纯字符串处理）
   ============================================================ */

import { TYPO_MAP } from "./data.js";
/* ---------- 错别字检测 ---------- */

  // 高置信词表：错词 -> 正确词
  // 只收录"基本没有歧义"的搭配，宁可少收录
  ;

  // 高置信「的/地/得」规则：结构清晰才报
  // 返回 [{index, wrong, right, reason}]
  function checkDeDiDe(text){
    var hits = [];
    var rules = [
      // 动词/形容词 + 的 + 副词（"跑的快""来的及时"）
      {re:/(跑|走|做|吃|说|看|写|想|玩|睡|飞|流|跳|叫|笑|哭|喊|读|唱|画|站|坐|躺|爬|游)的(快|慢|好|早|晚|远|近|多|少|高|低|清楚|明白|及时|准确|认真|仔细|干净|整齐|漂亮|厉害)/g,
       rep:"$1得$2", reason:"动词后接程度补语，应用「得」"},
      // 形容词 + 的 + 动词（"高兴的笑了""认真的工作"）
      {re:/(高兴|快乐|激动|兴奋|认真|仔细|努力|耐心|温柔|愤怒|悲伤|难过|平静|平静|热情|着急|紧张|小心|安静)的(笑|说|看|想|做|走|回答|问道|点头|摇头|望着|看着|听着|坐着|站着|望着)/g,
       rep:"$1地$2", reason:"状语修饰动词，应用「地」"},
      // 动词 + 地 + 名词结果（"看的出来"错 → 得）
      {re:/(看|听|吃|喝|做|写|画|说|跑|走)的(出来|进去|过来|下去|起来|下来)/g,
       rep:"$1得$2", reason:"动词后接趋向补语，应用「得」"}
    ];
    for(var r=0;r<rules.length;r++){
      var rule = rules[r];
      var m;
      var re = new RegExp(rule.re.source, "g");
      while((m = re.exec(text)) !== null){
        hits.push({
          start: m.index,
          len:   m[0].length,
          wrong: m[0],
          right: m[0].replace(rule.re, rule.rep),
          reason: rule.reason
        });
        if(m.index === re.lastIndex) re.lastIndex++;  // 防死循环
      }
    }
    return hits;
  }

  // 检测重复字词（"的的""了了"等）
  function checkRepeats(text){
    var hits = [];
    // 只查这些虚词/常见字的连续重复，避免误伤"人人""年年"这类正常叠词
    var re = /(的的|了了|是是|在在|和和|与与|就就|都都|也也|很很|我我|他他|你你|这这|那那|个个|把把|被被|从从|向向|对对)/g;
    var m;
    while((m = re.exec(text)) !== null){
      hits.push({
        start: m.index,
        len: 2,
        wrong: m[0],
        right: m[0].charAt(0),
        reason: "疑似重复输入"
      });
      if(m.index === re.lastIndex) re.lastIndex++;
    }
    return hits;
  }

  // 主检测：返回按位置排序的命中列表
  export function detectTypos(text){
    var hits = [];

    // ① 词表匹配（长词优先）
    var keys = Object.keys(TYPO_MAP).filter(function(k){
      return TYPO_MAP[k] && TYPO_MAP[k] !== k && k.length >= 2;
    });
    keys.sort(function(a,b){ return b.length - a.length; });

    var taken = {};  // 已占用的位置区间，避免重叠重复报
    for(var i=0;i<keys.length;i++){
      var wrong = keys[i];
      var right = TYPO_MAP[wrong];
      var idx = 0;
      while((idx = text.indexOf(wrong, idx)) !== -1){
        var overlap = false;
        for(var p=idx; p<idx+wrong.length; p++){
          if(taken[p]){ overlap = true; break; }
        }
        if(!overlap){
          for(var p2=idx; p2<idx+wrong.length; p2++) taken[p2] = true;
          hits.push({
            start: idx, len: wrong.length,
            wrong: wrong, right: right,
            reason: "常见错别字"
          });
        }
        idx += wrong.length;
      }
    }

    // ② 的地得
    var dedis = checkDeDiDe(text);
    for(var d=0;d<dedis.length;d++){
      var dd = dedis[d];
      var ov = false;
      for(var q=dd.start; q<dd.start+dd.len; q++){ if(taken[q]){ ov = true; break; } }
      if(!ov){
        for(var q2=dd.start; q2<dd.start+dd.len; q2++) taken[q2] = true;
        hits.push(dd);
      }
    }

    // ③ 重复字
    var reps = checkRepeats(text);
    for(var rr=0;rr<reps.length;rr++){
      var rp = reps[rr];
      var ov2 = false;
      for(var q3=rp.start; q3<rp.start+rp.len; q3++){ if(taken[q3]){ ov2 = true; break; } }
      if(!ov2){
        for(var q4=rp.start; q4<rp.start+rp.len; q4++) taken[q4] = true;
        hits.push(rp);
      }
    }

    hits.sort(function(a,b){ return a.start - b.start; });
    return hits;
  }

  // 把命中位置换算成行号
  export function lineOfIndex(text, index){
    var line = 1;
    for(var i=0;i<index && i<text.length;i++){
      if(text.charAt(i) === "\n") line++;
    }
    return line;
  }

  