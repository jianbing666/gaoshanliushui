# 高山流水 (gaoshanliushui)

> 一款轻量、优雅、纯粹的本地音乐播放器。

高山流水是一款基于 **Tauri v2 + Vue 3** 的本地音乐播放器。它只播放你本机的 MP3 / MP4，所有数据（歌曲索引、歌单、回忆、播放历史）都保存在本地，不登录、不上云、不做算法推荐。当前版本 **v1.3.0**。

## 核心特性

- **本地曲库**：两阶段扫描 + 后台 ID3 解析，支持大曲库（5000 首量级）与虚拟列表。
- **纯粹播放**：Web Audio API 播放链路（AudioBufferSourceNode），双层音频架构兼顾元数据与频谱可视化。
- **虚拟歌单 / 回忆 / 播放历史**：SQLite 单文件持久化，支持歌单导入导出与播放统计。
- **系统集成**：系统托盘、全局快捷键、迷你模式、MediaSession / Windows SMTC 媒体键。
- **可选扩展**：B 站音乐下载、实时响度均衡与批量归一化。
- **轻量隐私**：数据从不离开本机，无社交、无广告、无会员。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面壳 | Tauri v2（Rust） |
| 前端 | Vue 3 + Composition API + TypeScript |
| 构建 | Vite 6 |
| 状态 | Pinia（按领域拆分 store） |
| 样式 | Tailwind CSS 3.4 |
| 音频 | Web Audio API + HTML5 Audio（元数据） |
| 数据库 | SQLite（rusqlite，单文件） |
| 持久化 | LocalStorage（设置类轻量配置） |

## 文档导航

完整文档索引见 [markdown/README.md](markdown/README.md)。

| 分类 | 文档 |
| --- | --- |
| 介绍 | [项目介绍](markdown/介绍/项目介绍.md) |
| 方案 | [优化方案](markdown/方案/优化方案.md) |
| 性能 | [综合性能评估报告](markdown/性能/综合性能评估报告.md) |
| 汇报 | [动画流畅度优化汇报](markdown/汇报/动画流畅度优化汇报.md) |
| 调研 | [竞品分析与创新点](markdown/调研/竞品分析与创新点.md) |
| 杂项 | [控制台信息](markdown/杂项/控制台信息.md) |

## 快速开始

```bash
# 安装依赖
npm install

# 仅前端开发（浏览器预览）
npm run dev

# Tauri 桌面开发（HMR + 原生能力）
npm run tauri dev

# 前端类型检查 / 单测 / Lint
npm run typecheck
npm test
npm run lint

# 完整打包（生成 NSIS 安装包）
npm run tauri build
```

打包产物位于 `src-tauri/target/release/bundle/nsis/`。

## 目录结构

```text
src/                前端源码（stores / audio / components / composables）
src-tauri/          Rust 后端（commands / models / main.rs）
markdown/           项目文档（按 介绍/方案/性能/汇报/调研/杂项 分类）
scripts/            辅助脚本
```

## 许可

MIT
