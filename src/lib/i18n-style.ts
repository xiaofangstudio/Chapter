import type { UiLanguage } from "../types";

/**
 * 四种“性格化中文”不是外语，也不是逐条词典：它们把每条已经写好的中文
 * 在运行时改写成猫腔、鲁迅腔、文言或倒字。这样新增文案不会因为漏翻而
 * 又冒出一段原样中文，也不会把按钮撑出一行。
 */
export type StyledLanguage = "cat" | "luxun" | "wenyan" | "upside";

const STYLED = new Set<UiLanguage>(["cat", "luxun", "wenyan", "upside"]);

export function isStyledLanguage(lang: UiLanguage): lang is StyledLanguage {
  return STYLED.has(lang);
}

/** 占位符要原样穿过改写，否则 {n} 会变成 }n{ 让 tf() 失效。 */
function outsidePlaceholders(text: string, fn: (part: string) => string): string {
  const parts = text.split(/(\{[a-zA-Z0-9_]+\})/g);
  return parts.map((part, index) => (index % 2 === 1 ? part : fn(part))).join("");
}

const CAT_EXACT: Record<string, string> = {
  "保存": "收好喵",
  "保存中": "收好中喵",
  "已保存": "已收好喵",
  "未保存": "还没收喵",
  "取消": "不要喵",
  "删除": "拍掉喵",
  "新建": "再生喵",
  "设置": "猫窝",
  "导出": "叼走喵",
  "确定": "喵定",
  "关闭": "躲好喵",
  "返回": "溜回喵",
  "继续": "接着喵",
  "继续写": "接着码喵",
  "写作": "码字喵",
  "搜索": "闻闻喵",
  "导入": "叼进来喵",
  "打开": "扒开喵",
  "首页": "猫窝",
  "书架": "鱼干架",
  "工作台": "猫窝台",
  "今天想写点什么": "铲屎官今天想码点啥喵",
  "今天想画点什么": "铲屎官今天想画点啥喵",
  "下午好，": "下午好呀，铲屎官",
  "上午好，": "上午好呀，铲屎官",
  "晚上好，": "晚上好呀，铲屎官",
  "字数": "小鱼干数",
  "章节": "小鱼干",
  "大纲": "猫抓板",
  "设定": "猫设",
  "关于": "关于本喵",
  "语言": "猫语",
  "主题": "毛色",
};

const CAT_REPLACE: Array<[RegExp, string]> = [
  [/我们/g, "咱喵"],
  [/我的/g, "本喵的"],
  [/你们/g, "铲屎官们"],
  [/你的/g, "铲屎官的"],
  [/自己/g, "本喵自己"],
  [/作者/g, "铲屎官"],
  [/角色/g, "猫角色"],
  [/你/g, "铲屎官"],
  [/我/g, "本喵"],
  [/他/g, "那只猫"],
  [/她/g, "那只猫"],
];

function catText(text: string): string {
  const raw = CAT_EXACT[text.trim()] ?? text;
  const out = outsidePlaceholders(raw, (part) => {
    if (!part.trim()) return part;
    let next = part;
    for (const [pattern, value] of CAT_REPLACE) next = next.replace(pattern, value);
    return next;
  });
  if (out.includes("喵")) return out;
  if (out.length <= 12) return `${out}喵`;
  return out.replace(/[。！？!?.]$/, "") + "，喵。";
}

const LUXUN_EXACT: Record<string, string> = {
  "保存": "存下罢",
  "保存中": "正在存",
  "已保存": "存好了",
  "未保存": "还没存",
  "取消": "罢了",
  "删除": "删去罢",
  "新建": "再造罢",
  "设置": "规矩",
  "导出": "抄出去",
  "确定": "如此罢",
  "关闭": "合上罢",
  "返回": "回去罢",
  "继续": "接着罢",
  "继续写": "接着写罢",
  "写作": "写罢",
  "搜索": "寻一寻",
  "导入": "搬进来",
  "打开": "揭开",
  "书架": "书架",
  "首页": "首页",
  "工作台": "案头",
  "字数": "字数",
  "章节": "章回",
  "大纲": "纲要",
  "设定": "设论",
  "关于": "关于",
  "语言": "言语",
  "主题": "题色",
  "今天想写点什么": "今日想写些甚么",
  "今天想画点什么": "今日想画些甚么",
};

