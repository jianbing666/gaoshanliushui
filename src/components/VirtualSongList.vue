<script setup lang="ts">
/**
 * 阶段 2.1: 统一虚拟列表组件
 * 包装 RecycleScroller，用于大列表渲染（>200 项）
 * - 5000 首歌仅渲染可视区 ~20 个 DOM 节点
 * - 固定行高模式（itemSize），避免动态测量开销
 * - 通过默认插槽完全控制行渲染（保持 SongItem 原状）
 */
import { RecycleScroller } from 'vue-virtual-scroller'
import type { Song } from '@/types/song'

const props = withDefaults(
  defineProps<{
    songs: Song[]
    /** 非 compact 模式行高（默认 56px 适配 SongItem h-14） */
    itemSize?: number
    /** compact 模式行高（默认 36px 适配 SongItem compact 模式） */
    compactSize?: number
    compact?: boolean
    playlistId?: string | null
  }>(),
  {
    itemSize: 56,
    compactSize: 36,
    compact: false,
    playlistId: null,
  }
)

const emit = defineEmits<{
  /** 透传 SongItem 的 play 事件（参数：全局索引 index） */
  play: [index: number]
}>()

// 实际行高（compact 走 compactSize，否则走 itemSize）
const rowSize = props.compact ? props.compactSize : props.itemSize

function handlePlay(index: number) {
  emit('play', index)
}
</script>

<template>
  <RecycleScroller
    :items="props.songs"
    :item-size="rowSize"
    key-field="id"
    class="virtual-song-list"
    :buffer="200"
  >
    <template #default="{ item, index }">
      <div class="virtual-song-list__row" :style="{ height: `${rowSize}px` }">
        <slot
          :song="item as Song"
          :index="index"
          :compact="props.compact"
          :playlist-id="props.playlistId"
          :on-play="handlePlay"
          :fill-height="true"
        />
      </div>
    </template>
  </RecycleScroller>
</template>

<style scoped>
.virtual-song-list {
  width: 100%;
  height: 100%;
}

.virtual-song-list__row {
  display: flex;
  align-items: center;
  width: 100%;
  height: 100%;
  padding: 0;
  overflow: hidden;
}
</style>
