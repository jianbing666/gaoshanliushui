/**
 * 图标路径表(P2: 图标组件合并)
 *
 * 背景: 原先 30 个 SFC 各自带一份 defineProps + render 函数, 每个都有几百字节样板;
 * 主入口里光图标组件就占十几 KB。这里把"纯静态 SVG 内容"收敛成一张表,
 * 由统一的 Icon.vue 渲染, 样板只剩一份。
 *
 * 注意: html 字段直接进 v-html, 只接受静态字面量, 不要拼接用户输入。
 */
export interface IconDefinition {
  /** 未显式传 size 时的默认像素尺寸 */
  size: number
  /** svg 内部静态标记 */
  html: string
  /** svg 视野 */
  viewBox: string
}

export const ICONS = {
  'arrow-right': {
    size: 18,
    viewBox: '0 0 24 24',
    html: '<line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />',
  },
  'bar-chart3': {
    size: 24,
    viewBox: '0 0 24 24',
    html: '<path d="M3 3v18h18" /><path d="M7 14l4-4 4 4 5-5" />',
  },
  check: { size: 16, viewBox: '0 0 24 24', html: '<polyline points="20 6 9 17 4 12" />' },
  'chevron-down': { size: 16, viewBox: '0 0 24 24', html: '<polyline points="6 9 12 15 18 9" />' },
  'chevron-left': { size: 16, viewBox: '0 0 24 24', html: '<polyline points="15 18 9 12 15 6" />' },
  'chevron-right': { size: 16, viewBox: '0 0 24 24', html: '<polyline points="9 18 15 12 9 6" />' },
  download: {
    size: 16,
    viewBox: '0 0 24 24',
    html: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />',
  },
  equalizer: {
    size: 24,
    viewBox: '0 0 24 24',
    html: '<path d="M3 12h2l2-5 2 10 2-8 2 6 2-3 2 5 2-4 2 2h2" />',
  },
  folder: {
    size: 16,
    viewBox: '0 0 24 24',
    html: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />',
  },
  history: {
    size: 20,
    viewBox: '0 0 24 24',
    html: '<path d="M12 8v4l3 3"></path><circle cx="12" cy="12" r="10"></circle>',
  },
  image: {
    size: 18,
    viewBox: '0 0 24 24',
    html: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />',
  },
  maximize2: {
    size: 18,
    viewBox: '0 0 24 24',
    html: '<polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />',
  },
  memory: {
    size: 18,
    viewBox: '0 0 24 24',
    html: '<!-- 笔记本主体 --><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /><!-- 笔记横线 --><line x1="9" y1="7" x2="15" y2="7" /><line x1="9" y1="11" x2="15" y2="11" /><line x1="9" y1="15" x2="13" y2="15" />',
  },
  minimize2: {
    size: 18,
    viewBox: '0 0 24 24',
    html: '<polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" />',
  },
  minimize: {
    size: 18,
    viewBox: '0 0 24 24',
    html: '<path d="M12 2a10 10 0 1 0 10 10H12V2z" /><path d="M12 2a10 10 0 0 1 10 10h-10V2z" fill="currentColor" fill-opacity="0.3" />',
  },
  'more-horizontal': {
    size: 16,
    viewBox: '0 0 24 24',
    html: '<circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" />',
  },
  music: {
    size: 16,
    viewBox: '0 0 24 24',
    html: '<path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />',
  },
  pause: {
    size: 20,
    viewBox: '0 0 24 24',
    html: '<rect x="6" y="4" width="4" height="16" fill="currentColor" /><rect x="14" y="4" width="4" height="16" fill="currentColor" />',
  },
  pencil: {
    size: 16,
    viewBox: '0 0 24 24',
    html: '<path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />',
  },
  play: {
    size: 20,
    viewBox: '0 0 24 24',
    html: '<polygon points="5 3 19 12 5 21 5 3" fill="currentColor" />',
  },
  plus: {
    size: 16,
    viewBox: '0 0 24 24',
    html: '<line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />',
  },
  repeat: {
    size: 18,
    viewBox: '0 0 24 24',
    html: '<path d="M17 2.1l4 4-4 4" /><path d="M3 11.5V6a2 2 0 0 1 2-2h11.5" /><path d="M7 21.9l-4-4 4-4" /><path d="M21 12.5V18a2 2 0 0 1-2 2H7.5" />',
  },
  'repeat-one': {
    size: 18,
    viewBox: '0 0 24 24',
    html: '<path d="M17 2.1l4 4-4 4" /><path d="M3 11.5V6a2 2 0 0 1 2-2h11.5" /><path d="M7 21.9l-4-4 4-4" /><path d="M21 12.5V18a2 2 0 0 1-2 2H7.5" /><text x="12" y="16" text-anchor="middle" font-size="8" font-weight="bold" fill="currentColor" stroke="none">1</text>',
  },
  'rotate-ccw': {
    size: 16,
    viewBox: '0 0 24 24',
    html: '<polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />',
  },
  settings: {
    size: 18,
    viewBox: '0 0 24 24',
    html: '<circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v1a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  },
  shuffle: {
    size: 24,
    viewBox: '0 0 24 24',
    html: '<path d="M16 3h5v5" /><path d="M4 20 21 3" /><path d="M21 16v5h-5" /><path d="m15 15 6 6" /><path d="M4 4l5 5" />',
  },
  'skip-back': {
    size: 20,
    viewBox: '0 0 24 24',
    html: '<polygon points="19 20 9 12 19 4 19 20" fill="currentColor" /><line x1="5" y1="19" x2="5" y2="5" />',
  },
  'skip-forward': {
    size: 20,
    viewBox: '0 0 24 24',
    html: '<polygon points="5 4 15 12 5 20 5 4" fill="currentColor" /><line x1="19" y1="5" x2="19" y2="19" />',
  },
  trash: {
    size: 16,
    viewBox: '0 0 24 24',
    html: '<polyline points="3 6 5 6 21 6" /><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />',
  },
  x: {
    size: 16,
    viewBox: '0 0 24 24',
    html: '<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />',
  },
} as const satisfies Record<string, IconDefinition>

export type IconName = keyof typeof ICONS