const LUXUN_REPLACE: Array<[RegExp, string]> = [
  [/非常/g, "颇"],
  [/已经/g, "早已"],
  [/没有/g, "并无"],
  [/不是/g, "并非"],
  [/但是/g, "然而"],
  [/所以/g, "因此"],
  [/现在/g, "此刻"],
  [/觉得/g, "以为"],
  [/如果/g, "倘若"],
  [/因为/g, "因了"],
  [/还是/g, "仍旧"],
  [/什么/g, "甚么"],
  [/这里/g, "此地"],
  [/那里/g, "彼处"],
  [/一定/g, "大抵"],
  [/大概/g, "大约"],
];

function luxunText(text: string): string {
  return outsidePlaceholders(text, (part) => {
    if (!part.trim()) return part;
    let out = LUXUN_EXACT[part.trim()] ?? part;
    for (const [pattern, value] of LUXUN_REPLACE) out = out.replace(pattern, value);
    // 只在动词开头的小按钮上加“罢”，长句和名词一律不加，免得撑破一行。
    if (/^(存|删|造|设|抄|合|回|接|写|寻|搬|揭)/.test(out) && !/[罢。！？!?.]$/.test(out)) {
      out = out.length <= 8 ? `${out}罢` : out;
    }
    // 长句只在句末加一个“罢”，不另起一段，不增加整行长度。
    if (out.length > 12 && /[。！？]$/.test(out) && !/罢。$/.test(out)) {
      out = out.replace(/([。！？])$/, "罢$1");
    }
    return out;
  });
}

const WENYAN_EXACT: Record<string, string> = {
  "保存": "存之",
  "保存中": "正在存",
  "已保存": "已存",
  "未保存": "未存",
  "取消": "罢",
  "删除": "删之",
  "新建": "新造",
  "设置": "设",
  "导出": "出之",
  "确定": "定",
  "关闭": "合",
  "返回": "归",
  "继续": "续",
  "继续写": "续写",
  "写作": "撰",
  "搜索": "寻",
  "导入": "纳之",
  "打开": "启",
  "首页": "首",
  "书架": "书阁",
  "工作台": "案",
  "字数": "字数",
  "章节": "章",
  "大纲": "纲",
  "设定": "设",
  "关于": "关于",
  "语言": "语",
  "主题": "题",
  "今天想写点什么": "今日欲书何物",
  "今天想画点什么": "今日欲画何物",
};

const WENYAN_REPLACE: Array<[RegExp, string]> = [
  [/我们/g, "吾辈"],
  [/你们/g, "君等"],
  [/你的/g, "君之"],
  [/我的/g, "吾之"],
  [/自己/g, "己"],
  [/现在/g, "今"],
  [/今天/g, "今日"],
  [/已经/g, "既"],
  [/没有/g, "无"],
  [/不是/g, "非"],
  [/不能/g, "不可"],
  [/可以/g, "可"],
  [/这个/g, "此"],
  [/那个/g, "彼"],
  [/什么/g, "何"],
  [/怎么/g, "如何"],
  [/为什么/g, "何故"],
  [/如果/g, "若"],
  [/但是/g, "然"],
  [/所以/g, "故"],
  [/还是/g, "仍"],
  [/解释/g, "释"],
  [/动机/g, "心机"],
  [/行为/g, "行止"],
  [/写作/g, "撰述"],
  [/只/g, "惟"],
  [/一个/g, "一"],
  [/你/g, "君"],
  [/我/g, "吾"],
  [/的/g, "之"],
  [/了吗/g, "乎"],
  [/吗/g, "乎"],
  [/呢/g, "哉"],
  [/吧/g, "也"],
  [/不/g, "弗"],
  [/写/g, "书"],
  [/了/g, "矣"],
];

function wenyanText(text: string): string {
  return outsidePlaceholders(text, (part) => {
    if (!part.trim()) return part;
    const exact = WENYAN_EXACT[part.trim()];
    let out = exact ?? part;
    if (!exact) {
      for (const [pattern, value] of WENYAN_REPLACE) out = out.replace(pattern, value);
    }
    return out;
  });
}

function upsideText(text: string): string {
  return outsidePlaceholders(text, (part) =>
    part
      .split("\n")
      .map((line) => Array.from(line).reverse().join(""))
      .join("\n"),
  );
}

export function styleText(lang: StyledLanguage, text: string): string {
  if (!text) return text;
  if (lang === "cat") return catText(text);
  if (lang === "luxun") return luxunText(text);
  if (lang === "wenyan") return wenyanText(text);
  return upsideText(text);
}
