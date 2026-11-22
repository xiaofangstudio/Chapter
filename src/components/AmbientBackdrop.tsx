/**
 * 全局背景：书架 / 介绍页 / 写作页共用的同一层 DOM。
 *
 * 这里刻意不按页面复制背景图，而是只挂一次，用 `scene` 改变光斑与金色丝线的
 * 位置。场景切换时是同一批节点做位移和缩放，不会重新加载第二份素材。
 */
export type AmbienceScene = "shelf" | "intro" | "write";

interface Props {
  scene: AmbienceScene;
}

export function AmbientBackdrop({ scene }: Props) {
  return (
    <div className={`ambient scene-${scene}`} aria-hidden="true">
      <span className="ambient-glow glow-a" />
      <span className="ambient-glow glow-b" />
      <span className="ambient-flow" />
      <span className="spot-glow" />

      <svg
        className="ambient-silk"
        viewBox="0 0 1440 900"
        preserveAspectRatio="xMidYMid slice"
        focusable="false"
      >
        <defs>
          {/* 几何只定义一次，光晕与细线都 use 同一组路径。 */}
          <path
            id="silk-a"
            d="M -120 690 C 150 552 350 590 610 462 C 830 356 1000 260 1178 302 C 1320 338 1420 414 1570 386"
          />
          <path
            id="silk-b"
            d="M -90 792 C 232 724 430 758 698 636 C 952 522 1134 416 1332 456 C 1430 476 1508 516 1570 500"
          />
          <path
            id="silk-c"
            d="M -70 238 C 196 190 358 256 518 372 C 708 510 838 676 1074 708 C 1248 732 1396 646 1546 556"
          />
          <path
            id="silk-d"
            d="M 928 -60 C 982 108 1082 202 1182 298 C 1282 394 1340 506 1548 586 C 1590 602 1618 614 1642 618"
          />
          <path
            id="silk-e"
            d="M -100 560 C 180 468 330 520 602 398 C 862 282 1044 206 1264 248 C 1394 272 1494 328 1604 298"
          />
          <path
            id="silk-f"
            d="M -100 608 C 190 516 336 568 612 444 C 872 330 1052 252 1272 294 C 1402 318 1502 374 1608 344"
          />
          <path
            id="silk-g"
            d="M 244 -60 C 302 116 392 258 562 350 C 734 442 866 540 1016 694 C 1128 810 1272 872 1468 846"
          />
          <path
            id="silk-h"
            d="M 108 904 C 300 806 470 782 642 702 C 812 622 932 550 1082 520 C 1232 490 1382 538 1562 468"
          />
          <linearGradient id="gold-silk" x1="0" y1="0" x2="1" y2="0.35">
            <stop offset="0" stopColor="#8a5a22" stopOpacity="0.12" />
            <stop offset="0.18" stopColor="#b37d33" stopOpacity="0.62" />
            <stop offset="0.42" stopColor="#e7bd76" stopOpacity="0.9" />
            <stop offset="0.58" stopColor="#fff0c9" stopOpacity="0.98" />
            <stop offset="0.78" stopColor="#c08a3d" stopOpacity="0.72" />
            <stop offset="1" stopColor="#8a5a22" stopOpacity="0.12" />
          </linearGradient>
          <linearGradient id="gold-thin" x1="0" y1="0" x2="1" y2="0.3">
            <stop offset="0" stopColor="#9a6a2b" stopOpacity="0.16" />
            <stop offset="0.28" stopColor="#d9a95a" stopOpacity="0.7" />
            <stop offset="0.52" stopColor="#fff4d6" stopOpacity="0.94" />
            <stop offset="0.74" stopColor="#d5a14e" stopOpacity="0.66" />
            <stop offset="1" stopColor="#9a6a2b" stopOpacity="0.14" />
          </linearGradient>
        </defs>

        <g className="silk-shift" fill="none">
          <g className="silk-breathe" fill="none">
            <g className="silk-halo" fill="none">
              <use href="#silk-a" stroke="url(#gold-silk)" strokeWidth="4.6" />
              <use href="#silk-b" stroke="url(#gold-silk)" strokeWidth="4" />
              <use href="#silk-c" stroke="url(#gold-silk)" strokeWidth="4" />
              <use href="#silk-d" stroke="url(#gold-silk)" strokeWidth="3.4" />
              <use href="#silk-e" stroke="url(#gold-silk)" strokeWidth="3.6" />
              <use href="#silk-f" stroke="url(#gold-silk)" strokeWidth="3.2" />
              <use href="#silk-g" stroke="url(#gold-silk)" strokeWidth="3" />
              <use href="#silk-h" stroke="url(#gold-silk)" strokeWidth="2.8" />
            </g>
            <g className="silk-core">
              <use href="#silk-a" stroke="url(#gold-thin)" strokeWidth="0.95" />
              <use href="#silk-b" stroke="url(#gold-thin)" strokeWidth="0.82" />
              <use href="#silk-c" stroke="url(#gold-thin)" strokeWidth="0.8" />
              <use href="#silk-d" stroke="url(#gold-thin)" strokeWidth="0.72" />
              <use href="#silk-e" stroke="url(#gold-thin)" strokeWidth="0.78" />
              <use href="#silk-f" stroke="url(#gold-thin)" strokeWidth="0.68" />
              <use href="#silk-g" stroke="url(#gold-thin)" strokeWidth="0.64" />
              <use href="#silk-h" stroke="url(#gold-thin)" strokeWidth="0.6" />
            </g>
          </g>
        </g>
      </svg>

      <span className="ambient-grain" />
    </div>
  );
}
