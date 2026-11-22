export type CoverArt =
  | "mountains"
  | "orbs"
  | "arcs"
  | "circle"
  | "frame"
  | "petals"
  | "leaves"
  | "bird"
  | "city"
  | "planets"
  | "lines";

export interface CoverTemplate {
  id: string;
  name: string;
  from: string;
  to: string;
  ink: string;
  accent: string;
  spine: string;
  art: CoverArt;
  /** 作者名放在封面右下角的竖排位置，更接近中文小说封面。 */
  authorSide?: boolean;
}

/**
 * 默认封面库。所有模板都由 CSS 绘制，不依赖网络图片，
 * 因此换封面、打开切书页都不会额外加载大图。
 */
export const COVER_TEMPLATES: CoverTemplate[] = [
  {
    id: "ink",
    name: "水墨",
    from: "#f4f1e9",
    to: "#d9d6cd",
    ink: "#3e4a4a",
    accent: "#7f918e",
    spine: "#5d6a66",
    art: "mountains",
    authorSide: true,
  },
  {
    id: "celadon",
    name: "青瓷",
    from: "#f3f2eb",
    to: "#dfe8e3",
    ink: "#315d56",
    accent: "#4d7b70",
    spine: "#3f6a60",
    art: "orbs",
    authorSide: true,
  },
  {
    id: "sand",
    name: "沙金",
    from: "#ddc8a4",
    to: "#bfa077",
    ink: "#634722",
    accent: "#a97834",
    spine: "#8a663a",
    art: "arcs",
    authorSide: true,
  },
  {
    id: "paper",
    name: "素白",
    from: "#faf7f0",
    to: "#eee6d9",
    ink: "#32322e",
    accent: "#d97b2d",
    spine: "#d8c9b3",
    art: "circle",
  },
  {
    id: "wheat",
    name: "麦田",
    from: "#e7d5b8",
    to: "#c9a97d",
    ink: "#4a3925",
    accent: "#c96b20",
    spine: "#9f7d50",
    art: "frame",
    authorSide: true,
  },
  {
    id: "sakura",
    name: "樱粉",
    from: "#faedf0",
    to: "#f2c7d1",
    ink: "#8b3d4b",
    accent: "#d56b82",
    spine: "#d69aa6",
    art: "petals",
    authorSide: true,
  },
  {
    id: "rouge",
    name: "胭脂",
    from: "#a85358",
    to: "#6f2a31",
    ink: "#f7e3de",
    accent: "#e7a49e",
    spine: "#7d3038",
    art: "petals",
  },
  {
    id: "olive",
    name: "橄榄",
    from: "#a1a25c",
    to: "#727840",
    ink: "#f4eed7",
    accent: "#ddc470",
    spine: "#7c8144",
    art: "leaves",
    authorSide: true,
  },
  {
    id: "forest",
    name: "墨绿",
    from: "#245446",
    to: "#12382f",
    ink: "#efe7d3",
    accent: "#d9b86d",
    spine: "#1c493b",
    art: "leaves",
    authorSide: true,
  },
  {
    id: "mist",
    name: "雾山",
    from: "#e8e1d2",
    to: "#d2d8d1",
    ink: "#4c5b56",
    accent: "#98a6a0",
    spine: "#b9b3a4",
    art: "bird",
    authorSide: true,
  },
  {
    id: "wave",
    name: "青蓝",
    from: "#4f8c93",
    to: "#2f606b",
    ink: "#eff4ef",
    accent: "#d7d0a9",
    spine: "#3d747c",
    art: "mountains",
    authorSide: true,
  },
  {
    id: "city",
    name: "雾城",
    from: "#60747a",
    to: "#354a50",
    ink: "#f0e9dd",
    accent: "#c9b58e",
    spine: "#4a5d62",
    art: "city",
    authorSide: true,
  },
  {
    id: "space",
    name: "星轨",
    from: "#122036",
    to: "#09101e",
    ink: "#e8edf5",
    accent: "#80b2db",
    spine: "#17243a",
    art: "planets",
    authorSide: true,
  },
  {
    id: "violet",
    name: "紫夜",
    from: "#3c2549",
    to: "#241430",
    ink: "#f5ebf4",
    accent: "#d08fca",
    spine: "#362044",
    art: "planets",
    authorSide: true,
  },
  {
    id: "noir",
    name: "黑金",
    from: "#1d1b18",
    to: "#0c0b0a",
    ink: "#ead7ad",
    accent: "#c9a76a",
    spine: "#151311",
    art: "lines",
  },
  {
    id: "ember",
    name: "暖金",
    from: "#e9aa65",
    to: "#c76a20",
    ink: "#fff8ec",
    accent: "#ffe2ab",
    spine: "#a8581d",
    art: "arcs",
  },
];

const BY_ID = new Map(COVER_TEMPLATES.map((item) => [item.id, item]));

function hashOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 9973;
  return h;
}

/** 指定模板优先；没有指定时按书名稳定挑一个，旧书也不会全是同一种橙色。 */
export function resolveCoverTemplate(id?: string | null, seed = ""): CoverTemplate {
  const chosen = id ? BY_ID.get(id) : undefined;
  if (chosen) return chosen;
  return COVER_TEMPLATES[hashOf(seed || "chapter") % COVER_TEMPLATES.length];
}

export function coverTemplateName(id?: string | null, seed = ""): string {
  return resolveCoverTemplate(id, seed).name;
}
